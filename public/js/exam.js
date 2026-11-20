'use strict';

(() => {
  // ============================================================
  // APPLICATION STATE
  // ============================================================
  const state = {
    selectedSlot: null,
    tests: [],
    attemptId: null,
    slot: null,
    candidateName: '',
    questions: [],
    answers: {}, // { "1": true | false }
    currentIndex: 0,
    remainingSeconds: 1200,
    timerInterval: null,
    devtoolsInterval: null,
    examActive: false,
    submitting: false,
    violationsCount: 0,
    maxViolations: 2,
    lastViolationTs: 0,
    lastShortcutLogTs: 0,
    fullscreenExitExpected: false,
    fullscreenRequired: true,
  };

  // ============================================================
  // DOM ELEMENTS
  // ============================================================
  const screens = {
    start: document.getElementById('screen-start'),
    exam: document.getElementById('screen-exam'),
    result: document.getElementById('screen-result'),
  };

  const el = {
    startForm: document.getElementById('start-form'),
    candidateInput: document.getElementById('candidate-name'),
    testSelector: document.getElementById('test-selector'),
    startError: document.getElementById('start-error'),
    btnStartExam: document.getElementById('btn-start-exam'),

    examSheetLabel: document.getElementById('exam-sheet-label'),
    examCandidateLabel: document.getElementById('exam-candidate-label'),
    timerBox: document.getElementById('timer-box'),
    timerDisplay: document.getElementById('timer-display'),
    answeredCounter: document.getElementById('answered-counter'),
    violationsBox: document.getElementById('violations-box'),
    violationsCounter: document.getElementById('violations-counter'),
    btnOpenSubmit: document.getElementById('btn-open-submit'),
    navGrid: document.getElementById('question-nav-grid'),

    questionImg: document.getElementById('question-img'),
    noImgPlaceholder: document.getElementById('no-image-placeholder'),
    questionTopicLabel: document.getElementById('question-topic-label'),
    questionNumberBadge: document.getElementById('question-number-badge'),
    questionStatusBadge: document.getElementById('question-status-badge'),
    questionText: document.getElementById('question-text'),
    btnTrue: document.getElementById('btn-true'),
    btnFalse: document.getElementById('btn-false'),
    btnPrev: document.getElementById('btn-prev'),
    btnNext: document.getElementById('btn-next'),

    overlayFullscreen: document.getElementById('overlay-fullscreen'),
    btnReenterFullscreen: document.getElementById('btn-reenter-fullscreen'),
    modalViolation: document.getElementById('modal-violation'),
    violationModalText: document.getElementById('violation-modal-text'),
    btnAckViolation: document.getElementById('btn-ack-violation'),
    modalConfirmSubmit: document.getElementById('modal-confirm-submit'),
    confirmSummaryText: document.getElementById('confirm-summary-text'),
    confirmUnansweredWarn: document.getElementById('confirm-unanswered-warn'),
    btnCancelSubmit: document.getElementById('btn-cancel-submit'),
    btnConfirmSubmit: document.getElementById('btn-confirm-submit'),

    resultBanner: document.getElementById('result-banner'),
    resultHeadline: document.getElementById('result-headline'),
    resultSubtext: document.getElementById('result-subtext'),
    resultStats: document.getElementById('result-stats'),
    resCandidate: document.getElementById('res-candidate'),
    resSheet: document.getElementById('res-sheet'),
    resCorrect: document.getElementById('res-correct'),
    resErrors: document.getElementById('res-errors'),
    resUnanswered: document.getElementById('res-unanswered'),
    resDuration: document.getElementById('res-duration'),
    btnBackHome: document.getElementById('btn-back-home'),
  };

  // ============================================================
  // HELPERS
  // ============================================================
  function showScreen(name) {
    Object.entries(screens).forEach(([key, node]) => {
      node.classList.toggle('screen-active', key === name);
    });
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  function showStartError(msg) {
    if (!msg) {
      el.startError.classList.add('hidden');
      el.startError.textContent = '';
    } else {
      el.startError.textContent = msg;
      el.startError.classList.remove('hidden');
    }
  }

  function supportsFullscreen() {
    const docEl = document.documentElement;
    const enabled =
      document.fullscreenEnabled !== false &&
      document.webkitFullscreenEnabled !== false;
    return (
      enabled &&
      Boolean(
        docEl.requestFullscreen ||
          docEl.webkitRequestFullscreen ||
          docEl.msRequestFullscreen
      )
    );
  }

  function isInFullscreen() {
    return Boolean(
      document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
    );
  }

  async function requestFullscreenSafe() {
    const docEl = document.documentElement;
    if (docEl.requestFullscreen) {
      await docEl.requestFullscreen();
    } else if (docEl.webkitRequestFullscreen) {
      await docEl.webkitRequestFullscreen();
    } else if (docEl.msRequestFullscreen) {
      await docEl.msRequestFullscreen();
    } else {
      throw new Error('Fullscreen API non supportata da questo browser.');
    }
  }

  async function exitFullscreenSafe() {
    state.fullscreenExitExpected = true;
    try {
      if (isInFullscreen()) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      }
    } catch {
      // ignore
    } finally {
      setTimeout(() => {
        state.fullscreenExitExpected = false;
      }, 400);
    }
  }

  function updateStartButton() {
    const hasName = el.candidateInput.value.trim().length >= 2;
    el.btnStartExam.disabled = !(hasName && state.selectedSlot);
  }

  // ============================================================
  // LOAD THE 3 OFFICIAL TESTS
  // ============================================================
  async function loadTests() {
    try {
      const res = await fetch('/api/tests');
      if (!res.ok) throw new Error('Impossibile caricare le schede d\'esame.');
      const data = await res.json();
      state.tests = data.tests || [];

      el.testSelector.innerHTML = '';
      state.tests.forEach((t) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'test-option';
        btn.dataset.slot = String(t.slot);
        btn.innerHTML = `
          <div class="test-option-title">Test ${t.slot}</div>
          <div class="test-option-meta">Scheda fissa #${t.slot} · 30 domande</div>
        `;
        btn.addEventListener('click', () => {
          state.selectedSlot = t.slot;
          document.querySelectorAll('.test-option').forEach((n) => n.classList.remove('selected'));
          btn.classList.add('selected');
          updateStartButton();
        });
        el.testSelector.appendChild(btn);
      });
    } catch (err) {
      el.testSelector.innerHTML = `<div class="error-banner">${err.message}</div>`;
    }
  }

  // ============================================================
  // ANTI-CHEAT REPORTING & ENFORCEMENT
  // ============================================================
  async function logAntiCheatEvent(eventType, details = '') {
    if (!state.attemptId) return null;
    try {
      const res = await fetch(`/api/attempts/${encodeURIComponent(state.attemptId)}/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType, details }),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function handleScreenExitViolation(eventType, details) {
    if (!state.examActive || state.submitting) return;

    // Coalesce simultaneous visibilitychange + window.blur within 900ms into a single violation
    const now = Date.now();
    if (now - state.lastViolationTs < 900) return;
    state.lastViolationTs = now;

    const result = await logAntiCheatEvent(eventType, details);
    if (!state.examActive) return;

    const violations = result ? result.violationsCount : state.violationsCount + 1;
    state.violationsCount = violations;
    el.violationsCounter.textContent = `${violations} / ${state.maxViolations}`;
    el.violationsBox.classList.add('has-violation');

    if ((result && result.invalidated) || violations >= state.maxViolations) {
      terminateInvalidated(
        (result && result.reason) || 'ESAME ANNULLATO PER USCITA DALLA SCHERMATA'
      );
      return;
    }

    // 1st violation warning
    el.violationModalText.textContent = `Violazione rilevata (${details}). L'evento è stato salvato nel registro anti-cheat.`;
    el.modalViolation.classList.remove('hidden');
  }

  function terminateInvalidated(reason) {
    stopExamMonitors();
    el.overlayFullscreen.classList.add('hidden');
    el.modalViolation.classList.add('hidden');
    el.modalConfirmSubmit.classList.add('hidden');
    exitFullscreenSafe();

    el.resultBanner.className = 'result-banner invalidated';
    el.resultBanner.textContent = 'ESAME ANNULLATO';
    el.resultHeadline.textContent = reason;
    el.resultSubtext.textContent =
      'Hai superato il limite massimo di uscite dalla schermata (2 violazioni). La prova è stata invalidata e registrata nel log anti-cheat.';
    el.resultStats.classList.add('hidden');
    showScreen('result');
  }

  function onFullscreenChange() {
    if (!state.examActive || state.fullscreenExitExpected || !state.fullscreenRequired) return;
    if (!isInFullscreen()) {
      el.overlayFullscreen.classList.remove('hidden');
      logAntiCheatEvent('FULLSCREEN_EXIT', 'Il candidato è uscito dalla modalità Schermo Intero');
    } else {
      if (!el.overlayFullscreen.classList.contains('hidden')) {
        el.overlayFullscreen.classList.add('hidden');
        logAntiCheatEvent('FULLSCREEN_REENTER', 'Il candidato è rientrato in modalità Schermo Intero');
      }
    }
  }

  function onVisibilityChange() {
    if (!state.examActive) return;
    if (document.hidden) {
      handleScreenExitViolation('TAB_SWITCH', 'Cambio scheda o riduzione a icona del browser');
    }
  }

  function onWindowBlur() {
    if (!state.examActive) return;
    // Ignore blur caused immediately while fullscreen overlay is already active on desktop/Android
    if (state.fullscreenRequired && !isInFullscreen()) return;
    handleScreenExitViolation('WINDOW_BLUR', 'Perdita focus finestra (click su altra app o finestra)');
  }

  function onContextMenu(e) {
    if (!state.examActive) return;
    e.preventDefault();
    const now = Date.now();
    if (now - state.lastShortcutLogTs > 2000) {
      state.lastShortcutLogTs = now;
      logAntiCheatEvent('CONTEXT_MENU_BLOCKED', 'Tentativo apertura menu contestuale (tasto destro)');
    }
  }

  function onClipboardOrDrag(e) {
    if (!state.examActive) return;
    e.preventDefault();
  }

  function onKeyDown(e) {
    if (!state.examActive) return;

    const key = (e.key || '').toLowerCase();
    const ctrlOrMeta = e.ctrlKey || e.metaKey;

    const blockedDevtools =
      e.key === 'F12' ||
      (ctrlOrMeta && e.shiftKey && ['i', 'j', 'c', 'k'].includes(key)) ||
      (e.metaKey && e.altKey && ['i', 'j', 'c'].includes(key));

    const blockedClipboardOrSource =
      ctrlOrMeta && ['c', 'v', 'x', 'u', 'a', 's', 'p', 'f'].includes(key);

    const blockedAltTab = e.altKey && e.key === 'Tab';
    const blockedPrint = e.key === 'PrintScreen';

    if (blockedDevtools || blockedClipboardOrSource || blockedAltTab || blockedPrint) {
      e.preventDefault();
      e.stopPropagation();

      const now = Date.now();
      if (now - state.lastShortcutLogTs > 1500) {
        state.lastShortcutLogTs = now;
        const combo = `${e.ctrlKey ? 'Ctrl+' : ''}${e.metaKey ? 'Meta+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key}`;
        logAntiCheatEvent('SHORTCUT_BLOCKED', `Scorciatoia bloccata: ${combo}`);
      }
    }
  }

  function onPageHide() {
    if (!state.examActive || !state.attemptId) return;
    const payload = JSON.stringify({
      eventType: 'PAGE_UNLOAD',
      details: 'Chiusura o ricaricamento pagina durante esame in corso',
    });
    const blob = new Blob([payload], { type: 'application/json' });
    navigator.sendBeacon(`/api/attempts/${encodeURIComponent(state.attemptId)}/event`, blob);
  }

  function startDevtoolsHeuristic() {
    let flagged = false;
    state.devtoolsInterval = setInterval(() => {
      if (!state.examActive || !isInFullscreen() || flagged) return;
      const widthDiff = Math.abs(window.outerWidth - window.innerWidth);
      const heightDiff = Math.abs(window.outerHeight - window.innerHeight);
      if (widthDiff > 220 || heightDiff > 220) {
        flagged = true;
        logAntiCheatEvent(
          'DEVTOOLS_SUSPECTED',
          `Anomalia dimensioni viewport in Fullscreen (dw=${widthDiff}, dh=${heightDiff})`
        );
      }
    }, 3000);
  }

  function attachExamMonitors() {
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('copy', onClipboardOrDrag);
    document.addEventListener('cut', onClipboardOrDrag);
    document.addEventListener('paste', onClipboardOrDrag);
    document.addEventListener('dragstart', onClipboardOrDrag);
    document.addEventListener('selectstart', onClipboardOrDrag);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pagehide', onPageHide);
    startDevtoolsHeuristic();
  }

  function stopExamMonitors() {
    state.examActive = false;
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
    if (state.devtoolsInterval) {
      clearInterval(state.devtoolsInterval);
      state.devtoolsInterval = null;
    }
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('blur', onWindowBlur);
    document.removeEventListener('contextmenu', onContextMenu);
    document.removeEventListener('copy', onClipboardOrDrag);
    document.removeEventListener('cut', onClipboardOrDrag);
    document.removeEventListener('paste', onClipboardOrDrag);
    document.removeEventListener('dragstart', onClipboardOrDrag);
    document.removeEventListener('selectstart', onClipboardOrDrag);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('pagehide', onPageHide);
  }

  // ============================================================
  // EXAM RENDERING & NAVIGATION
  // ============================================================
  function preloadQuestionImages(questions) {
    questions.forEach((q) => {
      if (q.img) {
        const im = new Image();
        im.src = q.img;
      }
    });
  }

  function renderNavGrid() {
    el.navGrid.innerHTML = '';
    state.questions.forEach((q, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-cell';
      btn.dataset.index = String(idx);

      const ans = state.answers[String(q.position)];
      if (ans !== undefined) {
        btn.classList.add('answered');
        btn.innerHTML = `<span>${q.position}</span><span class="nav-cell-ans">${ans ? 'V' : 'F'}</span>`;
      } else {
        btn.textContent = String(q.position);
      }

      if (idx === state.currentIndex) {
        btn.classList.add('current');
      }

      btn.addEventListener('click', () => {
        state.currentIndex = idx;
        renderCurrentQuestion();
      });
      el.navGrid.appendChild(btn);
    });

    const answeredCount = Object.keys(state.answers).length;
    el.answeredCounter.textContent = `${answeredCount} / ${state.questions.length}`;
  }

  function renderCurrentQuestion() {
    const q = state.questions[state.currentIndex];
    if (!q) return;

    el.questionNumberBadge.textContent = `DOMANDA ${q.position} DI ${state.questions.length}`;
    el.questionTopicLabel.textContent = q.topic || '';
    el.questionText.textContent = q.text;

    if (q.img) {
      el.questionImg.src = q.img;
      el.questionImg.classList.remove('hidden');
      el.noImgPlaceholder.classList.add('hidden');
    } else {
      el.questionImg.src = '';
      el.questionImg.classList.add('hidden');
      el.noImgPlaceholder.classList.remove('hidden');
    }

    const ans = state.answers[String(q.position)];
    el.btnTrue.classList.toggle('selected', ans === true);
    el.btnFalse.classList.toggle('selected', ans === false);

    if (ans === true) {
      el.questionStatusBadge.textContent = 'Risposta: VERO';
      el.questionStatusBadge.classList.add('is-answered');
    } else if (ans === false) {
      el.questionStatusBadge.textContent = 'Risposta: FALSO';
      el.questionStatusBadge.classList.add('is-answered');
    } else {
      el.questionStatusBadge.textContent = 'Non risposta';
      el.questionStatusBadge.classList.remove('is-answered');
    }

    el.btnPrev.disabled = state.currentIndex === 0;
    el.btnNext.disabled = state.currentIndex === state.questions.length - 1;

    renderNavGrid();
  }

  function setAnswer(boolVal) {
    if (!state.examActive) return;
    const q = state.questions[state.currentIndex];
    if (!q) return;
    state.answers[String(q.position)] = boolVal;
    renderCurrentQuestion();
  }

  function startTimer() {
    updateTimerUi();
    state.timerInterval = setInterval(() => {
      state.remainingSeconds -= 1;
      updateTimerUi();
      if (state.remainingSeconds <= 0) {
        clearInterval(state.timerInterval);
        state.timerInterval = null;
        submitExam(true);
      }
    }, 1000);
  }

  function updateTimerUi() {
    el.timerDisplay.textContent = formatTime(state.remainingSeconds);
    el.timerBox.classList.remove('timer-warn', 'timer-danger');
    if (state.remainingSeconds <= 120) {
      el.timerBox.classList.add('timer-danger');
    } else if (state.remainingSeconds <= 300) {
      el.timerBox.classList.add('timer-warn');
    }
  }

  // ============================================================
  // START & SUBMIT EXAM
  // ============================================================
  async function startExam(e) {
    e.preventDefault();
    showStartError('');

    const candidateName = el.candidateInput.value.trim();
    if (candidateName.length < 2) {
      showStartError('Inserisci il tuo nome e cognome (almeno 2 caratteri).');
      return;
    }
    if (!state.selectedSlot) {
      showStartError('Seleziona una scheda (Test 1, Test 2 o Test 3).');
      return;
    }

    // 1. Mandatory Fullscreen on Desktop & Android; protected mobile fallback on iOS/iPhone
    //    (Apple WebKit on iPhone does not support document.documentElement.requestFullscreen)
    let mobileProtectedMode = false;
    if (supportsFullscreen()) {
      state.fullscreenRequired = true;
      try {
        await requestFullscreenSafe();
      } catch {
        showStartError(
          'Impossibile attivare la modalità Schermo Intero. L\'esame non può iniziare senza Fullscreen attivo.'
        );
        return;
      }

      if (!isInFullscreen()) {
        showStartError('Devi acconsentire alla modalità Schermo Intero per iniziare la prova.');
        return;
      }
    } else {
      state.fullscreenRequired = false;
      mobileProtectedMode = true;
      window.scrollTo(0, 1);
    }

    el.btnStartExam.disabled = true;

    try {
      const res = await fetch('/api/attempts/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slot: state.selectedSlot,
          candidateName,
          mobileProtectedMode,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        await exitFullscreenSafe();
        showStartError(data.error || 'Errore durante l\'avvio dell\'esame.');
        updateStartButton();
        return;
      }

      // Initialize active exam state
      state.attemptId = data.attemptId;
      state.slot = data.slot;
      state.candidateName = data.candidateName;
      state.questions = data.questions;
      state.answers = {};
      state.currentIndex = 0;
      state.remainingSeconds = data.durationSeconds || 1200;
      state.violationsCount = 0;
      state.maxViolations = data.maxViolations || 2;
      state.examActive = true;
      state.submitting = false;

      el.examSheetLabel.textContent = `TEST ${data.slot}`;
      el.examCandidateLabel.textContent = data.candidateName;
      el.violationsCounter.textContent = `0 / ${state.maxViolations}`;
      el.violationsBox.classList.remove('has-violation');
      el.overlayFullscreen.classList.add('hidden');
      el.modalViolation.classList.add('hidden');
      el.modalConfirmSubmit.classList.add('hidden');

      preloadQuestionImages(state.questions);
      showScreen('exam');
      renderCurrentQuestion();
      attachExamMonitors();
      startTimer();
    } catch {
      await exitFullscreenSafe();
      showStartError('Errore di connessione con il server. Riprova.');
      updateStartButton();
    }
  }

  function openSubmitModal() {
    if (!state.examActive) return;
    const total = state.questions.length;
    const answered = Object.keys(state.answers).length;
    const unanswered = total - answered;

    el.confirmSummaryText.textContent = `Hai risposto a ${answered} domande su ${total}. Sei sicuro di voler consegnare definitivamente la scheda d'esame?`;

    if (unanswered > 0) {
      el.confirmUnansweredWarn.textContent = `Attenzione: hai lasciato ${unanswered} ${
        unanswered === 1 ? 'domanda senza risposta' : 'domande senza risposta'
      }. Ogni risposta non data conta come errore!`;
      el.confirmUnansweredWarn.classList.remove('hidden');
    } else {
      el.confirmUnansweredWarn.classList.add('hidden');
    }

    el.modalConfirmSubmit.classList.remove('hidden');
  }

  async function submitExam(timedOut = false) {
    if (state.submitting || !state.attemptId) return;
    state.submitting = true;
    el.modalConfirmSubmit.classList.add('hidden');
    stopExamMonitors();

    try {
      const res = await fetch(`/api/attempts/${encodeURIComponent(state.attemptId)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: state.answers, timedOut }),
      });
      const data = await res.json();

      await exitFullscreenSafe();

      if (data.status === 'INVALIDATED') {
        terminateInvalidated(data.reason || 'ESAME ANNULLATO PER USCITA DALLA SCHERMATA');
        return;
      }

      const passed = data.status === 'PASSED';
      el.resultBanner.className = `result-banner ${passed ? 'passed' : 'failed'}`;
      el.resultBanner.textContent = passed ? 'IDONEO — PROMOSSO' : 'NON IDONEO — BOCCIATO';
      el.resultHeadline.textContent = passed
        ? 'Complimenti! Hai superato la simulazione.'
        : 'Esame non superato (più di 3 errori).';
      el.resultSubtext.textContent = timedOut
        ? 'Il tempo massimo di 20 minuti è scaduto: la scheda è stata inviata automaticamente.'
        : 'La scheda d\'esame è stata valutata secondo i criteri ministeriali ufficiali (max 3 errori).';

      el.resCandidate.textContent = state.candidateName;
      el.resSheet.textContent = `Test ${state.slot}`;
      el.resCorrect.textContent = `${data.correctCount} / 30`;
      el.resErrors.textContent = `${data.errorCount} (max 3)`;
      el.resUnanswered.textContent = String(data.unansweredCount);
      el.resDuration.textContent = formatTime(data.durationSeconds);

      el.resultStats.classList.remove('hidden');
      showScreen('result');
    } catch {
      alert('Errore di rete durante la consegna dell\'esame. Riprova.');
      state.submitting = false;
    }
  }

  // ============================================================
  // EVENT LISTENERS
  // ============================================================
  el.candidateInput.addEventListener('input', updateStartButton);
  el.startForm.addEventListener('submit', startExam);

  el.btnTrue.addEventListener('click', () => setAnswer(true));
  el.btnFalse.addEventListener('click', () => setAnswer(false));

  el.btnPrev.addEventListener('click', () => {
    if (state.currentIndex > 0) {
      state.currentIndex -= 1;
      renderCurrentQuestion();
    }
  });

  el.btnNext.addEventListener('click', () => {
    if (state.currentIndex < state.questions.length - 1) {
      state.currentIndex += 1;
      renderCurrentQuestion();
    }
  });

  el.btnOpenSubmit.addEventListener('click', openSubmitModal);
  el.btnCancelSubmit.addEventListener('click', () => el.modalConfirmSubmit.classList.add('hidden'));
  el.btnConfirmSubmit.addEventListener('click', () => submitExam(false));

  el.btnReenterFullscreen.addEventListener('click', async () => {
    try {
      await requestFullscreenSafe();
    } catch {
      // Browser will keep overlay visible until fullscreen is granted
    }
  });

  el.btnAckViolation.addEventListener('click', async () => {
    el.modalViolation.classList.add('hidden');
    if (state.fullscreenRequired && !isInFullscreen()) {
      try {
        await requestFullscreenSafe();
      } catch {
        el.overlayFullscreen.classList.remove('hidden');
      }
    }
  });

  el.btnBackHome.addEventListener('click', () => {
    state.attemptId = null;
    state.questions = [];
    state.answers = {};
    showScreen('start');
    updateStartButton();
  });

  // Boot
  loadTests();
})();

'use strict';

(() => {
  const el = {
    viewLogin: document.getElementById('view-login'),
    viewDashboard: document.getElementById('view-dashboard'),
    btnLogout: document.getElementById('btn-logout'),

    loginForm: document.getElementById('login-form'),
    passwordInput: document.getElementById('admin-password'),
    loginError: document.getElementById('login-error'),

    kpiTotal: document.getElementById('kpi-total'),
    kpiPassed: document.getElementById('kpi-passed'),
    kpiFailed: document.getElementById('kpi-failed'),
    kpiInvalidated: document.getElementById('kpi-invalidated'),

    activeTestsMeta: document.getElementById('active-tests-meta'),
    btnRegenerate: document.getElementById('btn-regenerate'),
    regenFeedback: document.getElementById('regen-feedback'),

    filterSlot: document.getElementById('filter-slot'),
    filterStatus: document.getElementById('filter-status'),
    btnRefresh: document.getElementById('btn-refresh'),
    attemptsTbody: document.getElementById('attempts-tbody'),

    detailModal: document.getElementById('detail-modal'),
    detailTitle: document.getElementById('detail-title'),
    detailSubtitle: document.getElementById('detail-subtitle'),
    detailMetaGrid: document.getElementById('detail-meta-grid'),
    btnCloseDetail: document.getElementById('btn-close-detail'),
    countWrong: document.getElementById('count-wrong'),
    countLogs: document.getElementById('count-logs'),
    tabWrong: document.getElementById('tab-wrong'),
    tabLogs: document.getElementById('tab-logs'),
    tabAll: document.getElementById('tab-all'),
  };

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('it-IT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatDuration(sec) {
    if (sec === null || sec === undefined) return '—';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function statusPill(status) {
    switch (status) {
      case 'PASSED':
        return '<span class="status-pill pill-passed">PROMOSSO</span>';
      case 'FAILED':
        return '<span class="status-pill pill-failed">BOCCIATO</span>';
      case 'INVALIDATED':
        return '<span class="status-pill pill-invalidated">ANNULLATO</span>';
      default:
        return '<span class="status-pill pill-progress">IN CORSO</span>';
    }
  }

  function formatBoolAnswer(val) {
    if (val === null || val === undefined) return 'Non risposta';
    return val ? 'VERO' : 'FALSO';
  }

  function showAuthState(authenticated) {
    el.viewLogin.classList.toggle('hidden', authenticated);
    el.viewDashboard.classList.toggle('hidden', !authenticated);
    el.btnLogout.classList.toggle('hidden', !authenticated);
    if (authenticated) {
      loadOverview();
    }
  }

  async function checkSession() {
    try {
      const res = await fetch('/api/admin/session');
      const data = await res.json();
      showAuthState(Boolean(data.authenticated));
    } catch {
      showAuthState(false);
    }
  }

  async function login(e) {
    e.preventDefault();
    el.loginError.classList.add('hidden');
    const password = el.passwordInput.value;

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) {
        el.loginError.textContent = data.error || 'Accesso negato.';
        el.loginError.classList.remove('hidden');
        return;
      }
      el.passwordInput.value = '';
      showAuthState(true);
    } catch {
      el.loginError.textContent = 'Errore di rete.';
      el.loginError.classList.remove('hidden');
    }
  }

  async function logout() {
    await fetch('/api/admin/logout', { method: 'POST' });
    showAuthState(false);
  }

  async function loadOverview() {
    const params = new URLSearchParams();
    if (el.filterSlot.value) params.set('slot', el.filterSlot.value);
    if (el.filterStatus.value) params.set('status', el.filterStatus.value);

    const res = await fetch(`/api/admin/overview?${params.toString()}`);
    if (res.status === 401) {
      showAuthState(false);
      return;
    }
    const data = await res.json();

    el.kpiTotal.textContent = data.stats.total;
    el.kpiPassed.textContent = data.stats.passed;
    el.kpiFailed.textContent = data.stats.failed;
    el.kpiInvalidated.textContent = data.stats.invalidated;

    if (data.activeTests && data.activeTests.length) {
      const ver = data.activeTests[0].version;
      const created = formatDateTime(data.activeTests[0].created_at);
      el.activeTestsMeta.textContent = `Versione corrente: v${ver} (generate il ${created}) · Dataset ministeriale: ${data.totalQuestionsInDb} domande`;
    }

    if (!data.attempts.length) {
      el.attemptsTbody.innerHTML =
        '<tr><td colspan="9" class="empty-cell">Nessun tentativo trovato con i filtri selezionati.</td></tr>';
      return;
    }

    el.attemptsTbody.innerHTML = data.attempts
      .map(
        (a) => `
      <tr>
        <td>${escapeHtml(formatDateTime(a.started_at))}</td>
        <td><strong>${escapeHtml(a.candidate_name)}</strong></td>
        <td>Test ${a.test_slot} <span class="muted-text">(v${a.test_version})</span></td>
        <td>${statusPill(a.status)}</td>
        <td>${a.status === 'IN_PROGRESS' ? '—' : `${a.correct_count}/30 (${a.error_count} err.)`}</td>
        <td>${formatDuration(a.duration_seconds)}</td>
        <td>${a.violations_count > 0 ? `<strong style="color:#b91c1c">${a.violations_count}</strong>` : '0'}</td>
        <td>${a.log_count} eventi</td>
        <td>
          <button type="button" class="btn-sm btn-inspect" data-id="${escapeHtml(a.id)}">Dettagli</button>
          <button type="button" class="btn-sm btn-sm-del btn-delete" data-id="${escapeHtml(a.id)}">Elimina</button>
        </td>
      </tr>
    `
      )
      .join('');

    el.attemptsTbody.querySelectorAll('.btn-inspect').forEach((btn) => {
      btn.addEventListener('click', () => openAttemptDetail(btn.dataset.id));
    });
    el.attemptsTbody.querySelectorAll('.btn-delete').forEach((btn) => {
      btn.addEventListener('click', () => deleteAttempt(btn.dataset.id));
    });
  }

  function renderAnswersList(items, emptyMessage) {
    if (!items.length) {
      return `<p class="muted-text">${escapeHtml(emptyMessage)}</p>`;
    }
    return items
      .map(
        (q) => `
      <div class="review-item ${q.isCorrect ? 'review-ok' : ''}">
        <div class="review-img-box">
          ${
            q.img
              ? `<img src="${escapeHtml(q.img)}" alt="Segnale" loading="lazy" />`
              : '<span>Nessuna figura</span>'
          }
        </div>
        <div>
          <div class="review-topic">Domanda #${q.position} · ${escapeHtml(q.topic)}</div>
          <div class="review-text">${escapeHtml(q.text)}</div>
          <div class="review-answers">
            <span class="ans-tag ${q.isCorrect ? 'ans-correct' : 'ans-wrong'}">
              Risposta candidato: ${formatBoolAnswer(q.givenAnswer)}
            </span>
            <span class="ans-tag ans-neutral">
              Risposta ufficiale: ${formatBoolAnswer(q.correctAnswer)}
            </span>
          </div>
        </div>
      </div>
    `
      )
      .join('');
  }

  function renderLogsList(logs) {
    if (!logs.length) {
      return '<p class="muted-text">Nessun evento registrato.</p>';
    }
    const dangerTypes = new Set(['TAB_SWITCH', 'WINDOW_BLUR', 'EXAM_INVALIDATED', 'DEVTOOLS_SUSPECTED']);
    const warnTypes = new Set(['FULLSCREEN_EXIT', 'SHORTCUT_BLOCKED', 'CONTEXT_MENU_BLOCKED', 'PAGE_UNLOAD']);

    return `<div class="log-list">${logs
      .map((l) => {
        const cls = dangerTypes.has(l.event_type)
          ? 'log-danger'
          : warnTypes.has(l.event_type)
          ? 'log-warn'
          : '';
        return `
        <div class="log-row ${cls}">
          <span class="log-time">${escapeHtml(formatDateTime(l.created_at))}</span>
          <span class="log-type">${escapeHtml(l.event_type)}</span>
          <span>${escapeHtml(l.details || '')}</span>
        </div>
      `;
      })
      .join('')}</div>`;
  }

  async function openAttemptDetail(attemptId) {
    const res = await fetch(`/api/admin/attempts/${encodeURIComponent(attemptId)}`);
    if (!res.ok) return;
    const data = await res.json();
    const a = data.attempt;

    el.detailTitle.textContent = `${a.candidate_name} — Test ${a.test_slot} (v${a.test_version})`;
    el.detailSubtitle.textContent = a.invalidation_reason
      ? `ANNULLATO: ${a.invalidation_reason}`
      : `Iniziato: ${formatDateTime(a.started_at)} · Terminato: ${formatDateTime(a.finished_at)}`;

    el.detailMetaGrid.innerHTML = `
      <div class="meta-box"><span>Esito</span><strong>${statusPill(a.status)}</strong></div>
      <div class="meta-box"><span>Esatte / Errori</span><strong>${a.correct_count}/30 (${a.error_count} errori)</strong></div>
      <div class="meta-box"><span>Durata</span><strong>${formatDuration(a.duration_seconds)}</strong></div>
      <div class="meta-box"><span>Violazioni / IP</span><strong>${a.violations_count} · ${escapeHtml(a.ip_address || '—')}</strong></div>
    `;

    el.countWrong.textContent = String(data.wrongAnswers.length);
    el.countLogs.textContent = String(data.logs.length);

    el.tabWrong.innerHTML = renderAnswersList(
      data.wrongAnswers,
      a.status === 'INVALIDATED'
        ? 'Esame annullato prima della consegna: nessuna scheda valutata.'
        : 'Nessun errore commesso in questo tentativo!'
    );
    el.tabLogs.innerHTML = renderLogsList(data.logs);
    el.tabAll.innerHTML = renderAnswersList(
      data.answers,
      'Nessuna risposta registrata (esame non consegnato).'
    );

    switchDetailTab('wrong');
    el.detailModal.classList.remove('hidden');
  }

  function switchDetailTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    el.tabWrong.classList.toggle('hidden', tabName !== 'wrong');
    el.tabLogs.classList.toggle('hidden', tabName !== 'logs');
    el.tabAll.classList.toggle('hidden', tabName !== 'all');
  }

  async function regenerateTests() {
    const ok = confirm(
      'Vuoi rigenerare Test 1, Test 2 e Test 3 con 90 nuove domande estratte in modo bilanciato dal listato ministeriale?\n\nLo storico dei tentativi precedenti resterà intatto.'
    );
    if (!ok) return;

    el.btnRegenerate.disabled = true;
    el.regenFeedback.classList.add('hidden');
    try {
      const res = await fetch('/api/admin/tests/regenerate', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        el.regenFeedback.textContent = data.message;
        el.regenFeedback.classList.remove('hidden');
        await loadOverview();
      }
    } finally {
      el.btnRegenerate.disabled = false;
    }
  }

  async function deleteAttempt(attemptId) {
    if (!confirm('Eliminare definitivamente questo tentativo e i relativi log?')) return;
    const res = await fetch(`/api/admin/attempts/${encodeURIComponent(attemptId)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      loadOverview();
    }
  }

  // Event listeners
  el.loginForm.addEventListener('submit', login);
  el.btnLogout.addEventListener('click', logout);
  el.btnRegenerate.addEventListener('click', regenerateTests);
  el.btnRefresh.addEventListener('click', loadOverview);
  el.filterSlot.addEventListener('change', loadOverview);
  el.filterStatus.addEventListener('change', loadOverview);
  el.btnCloseDetail.addEventListener('click', () => el.detailModal.classList.add('hidden'));
  el.detailModal.addEventListener('click', (e) => {
    if (e.target === el.detailModal) el.detailModal.classList.add('hidden');
  });

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchDetailTab(btn.dataset.tab));
  });

  checkSession();
})();

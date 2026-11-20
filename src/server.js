'use strict';

require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const helmet = require('helmet');

const { db, initSchema, seedQuestionsIfEmpty } = require('./db');
const { TOPIC_LABELS, ensureActiveTests, generateThreeTests } = require('./generator');
const {
  checkRateLimit,
  recordLoginFailure,
  clearLoginFailures,
  verifyPassword,
  createSessionToken,
  isAuthenticated,
  setSessionCookie,
  clearSessionCookie,
  requireAdmin,
} = require('./auth');

const PORT = Number(process.env.PORT) || 3080;
const HOST = process.env.HOST || '0.0.0.0';
const EXAM_DURATION_SECONDS = 1200; // 20 minuti ufficiali
const MAX_ERRORS_TO_PASS = 3;       // Promosso con massimo 3 errori (almeno 27/30)
const MAX_VIOLATIONS = 2;           // Alla 2ª violazione esame annullato

// Initialize database, seed official dataset, and ensure 3 fixed active tests exist
initSchema();
const totalQuestions = seedQuestionsIfEmpty();
ensureActiveTests();

const app = express();

if (String(process.env.TRUST_PROXY).toLowerCase() === 'true') {
  app.set('trust proxy', 1);
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json({ limit: '100kb' }));

// Static assets (images cached aggressively for fast loading during exam)
app.use(
  '/img_sign',
  express.static(path.join(__dirname, '..', 'public', 'img_sign'), {
    maxAge: '7d',
    immutable: true,
  })
);
app.use(express.static(path.join(__dirname, '..', 'public')));

// Helper to get client IP cleanly
function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// ============================================================
// PUBLIC / EXAM ROUTES
// ============================================================

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', questionsLoaded: totalQuestions });
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

/**
 * List the 3 fixed active official exam sheets (Test 1, Test 2, Test 3).
 */
app.get('/api/tests', (_req, res) => {
  const tests = db
    .prepare(`
      SELECT id, slot, version, created_at
      FROM tests
      WHERE is_active = 1
      ORDER BY slot ASC
    `)
    .all();

  res.json({
    durationSeconds: EXAM_DURATION_SECONDS,
    maxErrors: MAX_ERRORS_TO_PASS,
    totalQuestions: 30,
    tests: tests.map((t) => ({
      id: t.id,
      slot: t.slot,
      name: `Test ${t.slot}`,
      version: t.version,
      createdAt: t.created_at,
    })),
  });
});

/**
 * Start a new exam attempt for one of the 3 active tests.
 * Never returns `correct_answer` to the client.
 */
app.post('/api/attempts/start', (req, res) => {
  const slot = Number(req.body?.slot);
  const rawName = typeof req.body?.candidateName === 'string' ? req.body.candidateName.trim() : '';

  if (![1, 2, 3].includes(slot)) {
    return res.status(400).json({ error: 'Seleziona un test valido (Test 1, Test 2 o Test 3).' });
  }
  if (rawName.length < 2 || rawName.length > 80) {
    return res.status(400).json({ error: 'Inserisci il nome e cognome del candidato (2-80 caratteri).' });
  }

  const test = db
    .prepare('SELECT id, slot, version FROM tests WHERE is_active = 1 AND slot = ?')
    .get(slot);

  if (!test) {
    return res.status(404).json({ error: 'Scheda d\'esame non trovata.' });
  }

  const questions = db
    .prepare(`
      SELECT tq.position, q.id AS question_id, q.topic, q.text, q.img
      FROM test_questions tq
      JOIN questions q ON q.id = tq.question_id
      WHERE tq.test_id = ?
      ORDER BY tq.position ASC
    `)
    .all(test.id);

  const attemptId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const ip = getClientIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 255);

  const createAttemptTx = db.transaction(() => {
    db.prepare(`
      INSERT INTO attempts (
        id, test_id, test_slot, test_version, candidate_name,
        started_at, status, ip_address, user_agent
      ) VALUES (
        @id, @test_id, @test_slot, @test_version, @candidate_name,
        @started_at, 'IN_PROGRESS', @ip_address, @user_agent
      )
    `).run({
      id: attemptId,
      test_id: test.id,
      test_slot: test.slot,
      test_version: test.version,
      candidate_name: rawName,
      started_at: startedAt,
      ip_address: ip,
      user_agent: ua,
    });

    db.prepare(`
      INSERT INTO anticheat_logs (attempt_id, event_type, details, created_at)
      VALUES (?, 'EXAM_START', ?, ?)
    `).run(attemptId, `Avviato Test ${test.slot} (v${test.version}) in modalità Fullscreen`, startedAt);
  });

  createAttemptTx();

  res.status(201).json({
    attemptId,
    testId: test.id,
    slot: test.slot,
    version: test.version,
    candidateName: rawName,
    startedAt,
    durationSeconds: EXAM_DURATION_SECONDS,
    maxErrors: MAX_ERRORS_TO_PASS,
    maxViolations: MAX_VIOLATIONS,
    questions: questions.map((q) => ({
      position: q.position,
      topic: TOPIC_LABELS[q.topic] || q.topic,
      text: q.text,
      img: q.img,
    })),
  });
});

/**
 * Record an anti-cheat event during an active attempt.
 * Violations (TAB_SWITCH / WINDOW_BLUR) increment violations_count;
 * on the 2nd violation, the exam is immediately invalidated server-side.
 */
const ALLOWED_EVENTS = new Set([
  'FULLSCREEN_EXIT',
  'FULLSCREEN_REENTER',
  'TAB_SWITCH',
  'WINDOW_BLUR',
  'SHORTCUT_BLOCKED',
  'CONTEXT_MENU_BLOCKED',
  'DEVTOOLS_SUSPECTED',
  'PAGE_UNLOAD',
]);

const VIOLATION_EVENTS = new Set(['TAB_SWITCH', 'WINDOW_BLUR']);

app.post('/api/attempts/:attemptId/event', (req, res) => {
  const { attemptId } = req.params;
  const eventType = String(req.body?.eventType || '').toUpperCase();
  const details = typeof req.body?.details === 'string' ? req.body.details.slice(0, 300) : '';

  if (!ALLOWED_EVENTS.has(eventType)) {
    return res.status(400).json({ error: 'Tipo di evento non valido.' });
  }

  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  if (!attempt) {
    return res.status(404).json({ error: 'Tentativo non trovato.' });
  }

  if (attempt.status !== 'IN_PROGRESS') {
    return res.json({
      recorded: false,
      status: attempt.status,
      violationsCount: attempt.violations_count,
      invalidated: attempt.status === 'INVALIDATED',
      reason: attempt.invalidation_reason,
    });
  }

  const now = new Date().toISOString();
  let newViolations = attempt.violations_count;
  let invalidated = false;
  let reason = null;

  const logTx = db.transaction(() => {
    db.prepare(`
      INSERT INTO anticheat_logs (attempt_id, event_type, details, created_at)
      VALUES (?, ?, ?, ?)
    `).run(attemptId, eventType, details, now);

    if (VIOLATION_EVENTS.has(eventType)) {
      newViolations += 1;
      if (newViolations >= MAX_VIOLATIONS) {
        invalidated = true;
        reason = 'ESAME ANNULLATO PER USCITA DALLA SCHERMATA';
        const durationSeconds = Math.max(
          0,
          Math.round((Date.now() - Date.parse(attempt.started_at)) / 1000)
        );
        db.prepare(`
          UPDATE attempts
          SET violations_count = ?,
              status = 'INVALIDATED',
              finished_at = ?,
              duration_seconds = ?,
              invalidation_reason = ?
          WHERE id = ?
        `).run(newViolations, now, durationSeconds, reason, attemptId);

        db.prepare(`
          INSERT INTO anticheat_logs (attempt_id, event_type, details, created_at)
          VALUES (?, 'EXAM_INVALIDATED', ?, ?)
        `).run(attemptId, `${reason} (Violazione ${newViolations}/${MAX_VIOLATIONS})`, now);
      } else {
        db.prepare('UPDATE attempts SET violations_count = ? WHERE id = ?').run(
          newViolations,
          attemptId
        );
      }
    }
  });

  logTx();

  res.json({
    recorded: true,
    violationsCount: newViolations,
    maxViolations: MAX_VIOLATIONS,
    invalidated,
    reason,
  });
});

/**
 * Submit exam answers and compute official ministerial score server-side.
 */
app.post('/api/attempts/:attemptId/submit', (req, res) => {
  const { attemptId } = req.params;
  const rawAnswers = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
  const timedOut = Boolean(req.body?.timedOut);

  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  if (!attempt) {
    return res.status(404).json({ error: 'Tentativo non trovato.' });
  }

  if (attempt.status === 'INVALIDATED') {
    return res.status(409).json({
      status: 'INVALIDATED',
      reason: attempt.invalidation_reason || 'ESAME ANNULLATO PER USCITA DALLA SCHERMATA',
      violationsCount: attempt.violations_count,
    });
  }

  if (attempt.status !== 'IN_PROGRESS') {
    return res.json({
      status: attempt.status,
      correctCount: attempt.correct_count,
      errorCount: attempt.error_count,
      unansweredCount: attempt.unanswered_count,
      durationSeconds: attempt.duration_seconds,
      violationsCount: attempt.violations_count,
    });
  }

  const testQuestions = db
    .prepare(`
      SELECT tq.position, q.id AS question_id, q.correct_answer
      FROM test_questions tq
      JOIN questions q ON q.id = tq.question_id
      WHERE tq.test_id = ?
      ORDER BY tq.position ASC
    `)
    .all(attempt.test_id);

  const now = new Date().toISOString();
  const elapsedSeconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(attempt.started_at)) / 1000)
  );
  const clampedDuration = Math.min(elapsedSeconds, EXAM_DURATION_SECONDS);

  let correctCount = 0;
  let errorCount = 0;
  let unansweredCount = 0;

  const insertAnswerStmt = db.prepare(`
    INSERT OR REPLACE INTO attempt_answers (attempt_id, position, question_id, given_answer, is_correct)
    VALUES (@attempt_id, @position, @question_id, @given_answer, @is_correct)
  `);

  const finalizeTx = db.transaction(() => {
    for (const q of testQuestions) {
      const val = rawAnswers[String(q.position)];
      let givenAnswer = null;
      if (val === true || val === 1 || val === 'V') givenAnswer = 1;
      else if (val === false || val === 0 || val === 'F') givenAnswer = 0;

      const isCorrect = givenAnswer !== null && givenAnswer === q.correct_answer ? 1 : 0;
      if (givenAnswer === null) {
        unansweredCount++;
        errorCount++;
      } else if (isCorrect) {
        correctCount++;
      } else {
        errorCount++;
      }

      insertAnswerStmt.run({
        attempt_id: attemptId,
        position: q.position,
        question_id: q.question_id,
        given_answer: givenAnswer,
        is_correct: isCorrect,
      });
    }

    const finalStatus = errorCount <= MAX_ERRORS_TO_PASS ? 'PASSED' : 'FAILED';

    db.prepare(`
      UPDATE attempts
      SET status = ?,
          finished_at = ?,
          duration_seconds = ?,
          correct_count = ?,
          error_count = ?,
          unanswered_count = ?
      WHERE id = ?
    `).run(
      finalStatus,
      now,
      clampedDuration,
      correctCount,
      errorCount,
      unansweredCount,
      attemptId
    );

    db.prepare(`
      INSERT INTO anticheat_logs (attempt_id, event_type, details, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      attemptId,
      timedOut ? 'TIME_EXPIRED' : 'EXAM_SUBMITTED',
      `Esito: ${finalStatus === 'PASSED' ? 'PROMOSSO' : 'BOCCIATO'} (${correctCount}/30 esatte, ${errorCount} errori, ${unansweredCount} non risposte)`,
      now
    );

    return finalStatus;
  });

  const finalStatus = finalizeTx();

  res.json({
    attemptId,
    status: finalStatus,
    passed: finalStatus === 'PASSED',
    correctCount,
    errorCount,
    unansweredCount,
    maxErrors: MAX_ERRORS_TO_PASS,
    durationSeconds: clampedDuration,
    violationsCount: attempt.violations_count,
  });
});

// ============================================================
// ADMIN ROUTES (/api/admin/*)
// ============================================================

app.get('/api/admin/session', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

app.post('/api/admin/login', (req, res) => {
  const ip = getClientIp(req);
  const rate = checkRateLimit(ip);
  if (!rate.allowed) {
    return res.status(429).json({
      error: `Troppi tentativi falliti. Riprova tra ${rate.retryAfterSec} secondi.`,
    });
  }

  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!verifyPassword(password)) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: 'Password errata.' });
  }

  clearLoginFailures(ip);
  const token = createSessionToken();
  setSessionCookie(res, token);
  res.json({ authenticated: true });
});

app.post('/api/admin/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ authenticated: false });
});

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const slotFilter = req.query.slot ? Number(req.query.slot) : null;
  const statusFilter = req.query.status ? String(req.query.status).toUpperCase() : null;

  const activeTests = db
    .prepare('SELECT id, slot, version, created_at FROM tests WHERE is_active = 1 ORDER BY slot ASC')
    .all();

  const where = [];
  const params = [];
  if ([1, 2, 3].includes(slotFilter)) {
    where.push('a.test_slot = ?');
    params.push(slotFilter);
  }
  if (['PASSED', 'FAILED', 'INVALIDATED', 'IN_PROGRESS'].includes(statusFilter)) {
    where.push('a.status = ?');
    params.push(statusFilter);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const attempts = db
    .prepare(`
      SELECT
        a.*,
        (SELECT COUNT(*) FROM anticheat_logs l WHERE l.attempt_id = a.id) AS log_count
      FROM attempts a
      ${whereSql}
      ORDER BY a.started_at DESC
      LIMIT 200
    `)
    .all(...params);

  const stats = db
    .prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'PASSED' THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'INVALIDATED' THEN 1 ELSE 0 END) AS invalidated
      FROM attempts
    `)
    .get();

  res.json({
    totalQuestionsInDb: totalQuestions,
    activeTests,
    stats: {
      total: stats.total || 0,
      passed: stats.passed || 0,
      failed: stats.failed || 0,
      invalidated: stats.invalidated || 0,
    },
    attempts,
  });
});

app.get('/api/admin/attempts/:attemptId', requireAdmin, (req, res) => {
  const { attemptId } = req.params;
  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  if (!attempt) {
    return res.status(404).json({ error: 'Tentativo non trovato.' });
  }

  const logs = db
    .prepare(`
      SELECT id, event_type, details, created_at
      FROM anticheat_logs
      WHERE attempt_id = ?
      ORDER BY created_at ASC, id ASC
    `)
    .all(attemptId);

  const answers = db
    .prepare(`
      SELECT
        aa.position,
        aa.given_answer,
        aa.is_correct,
        q.topic,
        q.text,
        q.img,
        q.correct_answer
      FROM attempt_answers aa
      JOIN questions q ON q.id = aa.question_id
      WHERE aa.attempt_id = ?
      ORDER BY aa.position ASC
    `)
    .all(attemptId)
    .map((row) => ({
      position: row.position,
      topic: TOPIC_LABELS[row.topic] || row.topic,
      text: row.text,
      img: row.img,
      givenAnswer: row.given_answer === null ? null : Boolean(row.given_answer),
      correctAnswer: Boolean(row.correct_answer),
      isCorrect: Boolean(row.is_correct),
    }));

  res.json({
    attempt,
    logs,
    answers,
    wrongAnswers: answers.filter((a) => !a.isCorrect),
  });
});

app.post('/api/admin/tests/regenerate', requireAdmin, (_req, res) => {
  const created = generateThreeTests();
  res.json({
    message: '3 nuove schede d\'esame generate con successo.',
    activeTests: created,
  });
});

app.delete('/api/admin/attempts/:attemptId', requireAdmin, (req, res) => {
  const { attemptId } = req.params;
  const info = db.prepare('DELETE FROM attempts WHERE id = ?').run(attemptId);
  if (info.changes === 0) {
    return res.status(404).json({ error: 'Tentativo non trovato.' });
  }
  res.json({ deleted: true });
});

// Fallback 404 for unknown API routes
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Endpoint non trovato.' });
});

app.listen(PORT, HOST, () => {
  console.log(`[SERVER] Simulatore Patente B attivo su http://${HOST}:${PORT}`);
  console.log(`[SERVER] Pannello Admin disponibile su http://${HOST}:${PORT}/admin`);
});

'use strict';

const crypto = require('crypto');
const { db } = require('./db');

/**
 * Official ministerial 30-question distribution across all 25 Patente B chapters.
 * 5 core chapters contribute 2 questions each (10), and the remaining 20 chapters
 * contribute 1 question each (20), totaling exactly 30 balanced questions per test.
 */
const CHAPTER_WEIGHTS = {
  'segnali-pericolo': 2,
  'segnali-divieto': 2,
  'segnali-obbligo': 2,
  'segnali-precedenza': 2,
  'precedenza-incroci': 2,
  'definizioni-generali-doveri-strada': 1,
  'segnaletica-orizzontale-ostacoli': 1,
  'semafori-vigili': 1,
  'segnali-indicazione': 1,
  'segnali-complementari-cantiere': 1,
  'pannelli-integrativi': 1,
  'limiti-di-velocita': 1,
  'distanza-di-sicurezza': 1,
  'norme-di-circolazione': 1,
  'sorpasso': 1,
  'fermata-sosta-arresto': 1,
  'norme-varie-autostrade-pannelli': 1,
  'luci-dispositivi-acustici': 1,
  'cinture-casco-sicurezza': 1,
  'patente-punti-documenti': 1,
  'incidenti-stradali-comportamenti': 1,
  'alcool-droga-primo-soccorso': 1,
  'responsabilita-civile-penale-e-assicurazione': 1,
  'consumi-ambiente-inquinamento': 1,
  'elementi-veicolo-manutenzione-comportamenti': 1,
};

const TOPIC_LABELS = {
  'definizioni-generali-doveri-strada': 'Definizioni generali e doveri sulla strada',
  'segnali-pericolo': 'Segnali di pericolo',
  'segnali-divieto': 'Segnali di divieto',
  'segnali-obbligo': 'Segnali di obbligo',
  'segnali-precedenza': 'Segnali di precedenza',
  'segnaletica-orizzontale-ostacoli': 'Segnaletica orizzontale e ostacoli',
  'semafori-vigili': 'Semafori e vigili',
  'segnali-indicazione': 'Segnali di indicazione',
  'segnali-complementari-cantiere': 'Segnali complementari e di cantiere',
  'pannelli-integrativi': 'Pannelli integrativi',
  'limiti-di-velocita': 'Limiti di velocità',
  'distanza-di-sicurezza': 'Distanza di sicurezza',
  'norme-di-circolazione': 'Norme di circolazione',
  'precedenza-incroci': 'Precedenza agli incroci',
  'sorpasso': 'Sorpasso',
  'fermata-sosta-arresto': 'Fermata, sosta e arresto',
  'norme-varie-autostrade-pannelli': 'Norme varie, autostrade e pannelli',
  'luci-dispositivi-acustici': 'Luci e dispositivi acustici',
  'cinture-casco-sicurezza': 'Cinture, casco e sicurezza',
  'patente-punti-documenti': 'Patente, punti e documenti',
  'incidenti-stradali-comportamenti': 'Incidenti stradali e comportamenti',
  'alcool-droga-primo-soccorso': 'Alcool, droga e primo soccorso',
  'responsabilita-civile-penale-e-assicurazione': 'Responsabilità civile, penale e assicurazione',
  'consumi-ambiente-inquinamento': 'Consumi, ambiente e inquinamento',
  'elementi-veicolo-manutenzione-comportamenti': 'Elementi del veicolo e manutenzione',
};

/**
 * Cryptographically fair Fisher-Yates shuffle.
 */
function shuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Pick `count` questions from a pool without reusing globally used IDs,
 * and preferring distinct subtopics/images within the same test.
 */
function pickFromTopic(pool, count, globalUsedIds) {
  const available = shuffle(pool.filter((q) => !globalUsedIds.has(q.id)));
  const picked = [];
  const usedSubtopics = new Set();
  const usedImages = new Set();

  // First pass: prefer distinct subtopic & distinct image
  for (const q of available) {
    if (picked.length === count) break;
    if (usedSubtopics.has(q.subtopic)) continue;
    if (q.img && usedImages.has(q.img)) continue;
    picked.push(q);
    usedSubtopics.add(q.subtopic);
    if (q.img) usedImages.add(q.img);
    globalUsedIds.add(q.id);
  }

  // Fallback pass if topic has fewer distinct subtopics
  if (picked.length < count) {
    for (const q of available) {
      if (picked.length === count) break;
      if (globalUsedIds.has(q.id)) continue;
      picked.push(q);
      globalUsedIds.add(q.id);
    }
  }

  return picked;
}

/**
 * Generate 3 new fixed, distinct, balanced 30-question tests (Test 1, Test 2, Test 3).
 * Older test versions remain in the DB so historical attempt reviews stay intact.
 */
function generateThreeTests() {
  const allQuestions = db.prepare('SELECT id, topic, subtopic, img FROM questions').all();
  const byTopic = new Map();
  for (const q of allQuestions) {
    if (!byTopic.has(q.topic)) byTopic.set(q.topic, []);
    byTopic.get(q.topic).push(q);
  }

  const maxVersionRow = db.prepare('SELECT COALESCE(MAX(version), 0) AS maxVer FROM tests').get();
  const nextVersion = maxVersionRow.maxVer + 1;
  const now = new Date().toISOString();
  const globalUsedIds = new Set();

  const deactivateStmt = db.prepare('UPDATE tests SET is_active = 0 WHERE is_active = 1');
  const insertTestStmt = db.prepare(`
    INSERT INTO tests (slot, version, is_active, created_at)
    VALUES (@slot, @version, 1, @created_at)
  `);
  const insertTestQStmt = db.prepare(`
    INSERT INTO test_questions (test_id, position, question_id)
    VALUES (@test_id, @position, @question_id)
  `);

  const createdTests = [];

  const runTx = db.transaction(() => {
    deactivateStmt.run();

    for (let slot = 1; slot <= 3; slot++) {
      const selected = [];
      for (const [topic, weight] of Object.entries(CHAPTER_WEIGHTS)) {
        const pool = byTopic.get(topic) || [];
        const picked = pickFromTopic(pool, weight, globalUsedIds);
        selected.push(...picked);
      }

      if (selected.length !== 30) {
        throw new Error(`Estrazione non valida per Test ${slot}: ottenute ${selected.length} domande invece di 30.`);
      }

      // Shuffle final order of the 30 questions inside the exam
      const ordered = shuffle(selected);

      const info = insertTestStmt.run({
        slot,
        version: nextVersion,
        created_at: now,
      });
      const testId = Number(info.lastInsertRowid);

      ordered.forEach((q, idx) => {
        insertTestQStmt.run({
          test_id: testId,
          position: idx + 1,
          question_id: q.id,
        });
      });

      createdTests.push({ id: testId, slot, version: nextVersion, created_at: now });
    }
  });

  runTx();
  console.log(`[GENERATOR] Generate 3 nuove schede d'esame (Versione ${nextVersion}, 90 domande distinte).`);
  return createdTests;
}

/**
 * Ensure 3 active tests exist on startup.
 */
function ensureActiveTests() {
  const active = db.prepare('SELECT id, slot, version, created_at FROM tests WHERE is_active = 1 ORDER BY slot ASC').all();
  if (active.length === 3) {
    return active;
  }
  return generateThreeTests();
}

module.exports = {
  CHAPTER_WEIGHTS,
  TOPIC_LABELS,
  generateThreeTests,
  ensureActiveTests,
};

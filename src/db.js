'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'patente.sqlite');
const DATASET_PATH = path.join(__dirname, '..', 'data', 'quizPatenteB2023.json');

// Ensure DB directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Initialize SQLite schema.
 */
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      subtopic TEXT NOT NULL,
      text TEXT NOT NULL,
      img TEXT,
      correct_answer INTEGER NOT NULL CHECK (correct_answer IN (0, 1))
    );

    CREATE INDEX IF NOT EXISTS idx_questions_topic ON questions(topic);

    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot INTEGER NOT NULL CHECK (slot IN (1, 2, 3)),
      version INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tests_active_slot ON tests(is_active, slot);

    CREATE TABLE IF NOT EXISTS test_questions (
      test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 30),
      question_id INTEGER NOT NULL REFERENCES questions(id),
      PRIMARY KEY (test_id, position)
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      test_id INTEGER NOT NULL REFERENCES tests(id),
      test_slot INTEGER NOT NULL,
      test_version INTEGER NOT NULL,
      candidate_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_seconds INTEGER,
      status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'PASSED', 'FAILED', 'INVALIDATED')),
      correct_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      unanswered_count INTEGER NOT NULL DEFAULT 0,
      violations_count INTEGER NOT NULL DEFAULT 0,
      invalidation_reason TEXT,
      ip_address TEXT,
      user_agent TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_attempts_slot ON attempts(test_slot);
    CREATE INDEX IF NOT EXISTS idx_attempts_started ON attempts(started_at DESC);

    CREATE TABLE IF NOT EXISTS attempt_answers (
      attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      question_id INTEGER NOT NULL REFERENCES questions(id),
      given_answer INTEGER CHECK (given_answer IN (0, 1) OR given_answer IS NULL),
      is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
      PRIMARY KEY (attempt_id, position)
    );

    CREATE TABLE IF NOT EXISTS anticheat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_anticheat_attempt ON anticheat_logs(attempt_id, created_at ASC);
  `);
}

/**
 * Seed questions from the official ministerial JSON dataset if table is empty.
 */
function seedQuestionsIfEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS count FROM questions').get();
  if (row.count > 0) {
    return row.count;
  }

  if (!fs.existsSync(DATASET_PATH)) {
    throw new Error(`Dataset non trovato in ${DATASET_PATH}`);
  }

  const raw = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
  const insertStmt = db.prepare(`
    INSERT INTO questions (topic, subtopic, text, img, correct_answer)
    VALUES (@topic, @subtopic, @text, @img, @correct_answer)
  `);

  let inserted = 0;
  const insertMany = db.transaction(() => {
    for (const [topic, subtopics] of Object.entries(raw)) {
      for (const [subtopic, items] of Object.entries(subtopics)) {
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          if (typeof item.q !== 'string' || !item.q.trim()) continue;
          if (typeof item.a !== 'boolean') continue;
          const imgPath = item.img ? String(item.img).trim() : null;
          insertStmt.run({
            topic,
            subtopic,
            text: item.q.trim(),
            img: imgPath,
            correct_answer: item.a ? 1 : 0,
          });
          inserted++;
        }
      }
    }
  });

  insertMany();
  console.log(`[DB] Importate ${inserted} domande ministeriali dal dataset ufficiale.`);
  return inserted;
}

module.exports = {
  db,
  initSchema,
  seedQuestionsIfEmpty,
};

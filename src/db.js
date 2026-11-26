'use strict';

/**
 * Database layer.
 *
 * Uses node-sqlite3-wasm (SQLite compiled to WebAssembly) so there is no native
 * compilation step: the same code runs locally and inside an Alpine container.
 *
 * Data lives in a real file on disk (DATA_DIR), so records survive server
 * restarts. Set DATA_DIR to a mounted persistent volume when one is available.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Database } = require('node-sqlite3-wasm');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'database'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.resolve(process.env.DB_FILE || path.join(DATA_DIR, 'hospital.db'));

const db = new Database(DB_FILE);
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS staff (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'staff',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS patients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name  TEXT NOT NULL,
  age        INTEGER NOT NULL,
  gender     TEXT NOT NULL,
  phone      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id    INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  token_number  TEXT NOT NULL,
  department    TEXT NOT NULL,
  priority      TEXT NOT NULL DEFAULT 'normal',
  status        TEXT NOT NULL DEFAULT 'waiting',
  visit_reason  TEXT,
  token_date    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  called_at     TEXT,
  closed_at     TEXT,
  called_by     INTEGER,
  called_by_name TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_number_date ON tokens (token_number, token_date);
CREATE INDEX IF NOT EXISTS idx_tokens_dept_status ON tokens (department, status);
CREATE INDEX IF NOT EXISTS idx_tokens_patient ON tokens (patient_id);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients (phone);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  sess       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
`;

db.exec(SCHEMA);

/**
 * express-session store backed by the same SQLite file, so a signed-in staff
 * member keeps their session across server restarts.
 */
function createSessionStore(session) {
  const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

  function expiryOf(sess) {
    const raw = sess && sess.cookie ? sess.cookie.expires : null;
    const parsed = raw ? new Date(raw).getTime() : NaN;
    return Number.isFinite(parsed) ? parsed : Date.now() + DEFAULT_TTL_MS;
  }

  class SqliteSessionStore extends session.Store {
    get(sid, cb) {
      try {
        const row = db.get('SELECT sess, expires_at FROM sessions WHERE sid = ?', [sid]);
        if (!row) return cb(null, null);
        if (Number(row.expires_at) <= Date.now()) {
          db.run('DELETE FROM sessions WHERE sid = ?', [sid]);
          return cb(null, null);
        }
        return cb(null, JSON.parse(row.sess));
      } catch (err) {
        return cb(err);
      }
    }

    set(sid, sess, cb) {
      try {
        db.run(
          `INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at`,
          [sid, JSON.stringify(sess), expiryOf(sess)]
        );
        return cb(null);
      } catch (err) {
        return cb(err);
      }
    }

    touch(sid, sess, cb) {
      try {
        db.run('UPDATE sessions SET expires_at = ? WHERE sid = ?', [expiryOf(sess), sid]);
        return cb(null);
      } catch (err) {
        return cb(err);
      }
    }

    destroy(sid, cb) {
      try {
        db.run('DELETE FROM sessions WHERE sid = ?', [sid]);
        return cb(null);
      } catch (err) {
        return cb(err);
      }
    }
  }

  const store = new SqliteSessionStore();
  store.pruneExpired = () => db.run('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
  return store;
}

module.exports = { db, DB_FILE, DATA_DIR, createSessionStore };

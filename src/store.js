'use strict';

/**
 * Domain queries for the hospital queue.
 *
 * Queue ordering rule (priority queue):
 *   1. emergency  (highest)
 *   2. urgent
 *   3. normal
 *   4. oldest registration first, then lowest id (FIFO within a priority band)
 */

const { db } = require('./db');

const DEPARTMENTS = {
  General: { prefix: 'G' },
  Emergency: { prefix: 'E' },
  Pediatrics: { prefix: 'P' },
  Cardiology: { prefix: 'C' },
};

const DEPARTMENT_NAMES = Object.keys(DEPARTMENTS);
const PRIORITIES = ['normal', 'urgent', 'emergency'];
const STATUSES = ['waiting', 'serving', 'completed', 'cancelled'];
const GENDERS = ['Male', 'Female', 'Other', 'Prefer not to say'];

const PRIORITY_RANK_SQL = `CASE t.priority
    WHEN 'emergency' THEN 0
    WHEN 'urgent' THEN 1
    ELSE 2
  END`;

const QUEUE_ORDER_SQL = `ORDER BY ${PRIORITY_RANK_SQL} ASC, t.created_at ASC, t.id ASC`;

function nowIso() {
  return new Date().toISOString();
}

/** Calendar day used for daily token numbering (UTC, so it is stable across hosts). */
function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ staff */

function findStaffByUsername(username) {
  return db.get(
    'SELECT id, username, password_hash, display_name, role, created_at FROM staff WHERE username = ?',
    [String(username)]
  );
}

function findStaffById(id) {
  return db.get(
    'SELECT id, username, display_name, role, created_at FROM staff WHERE id = ?',
    [Number(id)]
  );
}

function createStaff({ username, passwordHash, displayName = null, role = 'staff' }) {
  const result = db.run(
    'INSERT INTO staff (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)',
    [username, passwordHash, displayName, role, nowIso()]
  );
  return findStaffById(result.lastInsertRowid);
}

function countStaff() {
  return db.get('SELECT COUNT(*) AS c FROM staff').c;
}

/** Usernames and roles only — never password hashes. */
function listStaff() {
  return db.all('SELECT id, username, display_name, role, created_at FROM staff ORDER BY id ASC');
}

/**
 * Replace a stored password hash. Used only when the configured administrator
 * password changes; a matching password is never rewritten.
 */
function updateStaffPassword(id, passwordHash) {
  db.run('UPDATE staff SET password_hash = ? WHERE id = ?', [passwordHash, Number(id)]);
  return findStaffById(id);
}

/* --------------------------------------------------------------- patients */

function createPatient({ fullName, age, gender, phone }) {
  const result = db.run(
    'INSERT INTO patients (full_name, age, gender, phone, created_at) VALUES (?, ?, ?, ?, ?)',
    [fullName, age, gender, phone, nowIso()]
  );
  return findPatientById(result.lastInsertRowid);
}

function findPatientById(id) {
  const row = db.get('SELECT * FROM patients WHERE id = ?', [Number(id)]);
  return row ? mapPatient(row) : null;
}

function searchPatients(term, limit = 25) {
  const like = `%${String(term || '').trim()}%`;
  const rows = db.all(
    `SELECT * FROM patients
     WHERE full_name LIKE ? OR phone LIKE ?
     ORDER BY id DESC
     LIMIT ?`,
    [like, like, Number(limit)]
  );

  return rows.map((row) => {
    const patient = mapPatient(row);
    const latest = db.get(
      `SELECT * FROM tokens WHERE patient_id = ? ORDER BY id DESC LIMIT 1`,
      [row.id]
    );
    patient.lastToken = latest ? mapToken(latest, { includePatient: false }) : null;
    return patient;
  });
}

function patientHistory(patientId) {
  const patient = findPatientById(patientId);
  if (!patient) return null;
  const rows = db.all('SELECT * FROM tokens WHERE patient_id = ? ORDER BY id DESC', [Number(patientId)]);
  return { patient, visits: rows.map((row) => mapToken(row, { includePatient: false })) };
}

/* ----------------------------------------------------------------- tokens */

function mapPatient(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    age: row.age,
    gender: row.gender,
    phone: row.phone,
    createdAt: row.created_at,
  };
}

function mapToken(row, options = {}) {
  const { includePatient = false, includeReason = false } = options;
  const token = {
    id: row.id,
    tokenNumber: row.token_number,
    department: row.department,
    priority: row.priority,
    status: row.status,
    tokenDate: row.token_date,
    createdAt: row.created_at,
    calledAt: row.called_at || null,
    closedAt: row.closed_at || null,
  };

  if (row.status === 'waiting') {
    const waitedMs = Date.now() - new Date(row.created_at).getTime();
    token.waitingMinutes = Math.max(0, Math.round(waitedMs / 60000));
  }
  if (includeReason) token.visitReason = row.visit_reason || '';
  if (row.called_by_name) token.calledByName = row.called_by_name;

  if (includePatient) {
    token.patient = {
      id: row.patient_id,
      fullName: row.full_name,
      age: row.age,
      gender: row.gender,
      phone: row.phone,
    };
  }
  return token;
}

const TOKEN_SELECT = `
  SELECT t.*, p.full_name, p.age, p.gender, p.phone
  FROM tokens t
  JOIN patients p ON p.id = t.patient_id
`;

function findTokenById(id) {
  return db.get(`${TOKEN_SELECT} WHERE t.id = ?`, [Number(id)]);
}

/**
 * Allocate the next daily token number for a department (G-001, E-001, ...)
 * and insert it. Retries if a concurrent insert grabbed the same number.
 */
function createToken({ patientId, department, priority = 'normal', visitReason = '' }) {
  const date = todayKey();
  const prefix = DEPARTMENTS[department].prefix;

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const used = db.get(
      'SELECT COUNT(*) AS c FROM tokens WHERE department = ? AND token_date = ?',
      [department, date]
    ).c;
    const sequence = used + 1 + attempt;
    const tokenNumber = `${prefix}-${String(sequence).padStart(3, '0')}`;

    try {
      const result = db.run(
        `INSERT INTO tokens (patient_id, token_number, department, priority, status, visit_reason, token_date, created_at)
         VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?)`,
        [patientId, tokenNumber, department, priority, visitReason, date, nowIso()]
      );
      return mapToken(findTokenById(result.lastInsertRowid), {
        includePatient: true,
        includeReason: true,
      });
    } catch (err) {
      if (!/UNIQUE|constraint/i.test(err.message)) throw err;
    }
  }
  throw new Error('Unable to allocate a token number, please try again.');
}

/** Public queue view: token numbers only, never patient identity. */
function departmentQueue(department, options = {}) {
  const includePatient = Boolean(options.includePatient);
  const date = todayKey();
  const waitingRows = db.all(
    `${TOKEN_SELECT} WHERE t.department = ? AND t.token_date = ? AND t.status = 'waiting' ${QUEUE_ORDER_SQL}`,
    [department, date]
  );
  const servingRows = db.all(
    `${TOKEN_SELECT} WHERE t.department = ? AND t.token_date = ? AND t.status = 'serving'
     ORDER BY t.called_at DESC, t.id DESC`,
    [department, date]
  );

  const waiting = waitingRows.map((row) => mapToken(row, { includeReason: true, includePatient }));
  const serving = servingRows.map((row) => mapToken(row, { includeReason: true, includePatient }));

  const counts = db.get(
    `SELECT
       SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting,
       SUM(CASE WHEN status = 'serving' THEN 1 ELSE 0 END) AS serving,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
     FROM tokens WHERE department = ? AND token_date = ?`,
    [department, date]
  );

  return {
    department,
    date,
    waiting,
    serving: serving[0] || null,
    stats: {
      waiting: Number(counts.waiting || 0),
      serving: Number(counts.serving || 0),
      completed: Number(counts.completed || 0),
      cancelled: Number(counts.cancelled || 0),
    },
    updatedAt: nowIso(),
  };
}

function departmentSummary() {
  return DEPARTMENT_NAMES.map((department) => {
    const queue = departmentQueue(department);
    return {
      department,
      waiting: queue.stats.waiting,
      serving: queue.serving ? queue.serving.tokenNumber : null,
      stats: queue.stats,
    };
  });
}

/** Highest priority, then oldest waiting token in a department. */
function nextWaitingToken(department) {
  return db.get(
    `${TOKEN_SELECT} WHERE t.department = ? AND t.token_date = ? AND t.status = 'waiting' ${QUEUE_ORDER_SQL} LIMIT 1`,
    [department, todayKey()]
  );
}

function activeServingTokens(department) {
  return db.all(
    `${TOKEN_SELECT} WHERE t.department = ? AND t.token_date = ? AND t.status = 'serving'`,
    [department, todayKey()]
  );
}

function markServing(id, staff) {
  const timestamp = nowIso();
  db.run(
    `UPDATE tokens SET status = 'serving', called_at = ?, closed_at = NULL, called_by = ?, called_by_name = ?
     WHERE id = ?`,
    [timestamp, staff.id, staff.display_name || staff.username, Number(id)]
  );
  return mapToken(findTokenById(id), { includePatient: true, includeReason: true });
}

function updateStatus(id, status) {
  const timestamp = nowIso();
  const closing = status === 'completed' || status === 'cancelled';
  if (status === 'serving') {
    db.run('UPDATE tokens SET status = ?, called_at = COALESCE(called_at, ?), closed_at = NULL WHERE id = ?', [
      status,
      timestamp,
      Number(id),
    ]);
  } else if (closing) {
    db.run('UPDATE tokens SET status = ?, closed_at = ? WHERE id = ?', [status, timestamp, Number(id)]);
  } else {
    db.run('UPDATE tokens SET status = ?, closed_at = NULL WHERE id = ?', [status, Number(id)]);
  }
  return mapToken(findTokenById(id), { includePatient: true, includeReason: true });
}

function updatePriority(id, priority) {
  db.run('UPDATE tokens SET priority = ? WHERE id = ? AND status = ?', [priority, Number(id), 'waiting']);
  return mapToken(findTokenById(id), { includePatient: true, includeReason: true });
}

function healthCheck() {
  const row = db.get('SELECT COUNT(*) AS c FROM staff');
  return { ok: true, staff: row.c };
}

module.exports = {
  DEPARTMENTS,
  DEPARTMENT_NAMES,
  PRIORITIES,
  STATUSES,
  GENDERS,
  todayKey,
  nowIso,
  findStaffByUsername,
  findStaffById,
  createStaff,
  countStaff,
  createPatient,
  findPatientById,
  searchPatients,
  patientHistory,
  createToken,
  findTokenById,
  departmentQueue,
  departmentSummary,
  nextWaitingToken,
  activeServingTokens,
  markServing,
  updateStatus,
  updatePriority,
  healthCheck,
};

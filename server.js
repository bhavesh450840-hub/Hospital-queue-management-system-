'use strict';

/**
 * CareQueue — Hospital Queue Management System
 * Express + Socket.IO + SQLite server.
 *
 * Serves the existing HTML pages, exposes the JSON API documented in API.md and
 * broadcasts `queue:updated` over Socket.IO after every queue mutation.
 */

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const { db, DB_FILE, DATA_DIR, createSessionStore } = require('./src/db');
const store = require('./src/store');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const IS_PROD = process.env.NODE_ENV === 'production';
const BCRYPT_ROUNDS = 12;

/* ------------------------------------------------------------------ app */

const app = express();
app.disable('x-powered-by');
// The platform terminates TLS in front of us; needed for secure cookies.
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  serveClient: true,
  cors: { origin: false },
});

/** Session secret: environment variable, otherwise a generated secret kept on disk. */
function resolveSessionSecret() {
  const fromEnv = (process.env.SESSION_SECRET || '').trim();
  if (fromEnv.length >= 16) return fromEnv;

  const secretFile = path.join(DATA_DIR, '.session-secret');
  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {
    /* first run */
  }
  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  console.warn('[security] SESSION_SECRET not set — generated one at', secretFile);
  return generated;
}

const sessionStore = createSessionStore(session);

app.use(
  session({
    name: 'carequeue.sid',
    secret: resolveSessionSecret(),
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "form-action 'self'",
      "frame-ancestors 'self'",
      "base-uri 'self'",
    ].join('; ')
  );
  next();
});

/* ------------------------------------------------------------- helpers */

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, ...extra });
}

function requireStaff(req, res, next) {
  if (req.session && req.session.staff) return next();
  return fail(res, 401, 'Please sign in to continue.');
}

function broadcastQueue(department) {
  io.emit('queue:updated', { department, at: store.nowIso() });
}

function asText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Simple fixed-window rate limiter (no external dependency). */
function rateLimit({ windowMs, max, keyPrefix = '' }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs);
  if (typeof timer.unref === 'function') timer.unref();

  return (req, res, next) => {
    const key = `${keyPrefix}${req.ip}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      const retry = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      return fail(res, 429, `Too many attempts. Please try again in ${retry}s.`);
    }
    return next();
  };
}

const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, keyPrefix: 'login:' });
const registerLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 40, keyPrefix: 'register:' });

/* -------------------------------------------------------------- startup */

async function seedStaff() {
  const adminUsername = (process.env.ADMIN_USERNAME || '').trim();
  const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();

  if (adminUsername && adminPassword) {
    const existing = store.findStaffByUsername(adminUsername);
    if (!existing) {
      const passwordHash = await bcrypt.hash(adminPassword, BCRYPT_ROUNDS);
      store.createStaff({ username: adminUsername, passwordHash, displayName: adminUsername, role: 'admin' });
      console.log(`[auth] created admin account "${adminUsername}" from environment variables`);
    }
    return;
  }

  if (store.countStaff() === 0) {
    const passwordHash = await bcrypt.hash('staff123', BCRYPT_ROUNDS);
    store.createStaff({ username: 'staff', passwordHash, displayName: 'Demo Staff', role: 'staff' });
    console.warn(
      '[auth] no ADMIN_USERNAME/ADMIN_PASSWORD set — created demo login "staff" / "staff123". ' +
        'Set ADMIN_USERNAME and ADMIN_PASSWORD environment variables for a real deployment.'
    );
  }
}

/* ---------------------------------------------------------------- pages */

const PAGES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/display.html': 'display.html',
  '/login.html': 'login.html',
  '/dashboard.html': 'dashboard.html',
};

for (const [route, file] of Object.entries(PAGES)) {
  app.get(route, (req, res) => res.sendFile(path.join(ROOT, file)));
}

// Explicit mounts only: server sources, database files and .env are never served.
app.use('/css', express.static(path.join(ROOT, 'css'), { maxAge: '1h', extensions: ['css'] }));
app.use('/js', express.static(path.join(ROOT, 'js'), { maxAge: '1h', extensions: ['js'] }));

/* ------------------------------------------------------------------ API */

app.get('/api/health', (req, res) => {
  try {
    const dbStatus = store.healthCheck();
    res.json({ ok: true, status: 'ok', time: store.nowIso(), database: dbStatus.ok ? 'ok' : 'error' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Database unavailable.' });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    departments: store.DEPARTMENT_NAMES,
    priorities: store.PRIORITIES,
    genders: store.GENDERS,
  });
});

/* ---- auth ---- */

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const username = asText(req.body && req.body.username, 60);
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';

  if (!username || !password) return fail(res, 400, 'Username and password are required.');
  if (password.length > 200) return fail(res, 400, 'Invalid credentials.');

  const account = store.findStaffByUsername(username);
  // Always run a bcrypt comparison so a missing user is not detectable by timing.
  const hash = account ? account.password_hash : '$2a$12$invalidsaltinvalidsaltinvalidsaltinvalidsaltinvalidsa';
  const valid = await bcrypt.compare(password, hash);

  if (!account || !valid) return fail(res, 401, 'Invalid username or password.');

  req.session.regenerate((err) => {
    if (err) return fail(res, 500, 'Could not start a session. Please try again.');
    req.session.staff = {
      id: account.id,
      username: account.username,
      displayName: account.display_name || account.username,
      role: account.role,
    };
    return req.session.save((saveErr) => {
      if (saveErr) return fail(res, 500, 'Could not start a session. Please try again.');
      return res.json({ ok: true, user: req.session.staff });
    });
  });
});

app.post('/api/auth/logout', (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(() => {
    res.clearCookie('carequeue.sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session || !req.session.staff) return fail(res, 401, 'Not signed in.');
  return res.json({ ok: true, user: req.session.staff });
});

/* ---- patients ---- */

app.post('/api/patients', registerLimiter, (req, res) => {
  const body = req.body || {};
  const fullName = asText(body.fullName, 80);
  const gender = asText(body.gender, 20);
  const phone = asText(body.phone, 24);
  const department = asText(body.department, 30);
  const visitReason = asText(body.visitReason, 200);
  const ageRaw = body.age;
  const age = Number.parseInt(ageRaw, 10);

  const errors = [];
  if (fullName.length < 2) errors.push('Full name must be at least 2 characters.');
  if (!Number.isInteger(age) || age < 0 || age > 120) errors.push('Age must be a whole number between 0 and 120.');
  if (!store.GENDERS.includes(gender)) errors.push('Please select a valid gender.');
  if (phone.replace(/\D/g, '').length < 7 || phone.replace(/\D/g, '').length > 15) {
    errors.push('Please enter a valid contact number (7–15 digits).');
  }
  if (!store.DEPARTMENT_NAMES.includes(department)) errors.push('Please select a valid department.');
  if (visitReason.length < 3) errors.push('Please describe the visit reason (at least 3 characters).');

  if (errors.length) return fail(res, 400, errors[0], { errors });

  const patient = store.createPatient({ fullName, age, gender, phone });
  const token = store.createToken({ patientId: patient.id, department, visitReason });

  broadcastQueue(department);
  return res.status(201).json({ ok: true, patient, token });
});

app.get('/api/patients', requireStaff, (req, res) => {
  const term = asText(req.query.q, 80);
  if (term.length < 2) return fail(res, 400, 'Enter at least 2 characters to search.');
  return res.json({ ok: true, query: term, patients: store.searchPatients(term) });
});

app.get('/api/patients/:id/history', requireStaff, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid patient id.');
  const history = store.patientHistory(id);
  if (!history) return fail(res, 404, 'Patient not found.');
  return res.json({ ok: true, ...history });
});

/* ---- queue ---- */

app.get('/api/queue', (req, res) => {
  const requested = asText(req.query.department, 30);

  if (!requested || requested.toLowerCase() === 'all') {
    return res.json({ ok: true, departments: store.departmentSummary(), updatedAt: store.nowIso() });
  }

  const department = store.DEPARTMENT_NAMES.find(
    (name) => name.toLowerCase() === requested.toLowerCase()
  );
  if (!department) return fail(res, 400, 'Unknown department.');

  const queue = store.departmentQueue(department);
  return res.json({
    ok: true,
    ...queue,
    // Public view: token numbers only, never patient names or contact details.
    waiting: queue.waiting.map(({ id, tokenNumber, priority, status, waitingMinutes }) => ({
      id,
      tokenNumber,
      priority,
      status,
      waitingMinutes,
    })),
    serving: queue.serving
      ? {
          id: queue.serving.id,
          tokenNumber: queue.serving.tokenNumber,
          priority: queue.serving.priority,
          calledAt: queue.serving.calledAt,
        }
      : null,
  });
});

/** Staff-only view of a department queue, including patient details. */
app.get('/api/queue/detail', requireStaff, (req, res) => {
  const department = asText(req.query.department, 30);
  if (!store.DEPARTMENT_NAMES.includes(department)) return fail(res, 400, 'Please select a valid department.');
  const queue = store.departmentQueue(department, { includePatient: true });
  return res.json({ ok: true, ...queue });
});

app.post('/api/queue/next', requireStaff, (req, res) => {
  const department = asText(req.body && req.body.department, 30);
  if (!store.DEPARTMENT_NAMES.includes(department)) return fail(res, 400, 'Please select a valid department.');

  const staff = req.session.staff;
  const previous = store.activeServingTokens(department);
  previous.forEach((token) => store.updateStatus(token.id, 'completed'));

  const next = store.nextWaitingToken(department);
  if (!next) {
    broadcastQueue(department);
    return fail(res, 409, 'No patients are waiting in this department.', {
      department,
      completed: previous.map((token) => token.token_number),
    });
  }

  const called = store.markServing(next.id, staff);
  broadcastQueue(department);

  return res.json({
    ok: true,
    department,
    called,
    completed: previous.map((token) => token.token_number),
  });
});

app.patch('/api/queue/:id/status', requireStaff, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const status = asText(req.body && req.body.status, 20);

  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid token id.');
  if (!store.STATUSES.includes(status)) return fail(res, 400, 'Invalid status.');

  const existing = store.findTokenById(id);
  if (!existing) return fail(res, 404, 'Token not found.');

  const updated = store.updateStatus(id, status);
  broadcastQueue(updated.department);
  return res.json({ ok: true, token: updated });
});

app.patch('/api/queue/:id/priority', requireStaff, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const priority = asText(req.body && req.body.priority, 20);

  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid token id.');
  if (!store.PRIORITIES.includes(priority)) return fail(res, 400, 'Invalid priority.');

  const existing = store.findTokenById(id);
  if (!existing) return fail(res, 404, 'Token not found.');
  if (existing.status !== 'waiting') return fail(res, 409, 'Priority can only be changed for waiting tokens.');

  const updated = store.updatePriority(id, priority);
  broadcastQueue(updated.department);
  return res.json({ ok: true, token: updated });
});

/* ---- fallbacks ---- */

app.use('/api', (req, res) => fail(res, 404, 'Endpoint not found.'));
app.use((req, res) => res.status(404).type('text/plain').send('404 — Page not found'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err && err.message);
  if (res.headersSent) return;
  const status = err && err.status ? err.status : 500;
  if (req.originalUrl.startsWith('/api/')) {
    return fail(res, status, status === 500 ? 'Something went wrong. Please try again.' : err.message);
  }
  return res.status(status).type('text/plain').send('Something went wrong.');
});

/* --------------------------------------------------------------- sockets */

io.on('connection', (socket) => {
  socket.emit('server:hello', { at: store.nowIso() });
});

/* ---------------------------------------------------------------- start */

seedStaff()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`CareQueue listening on http://${HOST}:${PORT}`);
      console.log(`SQLite database: ${DB_FILE}`);
    });
  })
  .catch((err) => {
    console.error('[fatal] startup failed:', err);
    process.exit(1);
  });

const shutdown = () => {
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, server, io };

'use strict';

/**
 * End-to-end smoke test for the CareQueue backend.
 *
 * Starts a real server against a throwaway SQLite directory and verifies:
 * health, patient registration, validation, public privacy of the queue,
 * auth guards, staff login, priority ordering, call-next, status updates,
 * patient search/history, Socket.IO broadcasts and restart persistence.
 *
 * Run with: npm test
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 4555);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carequeue-test-'));
const BASE = `http://127.0.0.1:${PORT}`;

const ADMIN = { username: 'nurse', password: 'TestPass123!' };
const PATIENT_ONE = {
  fullName: 'Alice Fictional',
  age: 34,
  gender: 'Female',
  phone: '9876543210',
  department: 'General',
  visitReason: 'Fever and headache',
};
const PATIENT_TWO = {
  fullName: 'Bob Fictional',
  age: 61,
  gender: 'Male',
  phone: '9123456780',
  department: 'General',
  visitReason: 'Chest discomfort',
};

let child = null;
let cookie = '';
let failures = 0;
let passes = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(status, name, detail) {
  if (status === 'PASS') passes += 1;
  else failures += 1;
  console.log(`${status === 'PASS' ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function step(name, fn) {
  try {
    await fn();
    log('PASS', name);
  } catch (err) {
    log('FAIL', name, err.message);
  }
}

async function startServer() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      NODE_ENV: 'production',
      SESSION_SECRET: 'test-session-secret-value-1234567890',
      ADMIN_USERNAME: ADMIN.username,
      ADMIN_PASSWORD: ADMIN.password,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not ready yet */
    }
    await sleep(250);
  }
  throw new Error('Server did not become ready in time');
}

async function stopServer() {
  if (!child) return;
  const dying = child;
  child = null;
  await new Promise((resolve) => {
    dying.once('exit', resolve);
    dying.kill('SIGTERM');
    setTimeout(() => {
      if (!dying.killed) dying.kill('SIGKILL');
      resolve();
    }, 4000).unref();
  });
  await sleep(300);
}

function api(pathname, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  return fetch(`${BASE}${pathname}`, { ...options, headers });
}

async function json(pathname, options) {
  const res = await api(pathname, options);
  const body = await res.json().catch(() => null);
  return { res, body };
}

async function main() {
  await startServer();

  await step('GET /api/health reports ok', async () => {
    const { res, body } = await json('/api/health');
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.database, 'ok');
  });

  await step('Pages are served by the backend', async () => {
    for (const page of ['/', '/display.html', '/login.html', '/dashboard.html', '/css/styles.css', '/js/register.js']) {
      const res = await fetch(`${BASE}${page}`);
      assert.equal(res.status, 200, `${page} returned ${res.status}`);
    }
  });

  await step('Socket.IO client library is served', async () => {
    const res = await fetch(`${BASE}/socket.io/socket.io.js`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /socket/i);
  });

  await step('Server sources and env are not publicly served', async () => {
    for (const file of ['/server.js', '/src/db.js', '/.env', '/package.json']) {
      const res = await fetch(`${BASE}${file}`);
      assert.equal(res.status, 404, `${file} should not be served`);
    }
  });

  let firstToken = null;
  let firstPatientId = null;

  await step('Patient registration returns a daily token', async () => {
    const { res, body } = await json('/api/patients', { method: 'POST', body: JSON.stringify(PATIENT_ONE) });
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.token.department, 'General');
    assert.match(body.token.tokenNumber, /^G-\d{3}$/);
    assert.equal(body.token.status, 'waiting');
    firstToken = body.token;
    firstPatientId = body.patient.id;
  });

  await step('Invalid registration is rejected with a useful message', async () => {
    const { res, body } = await json('/api/patients', {
      method: 'POST',
      body: JSON.stringify({ ...PATIENT_ONE, age: 500, department: 'Dentistry' }),
    });
    assert.equal(res.status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.error.length > 5);
  });

  await step('Public queue exposes tokens but not patient identity', async () => {
    const { res, body } = await json('/api/queue?department=General');
    assert.equal(res.status, 200);
    assert.equal(body.stats.waiting, 1);
    assert.equal(body.waiting[0].tokenNumber, firstToken.tokenNumber);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('Alice'), 'patient name leaked to public queue');
    assert.ok(!serialized.includes('9876543210'), 'phone leaked to public queue');
  });

  await step('Protected endpoints reject anonymous callers', async () => {
    const search = await json('/api/patients?q=Alice');
    assert.equal(search.res.status, 401);
    const detail = await json('/api/queue/detail?department=General');
    assert.equal(detail.res.status, 401);
    const next = await json('/api/queue/next', { method: 'POST', body: JSON.stringify({ department: 'General' }) });
    assert.equal(next.res.status, 401);
    const me = await json('/api/auth/me');
    assert.equal(me.res.status, 401);
  });

  await step('Wrong password is rejected', async () => {
    const { res, body } = await json('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: ADMIN.username, password: 'wrong-password' }),
    });
    assert.equal(res.status, 401);
    assert.equal(body.ok, false);
  });

  await step('Staff login works and sets a session cookie', async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(ADMIN),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.user.username, ADMIN.username);
    const setCookie = res.headers.get('set-cookie') || '';
    assert.match(setCookie, /carequeue\.sid=/);
    assert.match(setCookie, /HttpOnly/i);
    cookie = setCookie.split(';')[0];
  });

  await step('Session identifies the signed-in staff member', async () => {
    const { res, body } = await json('/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(body.user.username, ADMIN.username);
  });

  let secondTokenId = null;

  await step('Second patient joins the same queue', async () => {
    const { res, body } = await json('/api/patients', { method: 'POST', body: JSON.stringify(PATIENT_TWO) });
    assert.equal(res.status, 201);
    assert.equal(body.token.tokenNumber, 'G-002');
    secondTokenId = body.token.id;
  });

  await step('Priority update reorders the queue (emergency first)', async () => {
    const patch = await json(`/api/queue/${secondTokenId}/priority`, {
      method: 'PATCH',
      body: JSON.stringify({ priority: 'emergency' }),
    });
    assert.equal(patch.res.status, 200, JSON.stringify(patch.body));
    assert.equal(patch.body.token.priority, 'emergency');

    const { body } = await json('/api/queue?department=General');
    assert.equal(body.waiting[0].tokenNumber, 'G-002');
    assert.equal(body.waiting[1].tokenNumber, 'G-001');
  });

  await step('Staff queue detail includes patient names', async () => {
    const { res, body } = await json('/api/queue/detail?department=General');
    assert.equal(res.status, 200);
    assert.equal(body.waiting[0].patient.fullName, PATIENT_TWO.fullName);
    assert.equal(body.waiting[0].patient.phone, PATIENT_TWO.phone);
  });

  await step('Socket.IO broadcasts queue:updated on registration', async () => {
    const socket = io(BASE, { transports: ['websocket', 'polling'], reconnection: false });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no queue:updated event received')), 8000);
        socket.on('connect', () => {
          json('/api/patients', {
            method: 'POST',
            body: JSON.stringify({ ...PATIENT_ONE, fullName: 'Carol Fictional', phone: '9000000001' }),
          }).catch(() => {});
        });
        socket.on('queue:updated', (payload) => {
          clearTimeout(timer);
          try {
            assert.equal(payload.department, 'General');
          } catch (err) {
            return reject(err);
          }
          return resolve();
        });
        socket.on('connect_error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } finally {
      socket.close();
    }
  });

  await step('Call next serves the highest-priority waiting token', async () => {
    const { res, body } = await json('/api/queue/next', {
      method: 'POST',
      body: JSON.stringify({ department: 'General' }),
    });
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.called.tokenNumber, 'G-002');
    assert.equal(body.called.status, 'serving');

    const queue = await json('/api/queue?department=General');
    assert.equal(queue.body.serving.tokenNumber, 'G-002');
  });

  await step('Calling next again completes the previous token', async () => {
    const { res, body } = await json('/api/queue/next', {
      method: 'POST',
      body: JSON.stringify({ department: 'General' }),
    });
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(body.completed, ['G-002']);
    assert.equal(body.called.tokenNumber, 'G-001');
  });

  await step('Empty department returns a clear 409', async () => {
    const { res, body } = await json('/api/queue/next', {
      method: 'POST',
      body: JSON.stringify({ department: 'Cardiology' }),
    });
    assert.equal(res.status, 409);
    assert.match(body.error, /waiting/i);
  });

  await step('Token status can be completed', async () => {
    const before = await json('/api/queue?department=General');
    const { res, body } = await json(`/api/queue/${firstToken.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });
    assert.equal(res.status, 200);
    assert.equal(body.token.status, 'completed');

    const queue = await json('/api/queue?department=General');
    assert.equal(queue.body.stats.completed, before.body.stats.completed + 1);
  });

  await step('Invalid status values are rejected', async () => {
    const { res } = await json(`/api/queue/${firstToken.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'teleported' }),
    });
    assert.equal(res.status, 400);
  });

  await step('Patient search finds records for staff', async () => {
    const { res, body } = await json('/api/patients?q=Alice');
    assert.equal(res.status, 200);
    assert.equal(body.patients.length, 1);
    assert.equal(body.patients[0].fullName, PATIENT_ONE.fullName);
    assert.equal(body.patients[0].lastToken.tokenNumber, firstToken.tokenNumber);
  });

  await step('Patient visit history is available', async () => {
    const { res, body } = await json(`/api/patients/${firstPatientId}/history`);
    assert.equal(res.status, 200);
    assert.equal(body.visits.length, 1);
    assert.equal(body.visits[0].tokenNumber, firstToken.tokenNumber);
  });

  await step('Logout ends the session', async () => {
    const res = await api('/api/auth/logout', { method: 'POST' });
    assert.equal(res.status, 200);
    cookie = '';
    const me = await json('/api/auth/me');
    assert.equal(me.res.status, 401);
  });

  await step('Records survive a server restart', async () => {
    await stopServer();
    await startServer();
    const { res, body } = await json('/api/queue?department=General');
    assert.equal(res.status, 200);
    assert.ok(body.stats.completed >= 1, 'completed token missing after restart');
    assert.equal(body.date, new Date().toISOString().slice(0, 10));
  });

  await step('Staff account survives a server restart', async () => {
    const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie') || '';
    cookie = setCookie.split(';')[0];
  });

  await stopServer();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('Test run aborted:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServer();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

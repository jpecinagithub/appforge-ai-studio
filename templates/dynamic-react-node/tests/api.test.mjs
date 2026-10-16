/**
 * Full-stack API tests for the dynamic template (contract §9.16).
 * Boots the built backend (backend/dist) on an ephemeral port with a
 * throwaway SQLite database, then exercises the whole auth + CRUD flow:
 * register → session recovery → protected route → profile → CRUD →
 * cross-user isolation → logout → 401.
 *
 * Run from the project root:  npm test
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath (not .pathname): on Windows, .pathname yields /C:/... and
// join() then produces broken paths like C:\C:\Users\....
const ROOT = fileURLToPath(new URL('..', import.meta.url));

let base;
let child;

function req(path, { method = 'GET', body, cookie, contentType = false } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const headers = {};
    if (body !== undefined || contentType)
      headers['Content-Type'] = 'application/json';
    if (cookie) headers['Cookie'] = cookie;
    import('node:http').then(({ request }) => {
      const r = request(
        url,
        { method, headers },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              cookie: cookieHeader(res.headers['set-cookie']),
              json: data ? JSON.parse(data) : null,
            }),
          );
        },
      );
      r.on('error', reject);
      if (body !== undefined) r.write(JSON.stringify(body));
      r.end();
    });
  });
}

function cookieHeader(setCookie) {
  if (!setCookie || setCookie.length === 0) return null;
  // Keep only the name=value pair of the first cookie.
  return setCookie[0].split(';')[0];
}

before(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'appforge-dyn-test-'));
  child = spawn('node', [join(ROOT, 'backend', 'dist', 'server.js')], {
    env: {
      ...process.env,
      PORT: '0',
      NODE_ENV: 'test',
      DB_PATH: join(dataDir, 'app.db'),
      PUBLIC_PATH: '/',
      SESSION_TTL_DAYS: '7',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('backend did not start')), 30_000);
    let out = '';
    child.stdout.on('data', (c) => {
      out += c.toString();
      const m = out.match(/ready port=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(parseInt(m[1], 10));
      }
    });
    child.stderr.on('data', (c) => process.stderr.write(`[backend] ${c}`));
    child.on('exit', (code) => reject(new Error(`backend exited: ${code}`)));
  });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (child && !child.killed) child.kill('SIGTERM');
});

describe('health', () => {
  test('GET /healthz is public and reports version', async () => {
    const res = await req('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.match(res.json.version, /^\d+\.\d+\.\d+/);
  });
});

describe('auth flow', () => {
  let cookieA;

  test('register creates a user and sets an HttpOnly session cookie', async () => {
    const res = await req('/api/auth/register', {
      method: 'POST',
      body: { email: 'a@example.com', password: 'supersecret123' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.user.email, 'a@example.com');
    assert.ok(!('password_hash' in res.json.user));
    assert.ok(res.cookie, 'expected a session cookie');
    const setCookie = res.headers['set-cookie'][0];
    assert.match(setCookie, /httponly/i);
    assert.match(setCookie, /samesite=lax/i);
    cookieA = res.cookie;
  });

  test('register rejects a duplicate email with 409', async () => {
    const res = await req('/api/auth/register', {
      method: 'POST',
      body: { email: 'a@example.com', password: 'supersecret123' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'CONFLICT');
  });

  test('register rejects short passwords with 400', async () => {
    const res = await req('/api/auth/register', {
      method: 'POST',
      body: { email: 'b@example.com', password: 'short' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'VALIDATION_ERROR');
  });

  test('login with wrong password returns 401 (no enumeration)', async () => {
    const res = await req('/api/auth/login', {
      method: 'POST',
      body: { email: 'a@example.com', password: 'wrongpassword!' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, 'UNAUTHORIZED');
  });

  test('session is recovered via cookie (page reload)', async () => {
    const res = await req('/api/auth/me', { cookie: cookieA });
    assert.equal(res.status, 200);
    assert.equal(res.json.user.email, 'a@example.com');
  });

  test('protected route without session returns 401', async () => {
    const res = await req('/api/todos');
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, 'UNAUTHORIZED');
  });

  test('profile endpoint returns the current user', async () => {
    const res = await req('/api/users/me', { cookie: cookieA });
    assert.equal(res.status, 200);
    assert.equal(res.json.user.email, 'a@example.com');
  });
});

describe('todos CRUD + isolation', () => {
  let cookieA;
  let cookieB;
  let todoId;

  before(async () => {
    const ra = await req('/api/auth/register', {
      method: 'POST',
      body: { email: 'crud-a@example.com', password: 'supersecret123' },
    });
    cookieA = ra.cookie;
    const rb = await req('/api/auth/register', {
      method: 'POST',
      body: { email: 'crud-b@example.com', password: 'supersecret123' },
    });
    cookieB = rb.cookie;
  });

  test('create → get → list → update → delete', async () => {
    const created = await req('/api/todos', {
      method: 'POST',
      body: { title: 'Buy milk' },
      cookie: cookieA,
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.title, 'Buy milk');
    assert.equal(created.json.done, false);
    todoId = created.json.id;

    const listed = await req('/api/todos', { cookie: cookieA });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.items.length, 1);

    const updated = await req(`/api/todos/${todoId}`, {
      method: 'PATCH',
      body: { done: true },
      cookie: cookieA,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.done, true);

    const deleted = await req(`/api/todos/${todoId}`, {
      method: 'DELETE',
      cookie: cookieA,
    });
    assert.equal(deleted.status, 200);

    const gone = await req(`/api/todos/${todoId}`, { cookie: cookieA });
    assert.equal(gone.status, 404);
  });

  test('user B cannot see or touch user A data (404, not 403)', async () => {
    const created = await req('/api/todos', {
      method: 'POST',
      body: { title: 'secret task' },
      cookie: cookieA,
    });
    const id = created.json.id;

    for (const [method, body] of [
      ['GET', undefined],
      ['PATCH', { done: true }],
      ['DELETE', undefined],
    ]) {
      const res = await req(`/api/todos/${id}`, { method, body, cookie: cookieB });
      assert.equal(res.status, 404, `${method} should be 404`);
      assert.equal(res.json.error.code, 'NOT_FOUND');
    }
    const listed = await req('/api/todos', { cookie: cookieB });
    assert.equal(listed.json.items.length, 0);
  });
});

describe('logout', () => {  test('logout revokes the session immediately', async () => {
    const reg = await req('/api/auth/register', {
      method: 'POST',
      body: { email: 'bye@example.com', password: 'supersecret123' },
    });
    const cookie = reg.cookie;
    const before = await req('/api/auth/me', { cookie });
    assert.equal(before.status, 200);

    const out = await req('/api/auth/logout', { method: 'POST', cookie });
    assert.equal(out.status, 200);

    const afterLogout = await req('/api/auth/me', { cookie });
    assert.equal(afterLogout.status, 401);
    assert.equal(afterLogout.json.error.code, 'UNAUTHORIZED');
  });
});

describe('bodyless requests with Content-Type', () => {
  test('DELETE and POST logout do not 400 on empty JSON body', async () => {
    // Regression: browsers may send Content-Type: application/json with no
    // body (fetch default in the template). Fastify must not 400.
    const reg = await req('/api/auth/register', {
      method: 'POST',
      body: { email: 'ct@example.com', password: 'supersecret123' },
    });
    const cookie = reg.cookie;
    const created = await req('/api/todos', {
      method: 'POST',
      body: { title: 'temp' },
      cookie,
    });
    const del = await req(`/api/todos/${created.json.id}`, {
      method: 'DELETE',
      cookie,
      contentType: true,
    });
    assert.equal(del.status, 200);

    const out = await req('/api/auth/logout', {
      method: 'POST',
      cookie,
      contentType: true,
    });
    assert.equal(out.status, 200);
  });
});

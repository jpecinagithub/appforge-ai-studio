/**
 * Pilot auth-flow check (contract §9.16 step 7).
 * Runs against a live app container over the app network.
 * Usage: APP_URL=http://<container>:8080 node scripts/pilot-auth-flow.mjs
 * Emails are unique per run (Date.now) so it is re-runnable.
 * Exits 0 only if every check passes.
 */
const BASE = process.env.APP_URL || 'http://appforge-pilot-verify:8080';
const SUF = Date.now();
const EMAIL1 = `oracle-${SUF}@test.local`;
const EMAIL2 = `otro-${SUF}@test.local`;
let cookie = '';

async function req(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, setCookie: sc };
}

function check(name, cond, detail = '') {
  console.log(
    (cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' -- ' + detail : ''),
  );
  if (!cond) process.exitCode = 1;
}

// 1. Register user 1.
let r = await req('/api/auth/register', {
  method: 'POST',
  body: { email: EMAIL1, password: 'TestPassword123' },
});
check('register 201', r.status === 201, `status=${r.status}`);
check(
  'cookie HttpOnly+Secure+SameSite=Lax',
  /httponly/i.test(r.setCookie || '') &&
    /secure/i.test(r.setCookie || '') &&
    /samesite=lax/i.test(r.setCookie || ''),
  r.setCookie || 'none',
);
const userCookie = cookie;

// 2. Session recovery.
r = await req('/api/auth/me');
check(
  'me 200 + email',
  r.status === 200 && r.json && r.json.user && r.json.user.email === EMAIL1,
  `status=${r.status}`,
);

// 3. CRUD.
r = await req('/api/todos', {
  method: 'POST',
  body: { title: 'Probar Oracle' },
});
check('create todo 201', r.status === 201, `status=${r.status}`);
const id = r.json && r.json.id;
r = await req('/api/todos');
check(
  'list 1 item',
  r.status === 200 && r.json && r.json.items && r.json.items.length === 1,
  `status=${r.status}`,
);

// 4. Isolation: user 2 asks for user 1's todo -> 404.
cookie = '';
r = await req('/api/auth/register', {
  method: 'POST',
  body: { email: EMAIL2, password: 'TestPassword123' },
});
check('register user2 201', r.status === 201, `status=${r.status}`);
r = await req(`/api/todos/${id}`, { method: 'GET' });
check('aislamiento: otro usuario -> 404', r.status === 404, `status=${r.status}`);

// 5. Logout revokes user 1's session.
cookie = userCookie;
r = await req('/api/auth/logout', { method: 'POST' });
check('logout 200', r.status === 200, `status=${r.status}`);
r = await req('/api/auth/me');
check('me tras logout -> 401', r.status === 401, `status=${r.status}`);

console.log(process.exitCode ? 'FLOW: FAIL' : 'FLOW: ALL PASS');

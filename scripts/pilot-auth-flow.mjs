/**
 * Pilot auth-flow check (contract §9.16 step 7).
 * Runs against a live app container over the app network.
 * Usage: APP_URL=http://<container>:8080 node scripts/pilot-auth-flow.mjs
 * Exits 0 only if every check passes.
 */
const BASE = process.env.APP_URL || 'http://appforge-pilot-verify:8080';
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

let r = await req('/api/auth/register', {
  method: 'POST',
  body: { email: 'oracle@test.local', password: 'TestPassword123' },
});
check('register 201', r.status === 201);
check(
  'cookie HttpOnly+Secure+SameSite=Lax',
  /httponly/i.test(r.setCookie || '') &&
    /secure/i.test(r.setCookie || '') &&
    /samesite=lax/i.test(r.setCookie || ''),
  r.setCookie || 'none',
);
const userCookie = cookie;

r = await req('/api/auth/me');
check(
  'me 200 + email',
  r.status === 200 && r.json.user.email === 'oracle@test.local',
);

r = await req('/api/todos', {
  method: 'POST',
  body: { title: 'Probar Oracle' },
});
check('create todo 201', r.status === 201);
const id = r.json.id;

r = await req('/api/todos');
check('list 1 item', r.status === 200 && r.json.items.length === 1);

// Second user asks for the first user's todo -> 404 (isolation).
cookie = '';
r = await req('/api/auth/register', {
  method: 'POST',
  body: { email: 'otro@test.local', password: 'TestPassword123' },
});
r = await req('/api/todos/' + id, { method: 'GET' });
check('aislamiento: otro usuario -> 404', r.status === 404, `status=${r.status}`);

// Logout of the first user's session -> revoked.
cookie = userCookie;
r = await req('/api/auth/logout', { method: 'POST' });
check('logout 200', r.status === 200);
r = await req('/api/auth/me');
check('me tras logout -> 401', r.status === 401, `status=${r.status}`);

console.log(process.exitCode ? 'FLOW: FAIL' : 'FLOW: ALL PASS');

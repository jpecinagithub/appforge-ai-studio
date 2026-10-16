/**
 * Shared fixture for Fase 5B preview tests: a fake backend (node:http, no
 * dependencies) mimicking the template's observable contract — env-driven
 * PORT/HOST/DB_PATH/SESSION_COOKIE_NAME/PUBLIC_PATH, /healthz, the auth API
 * (/api/auth/register|login|logout|me, /api/todos) and a minimal HTML shell
 * with the data-testid selectors the authenticated flow drives.
 */

export const FAKE_SERVER = `
import http from 'node:http';
import fs from 'node:fs';
const PORT = Number(process.env.PORT || '0');
const HOST = process.env.HOST || '0.0.0.0';
const COOKIE = process.env.SESSION_COOKIE_NAME || 'af_session';
const PUBLIC_PATH = process.env.PUBLIC_PATH || '/';
const MODE = process.env.FAKE_PREVIEW_MODE || 'ok';
const users = new Map();   // email -> { id, email, password }
const sessions = new Map();// token -> userId
const todos = new Map();   // id -> { id, userId, title }
let nextId = 1;
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function setSession(res, userId) {
  const token = 'tok-' + (nextId++);
  sessions.set(token, userId);
  res.setHeader('Set-Cookie', COOKIE + '=' + token + '; Path=' + PUBLIC_PATH + '; HttpOnly; SameSite=Lax');
}
function me(req) {
  const token = parseCookies(req)[COOKIE];
  const userId = token && sessions.get(token);
  if (!userId) return null;
  for (const u of users.values()) if (u.id === userId) return u;
  return null;
}
const HTML = '<!doctype html><html><body>' +
  '<div data-testid="auth-screen"><h1>Sign in</h1>' +
  '<button data-testid="auth-toggle-mode">toggle</button>' +
  '<input data-testid="auth-email" id="e" />' +
  '<input data-testid="auth-password" id="p" type="password" />' +
  '<button data-testid="auth-submit" id="s">go</button>' +
  '<p data-testid="auth-error" id="err"></p></div>' +
  '<div data-testid="tasks-screen" id="tasks" style="display:none">' +
  '<p data-testid="user-email" id="ue"></p>' +
  '<button data-testid="logout-button" id="lo">out</button>' +
  '<input data-testid="new-todo-input" id="ni" />' +
  '<button data-testid="add-todo-button" id="ab">add</button>' +
  '<ul data-testid="todo-list" id="tl"></ul></div>' +
  '<script>' +
  'const base = location.pathname.replace(/\\\\/[^\\\\/]*$/, "/");' +
  'async function api(p, opts) { const r = await fetch(base.replace(/\\\\/$/,"") + p, opts); const j = await r.json().catch(()=>null); return { status: r.status, body: j }; }' +
  'let mode = "login";' +
  'document.querySelector("[data-testid=auth-toggle-mode]").onclick = () => { mode = mode === "login" ? "register" : "login"; };' +
  'document.querySelector("[data-testid=auth-submit]").onclick = async () => {' +
  '  const email = document.getElementById("e").value, password = document.getElementById("p").value;' +
  '  const { status, body } = await api("/api/auth/" + mode, { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ email, password }) });' +
  '  if (status === 200 || status === 201) { showTasks(body.user.email); }' +
  '  else { document.getElementById("err").textContent = "error"; }' +
  '};' +
  'async function showTasks(email) {' +
  '  document.querySelector("[data-testid=auth-screen]").style.display = "none";' +
  '  document.getElementById("tasks").style.display = "block";' +
  '  document.getElementById("ue").textContent = email;' +
  '  await refresh();' +
  '}' +
  'async function refresh() {' +
  '  const { body } = await api("/api/todos");' +
  '  const tl = document.getElementById("tl"); tl.innerHTML = "";' +
  '  for (const t of (body.items || [])) { const li = document.createElement("li"); li.setAttribute("data-testid","todo-item"); const sp = document.createElement("span"); sp.setAttribute("data-testid","todo-title"); sp.textContent = t.title; li.appendChild(sp); tl.appendChild(li); }' +
  '}' +
  'document.getElementById("ab").onclick = async () => {' +
  '  const title = document.getElementById("ni").value;' +
  '  await api("/api/todos", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ title }) });' +
  '  document.getElementById("ni").value = "";' +
  '  await refresh();' +
  '};' +
  'document.getElementById("lo").onclick = async () => { await api("/api/auth/logout", { method: "POST" }); location.reload(); };' +
  '(async () => { const { status, body } = await api("/api/auth/me"); if (status === 200) showTasks(body.user.email); })();' +
  '</scr' + 'ipt></body></html>';
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const send = (status, obj, extraHeaders) => {
    res.writeHead(status, { 'content-type': 'application/json', ...(extraHeaders || {}) });
    res.end(JSON.stringify(obj));
  };
  if (MODE === 'no-health' && url.pathname === '/healthz') { res.writeHead(500); res.end('bad'); return; }
  if (url.pathname === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (url.pathname === '/' || url.pathname.endsWith('/')) { res.writeHead(200, {'content-type':'text/html'}); res.end(HTML); return; }
  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    const { email, password } = await readBody(req);
    if (!email || !password || String(password).length < 12) return send(400, { error: { code: 'BAD_INPUT' } });
    if (users.has(email)) return send(409, { error: { code: 'EXISTS' } });
    const user = { id: 'u' + (nextId++), email, password };
    users.set(email, user);
    setSession(res, user.id);
    return send(201, { user: { id: user.id, email: user.email } });
  }
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const { email, password } = await readBody(req);
    const user = users.get(email);
    if (!user || user.password !== password) return send(401, { error: { code: 'BAD_CREDENTIALS' } });
    setSession(res, user.id);
    return send(200, { user: { id: user.id, email: user.email } });
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = parseCookies(req)[COOKIE];
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', COOKIE + '=; Path=' + PUBLIC_PATH + '; HttpOnly; SameSite=Lax; Max-Age=0');
    return send(200, { ok: true });
  }
  if (url.pathname === '/api/auth/me') {
    const user = me(req);
    if (!user) return send(401, { error: { code: 'UNAUTHORIZED' } });
    return send(200, { user: { id: user.id, email: user.email } });
  }
  if (url.pathname === '/api/todos' && req.method === 'GET') {
    const user = me(req);
    if (!user) return send(401, { error: { code: 'UNAUTHORIZED' } });
    return send(200, { items: [...todos.values()].filter((t) => t.userId === user.id) });
  }
  if (url.pathname === '/api/todos' && req.method === 'POST') {
    const user = me(req);
    if (!user) return send(401, { error: { code: 'UNAUTHORIZED' } });
    const { title } = await readBody(req);
    if (!title) return send(400, { error: { code: 'BAD_INPUT' } });
    const todo = { id: 't' + (nextId++), userId: user.id, title: String(title) };
    todos.set(todo.id, todo);
    return send(201, { todo });
  }
  const m = url.pathname.match(/^\\/api\\/todos\\/([^/]+)$/);
  if (m) {
    const user = me(req);
    if (!user) return send(401, { error: { code: 'UNAUTHORIZED' } });
    const todo = todos.get(m[1]);
    if (!todo || todo.userId !== user.id) return send(404, { error: { code: 'NOT_FOUND' } });
    return send(200, { todo });
  }
  // assets: pretend the frontend bundle exists
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('// fake asset');
    return;
  }
  res.writeHead(404); res.end('nf');
});
server.listen(PORT, HOST, () => {
  // Touch the DB file so tests can prove temp-DB lifecycle.
  try { fs.writeFileSync(process.env.DB_PATH || '/tmp/nope.db', 'fake-db'); } catch {}
  console.log('ready port=' + server.address().port);
});
`;

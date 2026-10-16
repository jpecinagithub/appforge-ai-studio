/**
 * Fase 5B — test_authenticated_flow for dynamic projects.
 *
 * Verifies the authenticated user journey against the PUBLISHED preview
 * (`${studioBaseUrl}/a/:projectId/`, through the Studio proxy — never a
 * different server). Fully deterministic: no URLs, selectors, credentials
 * or commands are accepted from the LLM; every step is fixed.
 *
 * Phase 1 — deterministic API checks:
 *   1. /healthz
 *   2. register user A
 *   3. Set-Cookie carries HttpOnly and SameSite
 *   4. session recovery (GET /api/auth/me as A)
 *   5. create + list a record as A
 *   6. register user B
 *   7. isolation: B gets 404 for A's record
 *   8. back to user A (session still valid)
 *   9. logout as A
 *   10. /api/auth/me as A -> 401
 *
 * Phase 2 — real Chromium against /a/:projectId/ using the stable
 * data-testid selectors defined in the template (never translated text
 * or visual positions alone):
 *   register from the UI, authenticated content visible, create a record
 *   from the UI and see the exact result, reload (session recovery),
 *   logout, back to the auth screen.
 */

import { getPreview } from './previewManager.js';
import { recordDynamicCheckForTest, previewReceiptValid, previewGateStatus } from './dynamicTools.js';
import { checkBrowserAtUrl, type BrowserStep } from './browser.js';
import type { ToolContext } from './tools.js';
import type { ToolResult } from 'appforge-shared';

const API_TIMEOUT_MS = 10_000;

function fail(code: string, error: string, durationMs: number): ToolResult {
  return { ok: false, code, error, durationMs };
}

/** Minimal cookie jar for the deterministic API phase. */
class Jar {
  private cookies = new Map<string, string>();
  lastSetCookie: string[] = [];

  storeFrom(res: Response): void {
    // undici exposes Set-Cookie via getSetCookie().
    const raw = typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [];
    this.lastSetCookie = raw;
    for (const sc of raw) {
      const pair = sc.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clear(): void {
    this.cookies.clear();
  }
}

interface Api {
  base: string;
  jar: Jar;
}

async function apiFetch(a: Api, p: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = a.jar.header();
  if (cookie) headers.set('cookie', cookie);
  const res = await fetch(a.base + p, {
    ...init,
    headers,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  a.jar.storeFrom(res);
  return res;
}

async function apiJson(a: Api, p: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await apiFetch(a, p, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

function check(cond: boolean, label: string, detail?: string): void {
  if (!cond) {
    const e = new Error(`AUTH_FLOW_FAILED at step "${label}"${detail ? `: ${detail}` : ''}`) as Error & { step: string };
    e.step = label;
    throw e;
  }
}

const TEST_PASSWORD = 'PreviewFlow123!';
const emailFor = (who: string) => `flow-${who}-${Date.now()}@example.com`;

/** Phase 1: deterministic API checks through the published preview. */
export async function apiAuthFlow(base: string): Promise<{ userA: string; todoTitle: string }> {
  const a: Api = { base, jar: new Jar() };
  const b: Api = { base, jar: new Jar() };

  // 1. /healthz
  {
    const res = await apiFetch(a, '/healthz');
    check(res.ok, 'healthz', `status ${res.status}`);
    await res.arrayBuffer().catch(() => null);
  }

  const emailA = emailFor('a');
  const emailB = emailFor('b');

  // 2. register user A
  {
    const { status } = await apiJson(a, '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailA, password: TEST_PASSWORD }),
    });
    check(status === 200 || status === 201, 'register A', `status ${status}`);
  }

  // 3. Set-Cookie carries HttpOnly and SameSite
  {
    const sc = a.jar.lastSetCookie.join('; ').toLowerCase();
    check(/httponly/.test(sc), 'cookie HttpOnly', a.jar.lastSetCookie.join(' | '));
    check(/samesite/.test(sc), 'cookie SameSite', a.jar.lastSetCookie.join(' | '));
  }

  // 4. session recovery as A
  {
    const { status, body } = await apiJson(a, '/api/auth/me');
    check(status === 200, 'me as A', `status ${status}`);
    check((body as { user?: { email?: string } })?.user?.email === emailA, 'me email matches A');
  }

  // 5. create + list a record as A
  const todoTitle = `flow-todo-${Date.now()}`;
  let todoId = '';
  {
    const { status, body } = await apiJson(a, '/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: todoTitle }),
    });
    check(status === 200 || status === 201, 'create todo', `status ${status}`);
    todoId = String((body as { todo?: { id?: string }; id?: string })?.todo?.id ?? (body as { id?: string })?.id ?? '');
    check(todoId.length > 0, 'todo id returned', JSON.stringify(body).slice(0, 200));
    const listed = await apiJson(a, '/api/todos');
    check(listed.status === 200, 'list todos', `status ${listed.status}`);
    const items = ((listed.body as { items?: Array<{ id?: string; title?: string }> })?.items ?? []) as Array<{ id?: string; title?: string }>;
    check(items.some((t) => t.id === todoId && t.title === todoTitle), 'todo listed');
  }

  // 6. register user B
  {
    const { status } = await apiJson(b, '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailB, password: TEST_PASSWORD }),
    });
    check(status === 200 || status === 201, 'register B', `status ${status}`);
  }

  // 7. isolation: B gets 404 for A's record
  {
    const { status } = await apiJson(b, `/api/todos/${encodeURIComponent(todoId)}`);
    check(status === 404, 'isolation B->A todo', `status ${status}`);
  }

  // 8. back to user A (session still valid)
  {
    const { status } = await apiJson(a, '/api/auth/me');
    check(status === 200, 'me as A again', `status ${status}`);
  }

  // 9. logout as A
  {
    const { status } = await apiJson(a, '/api/auth/logout', { method: 'POST' });
    check(status === 200, 'logout A', `status ${status}`);
    a.jar.clear();
  }

  // 10. /api/auth/me as A -> 401
  {
    const { status } = await apiJson(a, '/api/auth/me');
    check(status === 401, 'me after logout is 401', `status ${status}`);
  }

  return { userA: emailA, todoTitle };
}

/** Phase 2: real Chromium against the published preview URL. */
export async function browserAuthFlow(uiUrl: string, email: string, todoTitle: string): Promise<void> {
  const steps: BrowserStep[] = [
    // Register from the UI (stable data-testid selectors, not translated text).
    { action: 'click', selector: '[data-testid="auth-toggle-mode"]' },
    { action: 'fill', selector: '[data-testid="auth-email"]', value: email },
    { action: 'fill', selector: '[data-testid="auth-password"]', value: TEST_PASSWORD },
    { action: 'click', selector: '[data-testid="auth-submit"]' },
    // Authenticated content visible.
    { action: 'expect_text', selector: '[data-testid="user-email"]', value: email },
    // Create a record from the UI; the exact result must be visible.
    { action: 'fill', selector: '[data-testid="new-todo-input"]', value: todoTitle },
    { action: 'click', selector: '[data-testid="add-todo-button"]' },
    { action: 'expect_text', selector: '[data-testid="todo-list"]', value: todoTitle },
    // Reload: the session must recover via the HttpOnly cookie.
    { action: 'reload' },
    { action: 'expect_text', selector: '[data-testid="user-email"]', value: email },
    { action: 'expect_text', selector: '[data-testid="todo-list"]', value: todoTitle },
    // Logout: back to the auth screen.
    { action: 'click', selector: '[data-testid="logout-button"]' },
    { action: 'expect_text', selector: '[data-testid="auth-screen"]', value: 'Sign in' },
  ];
  const r = await checkBrowserAtUrl(uiUrl, steps, 90_000);
  if (!r.ok) {
    const e = new Error(`AUTH_FLOW_FAILED at browser phase: ${r.error}`) as Error & { step: string };
    e.step = 'browser';
    throw e;
  }
}

/**
 * test_authenticated_flow tool: no arguments accepted. Requires a ready
 * fullstack preview whose receipt is still valid on the current sources.
 */
export async function testAuthenticatedFlow(ctx: ToolContext): Promise<ToolResult> {
  const t0 = Date.now();
  const { projectId } = ctx;

  const preview = getPreview(ctx.db, projectId);
  if (!preview || preview.status !== 'ready') {
    return fail(
      'PREVIEW_NOT_READY',
      'test_authenticated_flow requires a ready fullstack preview: run start_fullstack_preview first.',
      Date.now() - t0,
    );
  }

  // The preview receipt must still be valid on the current sources —
  // otherwise the preview was built from older code.
  if (!previewGateStatus(ctx).ok || !previewReceiptValid(ctx)) {
    return fail(
      'DYNAMIC_CHECKS_INCOMPLETE',
      'the fullstack preview is stale (sources changed after it started): re-run start_fullstack_preview, then test_authenticated_flow.',
      Date.now() - t0,
    );
  }

  const baseUrl = (ctx.studioBaseUrl ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
  const publishedBase = `${baseUrl}/a/${projectId}`;
  const uiUrl = `${publishedBase}/`;

  try {
    const { userA, todoTitle } = await apiAuthFlow(publishedBase);
    // The browser registers its own user (fresh session through the UI).
    await browserAuthFlow(uiUrl, emailFor('ui'), `ui-todo-${Date.now()}`);
    recordDynamicCheckForTest(ctx, 'authenticatedFlow');
    void userA; void todoTitle;
    return {
      ok: true,
      data: { status: 'passed', phases: ['api', 'browser'], url: uiUrl },
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    const step = (e as { step?: string }).step ?? 'unknown';
    return fail('AUTH_FLOW_FAILED', `authenticated flow failed at "${step}": ${(e as Error).message}`.slice(0, 2000), Date.now() - t0);
  }
}

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
 *   6. register user B
 *   7. independent identity for B
 *   8. back to user A (session still valid)
 *   9. logout as A
 *   10. /api/auth/me as A -> 401
 *
 * Phase 2 — real Chromium against /a/:projectId/ using the stable
 * data-testid selectors defined in the template (never translated text
 * or visual positions alone):
 *   register from the UI, authenticated identity visible, reload (session recovery),
 *   logout, back to the auth screen.
 */

import { getPreview, previewCookieName } from './previewManager.js';
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

/** Parse one Set-Cookie header into name + lower-cased attributes. */
export function parseSetCookie(sc: string): { name: string; attrs: Map<string, string | true> } {
  const parts = sc.split(';');
  const nameValue = parts[0] ?? '';
  const eq = nameValue.indexOf('=');
  const attrs = new Map<string, string | true>();
  for (const ap of parts.slice(1)) {
    const aeq = ap.indexOf('=');
    if (aeq < 0) attrs.set(ap.trim().toLowerCase(), true);
    else attrs.set(ap.slice(0, aeq).trim().toLowerCase(), ap.slice(aeq + 1).trim());
  }
  return { name: (eq > 0 ? nameValue.slice(0, eq) : nameValue).trim(), attrs };
}

/**
 * Require the session cookie to carry exactly HttpOnly, SameSite=Lax and
 * Path=<expectedPath>. Secure may be omitted only on the local HTTP preview
 * (the template sets it in production). Throws on violation.
 */
export function assertSessionCookie(
  setCookieHeaders: string[],
  sessionCookieName: string,
  expectedPath: string,
): void {
  const session = setCookieHeaders.map(parseSetCookie).find((c) => c.name === sessionCookieName);
  check(!!session, 'session Set-Cookie present', setCookieHeaders.join(' | '));
  const attrs = session!.attrs;
  check(attrs.has('httponly'), 'cookie HttpOnly', setCookieHeaders.join(' | '));
  // Attribute values are case-insensitive (template sends "Lax").
  check(String(attrs.get('samesite') ?? '').toLowerCase() === 'lax', 'cookie SameSite=Lax', setCookieHeaders.join(' | '));
  check(attrs.get('path') === expectedPath, `cookie Path=${expectedPath}`, setCookieHeaders.join(' | '));
}

/** Phase 1: deterministic API checks through the published preview. */
export async function apiAuthFlow(base: string, projectId: string): Promise<{ userA: string }> {
  const a: Api = { base, jar: new Jar() };
  const b: Api = { base, jar: new Jar() };
  const expectedCookiePath = `/a/${projectId}/`;
  const sessionCookieName = previewCookieName(projectId);

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

  // 3. The session Set-Cookie carries exactly HttpOnly, SameSite=Lax and
  //    Path=/a/:projectId/. Secure may be omitted only on the local HTTP
  //    preview (the template sets it in production).
  assertSessionCookie(a.jar.lastSetCookie, sessionCookieName, expectedCookiePath);

  // 4. session recovery as A
  {
    const { status, body } = await apiJson(a, '/api/auth/me');
    check(status === 200, 'me as A', `status ${status}`);
    check((body as { user?: { email?: string } })?.user?.email === emailA, 'me email matches A');
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

  // Independent sessions must identify different users. Domain isolation is
  // exercised by the mandatory project API tests, without assuming /todos.
  {
    const bMe = await apiJson(b, '/api/auth/me');
    check(bMe.status === 200, 'me as B');
    check((bMe.body as { user?: { email?: string } })?.user?.email === emailB, 'B session is isolated');
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

  return { userA: emailA };
}

/** Phase 2: real Chromium against the published preview URL. */
export async function browserAuthFlow(uiUrl: string, email: string): Promise<void> {
  const steps: BrowserStep[] = [
    // Register from the UI (stable data-testid selectors, not translated text).
    { action: 'click', selector: '[data-testid="auth-toggle-mode"]' },
    { action: 'fill', selector: '[data-testid="auth-email"]', value: email },
    { action: 'fill', selector: '[data-testid="auth-password"]', value: TEST_PASSWORD },
    { action: 'click', selector: '[data-testid="auth-submit"]' },
    // Authenticated content visible.
    { action: 'expect_text', selector: '[data-testid="user-email"]', value: email },
    // Reload: the session must recover via the HttpOnly cookie.
    { action: 'reload' },
    { action: 'expect_text', selector: '[data-testid="user-email"]', value: email },
    // Logout: back to the auth screen.
    { action: 'click', selector: '[data-testid="logout-button"]' },
    { action: 'expect_visible', selector: '[data-testid="auth-screen"]' },
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
    await apiAuthFlow(publishedBase, projectId);
    // The browser registers its own user (fresh session through the UI).
    await browserAuthFlow(uiUrl, emailFor('ui'));
    recordDynamicCheckForTest(ctx, 'authenticatedFlow');
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

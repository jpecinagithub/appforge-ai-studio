import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium, type Page, type BrowserContext } from 'playwright-core';
import type { ToolResult } from 'appforge-shared';
import { enrichStackWithSourceLocations, type FetchText, type SourceMapCache } from './stackResolve.js';

export interface BrowserStep {
  action: 'click' | 'fill' | 'select' | 'expect_text' | 'expect_visible' | 'reload';
  selector?: string;
  value?: string;
}

export interface BrowserSession {
  storage?: Awaited<ReturnType<BrowserContext['storageState']>>;
  origin?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------
// Failure diagnostics — shared by checkBrowser (static path) and
// checkBrowserAtUrl (dynamic preview + authenticated flow).
//
// Pass/fail semantics are unchanged: page errors and failed STATIC resources
// (document/script/stylesheet/image, as before) fail the check; step failures
// fail the check. Console errors and API (xhr/fetch) failures are captured as
// diagnostic context only — a 401 from /api/auth/me on page load is a normal
// part of the auth flow and must not fail it — but when the check does fail,
// they are reported so the agent can see e.g. an `HTTP 500 POST .../api/...`
// instead of patching blind.
//
// Images are asserted TWICE: on the first screen (before the steps) and again
// after the steps, on the final screen, after a full scroll + settle so lazy
// images load. The first screen of the authenticated flow is the login form
// (no data), so a post-login catalog full of broken images used to verify
// green; the post-steps assertion is what catches it, and its failure
// snapshot shows that final screen.
//
// "Loaded" is an honest criterion, not just a rendered one: a completed
// <img> counts only when it rendered real pixels (naturalWidth > 0) AND
// this check observed its currentSrc arrive as a 2xx image/* network
// response. An onError handler that swaps a missing file for an inline
// placeholder leaves naturalWidth > 0 but no such response — the deployed
// T-shirts shop verified green with product photos that never existed
// exactly that way (absolute /assets/products/*.jpg paths, masked by the
// card's onError fallback). The platform placeholder is unaffected: it is
// a real file served as image/svg+xml, so it satisfies the criterion on
// its own merits (and is separately declared as a degradation).
// ---------------------------------------------------------------------------

/** Resource types whose failures were already fatal before this change. */
const STATIC_RESOURCE_TYPES = ['document', 'script', 'stylesheet', 'image'];

const MAX_PAGE_ERRORS = 5;
const MAX_CONSOLE_ERRORS = 10;
const MAX_NETWORK_LINES = 12;
const MAX_TESTID_INVENTORY = 40;
const MAX_VISIBLE_TEXT = 800;
const MAX_DIAGNOSTIC_CHARS = 6000;

export interface FailedStep {
  /** 1-based index of the step that failed. */
  index: number;
  total: number;
  step: BrowserStep;
}

/** One observed network response for an image resource. */
export interface ObservedImageResponse {
  status: number;
  contentType: string;
  /** True when the status is 2xx and the content type is image/*. */
  valid: boolean;
}

export interface PageDiagnostics {
  /** Page errors with stack excerpts; these fail the check (as before). */
  pageErrors: string[];
  /** Static-resource network failures; these fail the check (as before). */
  hardNetwork: string[];
  /** Every network failure (all resource types), compact lines, deduped. */
  network: string[];
  /** Full URLs of the failed requests, parallel to `network`. */
  networkUrls: string[];
  /** Console messages of type 'error', deduped, capped. Context only. */
  consoleErrors: string[];
  /**
   * Image responses observed during the check, keyed by URL without the
   * query string. The image assertion consults this registry: a photo
   * counts as loaded only when its bytes were seen arriving as a valid
   * (2xx, image/*) response — provenance an onError substitution cannot
   * fake, because a data-URI swap produces no network response at all.
   */
  imageResponses: Map<string, ObservedImageResponse>;
}

function newPageDiagnostics(): PageDiagnostics {
  return { pageErrors: [], hardNetwork: [], network: [], networkUrls: [], consoleErrors: [], imageResponses: new Map() };
}

/** Registry key for image URLs: the full URL minus its query string. */
function imageResponseKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.search = '';
    return u.href;
  } catch {
    return rawUrl.split('?')[0] ?? rawUrl;
  }
}

/**
 * Record one observed image response. A valid observation is proof the
 * bytes arrived and is never displaced by a later invalid one (a cache
 * revalidation or a retried error page must not un-prove a photo that
 * loaded); an invalid observation yields to any later one (a retry that
 * eventually serves the real image replaces the earlier failure).
 */
function recordImageResponse(diag: PageDiagnostics, url: string, status: number, contentType: string): void {
  const valid = status >= 200 && status < 300
    && (contentType.split(';')[0] ?? '').trim().toLowerCase().startsWith('image/');
  const key = imageResponseKey(url);
  if (diag.imageResponses.get(key)?.valid && !valid) return;
  diag.imageResponses.set(key, { status, contentType, valid });
}

/** Bounded text fetch for sourcemap resolution (bundles can be MBs). */
const stackFetchText: FetchText = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return (await res.text()).slice(0, 24_000_000);
  } catch {
    return null;
  }
};

/**
 * Decorate the collected page errors with original source locations
 * resolved through the bundle sourcemaps (stackResolve.ts), so the
 * diagnostic names e.g. frontend/src/App.tsx:300 next to the minified
 * frame. Best effort by construction: any failure leaves diag untouched.
 */
async function enrichPageErrorsWithSourceLocations(diag: PageDiagnostics): Promise<void> {
  if (diag.pageErrors.length === 0) return;
  try {
    const cache: SourceMapCache = new Map();
    diag.pageErrors = await Promise.all(
      diag.pageErrors.map((entry) => enrichStackWithSourceLocations(entry, stackFetchText, cache)),
    );
  } catch {
    /* diagnostics must never break the check itself */
  }
}

function hasHardErrors(diag: PageDiagnostics): boolean {
  return diag.pageErrors.length > 0 || diag.hardNetwork.length > 0;
}

/** Marker: the steps passed but the page reported errors (old `errors` throw). */
class CollectedPageErrors extends Error {
  constructor() {
    super('page errors were reported during verification');
    this.name = 'CollectedPageErrors';
  }
}

function urlPath(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return rawUrl.split('?')[0] ?? rawUrl;
  }
}

function pushUnique(list: string[], line: string, cap: number): void {
  if (!list.includes(line) && list.length < cap) list.push(line);
}

/** Attach the shared diagnostic listeners to a page. */
function attachPageDiagnostics(page: Page, diag: PageDiagnostics): void {
  page.on('pageerror', (error) => {
    const entry = [error.message];
    if (error.stack) {
      // The stack's first line repeats the message; keep up to ~6 more lines.
      entry.push(...error.stack.split('\n').slice(1, 7).map((l) => l.trimEnd()));
    }
    pushUnique(diag.pageErrors, entry.join('\n'), MAX_PAGE_ERRORS);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    pushUnique(diag.consoleErrors, msg.text().slice(0, 300), MAX_CONSOLE_ERRORS);
  });
  const recordFailure = (line: string, url: string, hard: boolean) => {
    if (!diag.network.includes(line) && diag.network.length < 200) {
      diag.network.push(line);
      diag.networkUrls.push(url);
    }
    if (hard) pushUnique(diag.hardNetwork, line, 200);
  };
  page.on('response', (response) => {
    const request = response.request();
    // Record EVERY image response (any status), not just failures: the
    // image assertion needs the positive observations to tell a photo
    // that really arrived from one an onError handler faked.
    if (request.resourceType() === 'image') {
      recordImageResponse(diag, response.url(), response.status(), response.headers()['content-type'] ?? '');
    }
    if (response.status() < 400) return;
    recordFailure(
      `HTTP ${response.status()} ${request.method()} ${urlPath(response.url())}`,
      response.url(),
      STATIC_RESOURCE_TYPES.includes(request.resourceType()),
    );
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    recordFailure(
      `FAILED ${request.method()} ${urlPath(request.url())}${failure ? ` (${failure.errorText})` : ''}`,
      request.url(),
      STATIC_RESOURCE_TYPES.includes(request.resourceType()),
    );
  });
}

/** Run the steps in order, remembering which one failed (1-based). */
async function runSteps(
  page: Page,
  steps: BrowserStep[],
  markFailed: (failed: FailedStep) => void,
): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    try {
      await browserStep(page, steps[i]!);
    } catch (error) {
      markFailed({ index: i + 1, total: steps.length, step: steps[i]! });
      throw error;
    }
  }
}

function describeStep(step: BrowserStep): string {
  return step.selector ? `${step.action} "${step.selector}"` : step.action;
}

export interface FailurePageSnapshot {
  url: string;
  title: string;
  /** Explicit verdict line for a data-testid selector, when applicable. */
  selectorVerdict?: string;
  testIds: string[];
  visibleText: string;
}

const DATA_TESTID_SELECTOR_RE = /\[data-testid=["']?([^"'\]]+)["']?\]/;

/**
 * Snapshot of the page at failure time: current URL/title, whether the failed
 * step's data-testid selector exists in the DOM (and its text), the inventory
 * of data-testid values present, and an excerpt of the visible text. Never
 * throws: a crashed/hung page yields whatever could be read.
 */
export async function collectFailureDiagnostics(
  page: Page,
  failedStep?: FailedStep | null,
): Promise<FailurePageSnapshot> {
  const fallback: FailurePageSnapshot = {
    url: (() => { try { return page.url(); } catch { return 'unavailable'; } })(),
    title: 'unavailable',
    testIds: [],
    visibleText: '',
  };
  const testId = failedStep?.step.selector?.match(DATA_TESTID_SELECTOR_RE)?.[1];
  const read = page.evaluate(
    (wanted: string | null) => {
      // Runs in the page; the worker tsconfig has no DOM lib, so reach the
      // globals through globalThis with minimal local typings.
      const g = globalThis as unknown as {
        document: {
          title: string;
          body: { innerText: string } | null;
          querySelectorAll: (s: string) => ArrayLike<{ getAttribute: (n: string) => string | null }>;
          querySelector: (s: string) => { textContent: string | null } | null;
        };
        location: { href: string };
      };
      const ids: string[] = [];
      for (const el of Array.from(g.document.querySelectorAll('[data-testid]'))) {
        const v = el.getAttribute('data-testid');
        if (v && !ids.includes(v)) ids.push(v);
      }
      let verdict: string | undefined;
      if (wanted) {
        const el = g.document.querySelector(`[data-testid="${wanted}"]`);
        verdict = el
          ? `selector [data-testid="${wanted}"]: present, text: "${(el.textContent ?? '').trim().slice(0, 120)}"`
          : `selector [data-testid="${wanted}"]: NOT PRESENT in DOM`;
      }
      return {
        url: g.location.href,
        title: g.document.title,
        testIds: ids,
        visibleText: (g.document.body?.innerText ?? '').trim(),
        verdict,
      };
    },
    testId ?? null,
  );
  try {
    const result = await Promise.race([
      read,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('diagnostics read timed out')), 3000)),
    ]);
    return {
      url: result.url,
      title: result.title,
      selectorVerdict: result.verdict,
      testIds: result.testIds.slice(0, MAX_TESTID_INVENTORY),
      visibleText: result.visibleText.slice(0, MAX_VISIBLE_TEXT),
    };
  } catch {
    return fallback;
  }
}

function selectNetworkLines(diag: PageDiagnostics): string[] {
  const api = diag.network.filter((l) => l.includes('/api/'));
  const rest = diag.network.filter((l) => !l.includes('/api/'));
  const picked = [...api, ...rest].slice(0, MAX_NETWORK_LINES);
  if (diag.network.length > picked.length) {
    picked.push(`(+${diag.network.length - picked.length} more network failures omitted)`);
  }
  return picked;
}

/**
 * Base-path escape warnings (deterministic, no guessing): a failed
 * request whose same-origin path does NOT start with the page's own base
 * path escaped the app — the signature of a hand-written absolute
 * /api/... path (the app lives below /a/<projectId>/, or /p/<projectId>/
 * for the static preview). In the T-shirts run the 404 on /api/shirts
 * sat in NETWORK FAILURES next to the working /a/<id>/api/auth/me and
 * the agent never connected them; this line names the conclusion.
 * External origins are ignored (their paths owe nothing to the base),
 * and an app served at the root cannot escape (no warnings).
 */
export function escapedBasePathWarnings(pageUrl: string, failedUrls: string[]): string[] {
  let base: string;
  let origin: string;
  try {
    const u = new URL(pageUrl);
    origin = u.origin;
    base = u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
  } catch {
    return [];
  }
  if (!base || base === '/') return [];
  const escaped = new Set<string>();
  for (const raw of failedUrls) {
    try {
      const u = new URL(raw);
      if (u.origin !== origin) continue;
      if (u.pathname.startsWith(base) || u.pathname === base.slice(0, -1)) continue;
      escaped.add(u.pathname);
    } catch {
      /* not a URL: ignore */
    }
  }
  return [...escaped].slice(0, 5).map(
    (p) =>
      `request escaped the app base path: ${p} is outside the page base ${base} — likely an absolute /api path in the code; ` +
      'route API calls through the project API client or a relative URL so they stay below the base path',
  );
}

/**
 * Compose the labeled failure diagnostic, most actionable first, capped at
 * ~6000 chars (the visible-text excerpt and the testid inventory shrink
 * first). Layout:
 *   step N/M (action "selector") failed: <original error>   [or the error]
 *   PAGE ERRORS: ...
 *   selector [data-testid="..."]: NOT PRESENT in DOM        [when applicable]
 *   NETWORK FAILURES: ...
 *   BASE PATH WARNING: ...                                  [when a request escaped the app prefix]
 *   CONSOLE ERRORS: ...
 *   PAGE: <url> — title: "..."
 *   DATA-TESTID INVENTORY: ...
 *   VISIBLE TEXT: ...
 */
export function composeFailureDiagnostic(args: {
  primaryError: Error;
  failedStep?: FailedStep | null;
  diag: PageDiagnostics;
  snapshot?: FailurePageSnapshot | null;
}): string {
  const { primaryError, failedStep, diag, snapshot } = args;
  let headline: string;
  if (failedStep) {
    headline = `step ${failedStep.index}/${failedStep.total} (${describeStep(failedStep.step)}) failed: ${primaryError.message}`;
  } else if (primaryError instanceof CollectedPageErrors) {
    headline = diag.pageErrors[0]?.split('\n')[0] ?? diag.hardNetwork[0] ?? primaryError.message;
  } else {
    headline = primaryError.message;
  }
  const networkLines = selectNetworkLines(diag);
  const build = (textChars: number, inventoryCount: number): string => {
    const sections: string[] = [headline];
    if (diag.pageErrors.length) sections.push(`PAGE ERRORS:\n${diag.pageErrors.join('\n')}`);
    if (snapshot?.selectorVerdict) sections.push(snapshot.selectorVerdict);
    if (networkLines.length) sections.push(`NETWORK FAILURES:\n${networkLines.join('\n')}`);
    const baseWarnings = snapshot?.url ? escapedBasePathWarnings(snapshot.url, diag.networkUrls) : [];
    if (baseWarnings.length) sections.push(`BASE PATH WARNING:\n${baseWarnings.join('\n')}`);
    if (diag.consoleErrors.length) sections.push(`CONSOLE ERRORS:\n${diag.consoleErrors.join('\n')}`);
    if (snapshot) {
      sections.push(`PAGE: ${snapshot.url} — title: "${snapshot.title}"`);
      if (snapshot.testIds.length) {
        sections.push(`DATA-TESTID INVENTORY: ${snapshot.testIds.slice(0, inventoryCount).join(', ')}`);
      }
      if (snapshot.visibleText) sections.push(`VISIBLE TEXT: ${snapshot.visibleText.slice(0, textChars)}`);
    }
    return sections.join('\n');
  };
  let out = build(MAX_VISIBLE_TEXT, MAX_TESTID_INVENTORY);
  if (out.length > MAX_DIAGNOSTIC_CHARS) out = build(400, 20);
  if (out.length > MAX_DIAGNOSTIC_CHARS) out = build(150, 10);
  if (out.length > MAX_DIAGNOSTIC_CHARS) out = out.slice(0, MAX_DIAGNOSTIC_CHARS);
  return out;
}

/** Serve the actual bundle under the same nested path used in production. */
export async function checkBrowser(
  distDir: string,
  projectId: string,
  steps: BrowserStep[] = [],
  timeoutMs = 45_000,
  session: BrowserSession = {},
  screenshotPath?: string,
): Promise<ToolResult> {
  const t0 = Date.now();
  const prefix = `/p/${projectId}/`;
  const server = http.createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      if (!pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
      const relative = pathname.slice(prefix.length) || 'index.html';
      let file = path.resolve(distDir, relative);
      if (!file.startsWith(path.resolve(distDir) + path.sep)) { res.writeHead(400).end(); return; }
      if (!fs.existsSync(file) && !path.extname(relative)) file = path.join(distDir, 'index.html');
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch { res.writeHead(400).end(); }
  });
  let browser;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const diag = newPageDiagnostics();
  let failedStep: FailedStep | null = null;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}${prefix}`;
    browser = await chromium.launch({
      executablePath: process.env.APPFORGE_BROWSER_EXECUTABLE || undefined,
      headless: true, timeout: Math.min(timeoutMs, 15_000), args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    // Keep test data between tool calls within this run. The temporary server's
    // port changes, so remap only its own localStorage origin to the new port.
    const origin = new URL(url).origin;
    const storageState = session.storage ? { ...session.storage, origins: session.storage.origins.map((entry) => ({ ...entry, origin: entry.origin === session.origin ? origin : entry.origin })) } : undefined;
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState });
    session.origin = origin;
    page = await context.newPage();
    page.setDefaultTimeout(5000);
    attachPageDiagnostics(page, diag);
    const remaining = Math.max(1, timeoutMs - (Date.now() - t0));
    const work = async () => {
      // Navigation waits for 'load' only — never for network rest. The fact
      // being verified (the app loads and renders) is judged by the content
      // wait, the image assertions and the steps below; 'networkidle' also
      // demanded 500 ms of zero connections, which slow image grids,
      // polling or keep-alive connections can postpone past any ceiling
      // and fail correct apps (the auth-flow reload died of exactly this).
      await page!.goto(url, { waitUntil: 'load', timeout: Math.min(remaining, 15_000) });
      await page!.waitForFunction('document.body.innerText.trim().length > 0', undefined, { timeout: 5000 });
      await assertImagesLoaded(page!, diag);
      const screenshot = screenshotPath
        ? await page!.screenshot({
          type: 'webp',
          quality: 78,
          animations: 'disabled',
          clip: { x: 0, y: 0, width: 1280, height: 720 },
        })
        : null;
      await runSteps(page!, steps, (f) => { failedStep = f; });
      // Post-steps: re-assert images on the FINAL screen (after the mobile
      // viewport pass below there is a third check); errors collected during
      // the steps are judged by the hasHardErrors gate further down.
      await assertImagesLoadedAfterSteps(page!, diag);
      const text = (await page!.locator('body').innerText()).slice(0, 6000);
      // Capture accessible controls as feedback for the agent's next interaction test.
      const snapshot = (await page!.locator('body').ariaSnapshot()).slice(0, 8000);
      const interactiveControls = await page!.locator('button:visible, input:visible, select:visible, textarea:visible, [role="button"]:visible').count();
      await page!.setViewportSize({ width: 390, height: 844 });
      await page!.waitForFunction('document.body.innerText.trim().length > 0', undefined, { timeout: 5000 });
      await assertImagesLoaded(page!, diag);
      if (hasHardErrors(diag)) throw new CollectedPageErrors();
      if (screenshotPath && screenshot) {
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        fs.writeFileSync(screenshotPath, screenshot);
      }
      return { text, snapshot, interactiveControls, stepsPassed: steps.length, viewports: ['1280x800', '390x844'], screenshot: screenshotPath ?? null };
    };
    const data = await Promise.race([
      work(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Browser verification timed out')), remaining); }),
    ]);
    return { ok: true, data, output: `Chromium rendered the current bundle on desktop and mobile. ${steps.length} interaction steps passed.\n${data.snapshot}`, durationMs: Date.now() - t0 };
  } catch (error) {
    await enrichPageErrorsWithSourceLocations(diag);
    const snapshot = page ? await collectFailureDiagnostics(page, failedStep) : null;
    const diagnostic = composeFailureDiagnostic({ primaryError: error as Error, failedStep, diag, snapshot });
    return { ok: false, code: 'BROWSER_FAILED', error: diagnostic, output: diagnostic, durationMs: Date.now() - t0 };
  } finally {
    if (timer) clearTimeout(timer);
    if (context) {
      try { session.storage = await context.storageState(); } catch { /* browser may have crashed */ }
    }
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Fase 5B — drive real Chromium against a live URL (e.g. the dynamic
 * preview published through the Studio proxy at /a/:projectId/).
 * Same step language and diagnostics as checkBrowser.
 */
export async function checkBrowserAtUrl(
  url: string,
  steps: BrowserStep[] = [],
  timeoutMs = 60_000,
): Promise<ToolResult> {
  const t0 = Date.now();
  let browser;
  let page: Page | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const diag = newPageDiagnostics();
  let failedStep: FailedStep | null = null;
  try {
    browser = await chromium.launch({
      executablePath: process.env.APPFORGE_BROWSER_EXECUTABLE || undefined,
      headless: true, timeout: Math.min(timeoutMs, 15_000), args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    page.setDefaultTimeout(5000);
    attachPageDiagnostics(page, diag);
    const remaining = Math.max(1, timeoutMs - (Date.now() - t0));
    const work = async () => {
      // Same criterion as checkBrowser's goto: 'load', never network rest —
      // rendering is judged by the assertions and steps that follow.
      await page!.goto(url, { waitUntil: 'load', timeout: Math.min(remaining, 15_000) });
      await page!.waitForFunction('document.body.innerText.trim().length > 0', undefined, { timeout: 5000 });
      await assertImagesLoaded(page!, diag);
      await runSteps(page!, steps, (f) => { failedStep = f; });
      // Post-steps: re-assert images on the FINAL screen — in the
      // authenticated flow that is the post-login content, which the
      // pre-steps check (login screen) cannot see. Page errors collected
      // during the steps are judged by the hasHardErrors gate just below,
      // and the failure snapshot is taken from this same final screen.
      await assertImagesLoadedAfterSteps(page!, diag);
      const text = (await page!.locator('body').innerText()).slice(0, 6000);
      const snapshot = (await page!.locator('body').ariaSnapshot()).slice(0, 8000);
      if (hasHardErrors(diag)) throw new CollectedPageErrors();
      await context.close();
      return { text, snapshot, stepsPassed: steps.length };
    };
    const data = await Promise.race([
      work(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Browser verification timed out')), remaining); }),
    ]);
    return { ok: true, data, output: `Chromium verified the live preview. ${steps.length} interaction steps passed.\n${data.snapshot}`, durationMs: Date.now() - t0 };
  } catch (error) {
    await enrichPageErrorsWithSourceLocations(diag);
    const snapshot = page ? await collectFailureDiagnostics(page, failedStep) : null;
    const diagnostic = composeFailureDiagnostic({ primaryError: error as Error, failedStep, diag, snapshot });
    return { ok: false, code: 'BROWSER_FAILED', error: diagnostic, output: diagnostic, durationMs: Date.now() - t0 };
  } finally {
    if (timer) clearTimeout(timer);
    await browser?.close();
  }
}

/** Display form of an image src in diagnostics (data URIs are truncated). */
function displayImageSrc(src: string): string {
  return src.length > 160 ? `${src.slice(0, 160)}…` : src;
}

/**
 * The honest image criterion, applied on every screen this module
 * asserts. A completed <img> is rejected when:
 *  - it rendered no image data (naturalWidth === 0) — the classic broken
 *    image, exactly as before; or
 *  - it rendered pixels but this check never observed its currentSrc
 *    arrive as a 2xx image/* network response — the signature of an
 *    onError substitution (or a resource that never existed): the swap
 *    target (typically an inline data URI) produces no response at all,
 *    so provenance cannot be proven and the photo does not count.
 * Images still loading (complete === false) are not judged yet — the
 * same patience the previous criterion had.
 */
async function assertImagesLoaded(page: Page, diag: PageDiagnostics): Promise<void> {
  const images = await page.locator('img').evaluateAll((els) => els
    .map((image) => image as unknown as { complete: boolean; naturalWidth: number; currentSrc: string; src: string; alt: string })
    .map((image) => ({
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      src: image.currentSrc || image.src,
      alt: image.alt,
    })));
  const rejected: { src: string; alt: string; reason: string }[] = [];
  for (const image of images) {
    if (!image.complete) continue;
    if (image.naturalWidth === 0) {
      rejected.push({ src: image.src, alt: image.alt, reason: 'no image data rendered (naturalWidth 0)' });
      continue;
    }
    if (!diag.imageResponses.get(imageResponseKey(image.src))?.valid) {
      rejected.push({
        src: image.src,
        alt: image.alt,
        reason: 'no valid image response observed (possible error substitution or missing resource)',
      });
    }
  }
  if (rejected.length > 0) {
    const detail = rejected.slice(0, 8)
      .map((image) => `${image.alt || '(no alt)'}: ${displayImageSrc(image.src)} — ${image.reason}`)
      .join('\n');
    throw new Error(`Broken images detected:\n${detail}`);
  }
}

/**
 * Scroll the whole page top to bottom (and back) so lazy-loaded content —
 * above all images — is triggered, then wait a short settle. Best effort:
 * a page mid-navigation may reject the evaluate; the image assertion that
 * follows still runs and judges whatever state the page is in.
 */
async function scrollThroughPage(page: Page): Promise<void> {
  try {
    await page.evaluate(async () => {
      // Runs in the page; the worker tsconfig has no DOM lib, so reach the
      // globals through globalThis with minimal local typings.
      const g = globalThis as unknown as {
        document: { documentElement: { scrollHeight: number } };
        innerHeight: number;
        scrollTo: (x: number, y: number) => void;
      };
      const height = g.document.documentElement.scrollHeight;
      const step = Math.max(240, g.innerHeight);
      for (let y = step; y < height; y += step) {
        g.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      g.scrollTo(0, height);
      await new Promise((resolve) => setTimeout(resolve, 100));
      g.scrollTo(0, 0);
    });
  } catch {
    /* page may be navigating; ignore and let the image check judge */
  }
  await page.waitForTimeout(300);
}

/**
 * Post-steps image assertion, shared by checkBrowser and checkBrowserAtUrl:
 * scroll so lazy images load, settle briefly, then apply the exact same
 * honest image criterion as the pre-steps check — but on the final screen.
 */
async function assertImagesLoadedAfterSteps(page: Page, diag: PageDiagnostics): Promise<void> {
  await scrollThroughPage(page);
  await assertImagesLoaded(page, diag);
}

async function browserStep(page: Page, step: BrowserStep): Promise<void> {
  if (step.action === 'reload') {
    // The fact this step sets up is session persistence, and it is judged
    // by the NEXT step's visibility expectation (with its own locator
    // timeout) — never by the navigation. Waiting for 'networkidle' made a
    // correct app fail whenever the reloaded screen kept connections open
    // longer than the page's 5s default navigation timeout: T-shirts
    // 497f482d (run 0488ed8a) died 3x at this step, "waiting for navigation
    // until networkidle", while the page already showed the catalog and
    // the authenticated email — a ~20-photo grid simply takes longer than
    // 5s to go idle. Even 'load' would gate on those photos, so wait only
    // for the parsed document; the navigation ceiling matches the initial
    // goto (15s) and the expectation after the reload does the judging.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
    return;
  }
  if (step.action === 'expect_text') {
    if (!step.value) throw new Error('expect_text requires value');
    const scope = step.selector ? page.locator(step.selector) : page;
    await scope.getByText(step.value, { exact: true }).first().waitFor({ state: 'visible' });
    return;
  }
  if (!step.selector) throw new Error(`${step.action} requires a CSS selector`);
  const target = page.locator(step.selector);
  if (step.action === 'expect_visible') await target.waitFor({ state: 'visible' });
  else if (step.action === 'click') await target.click();
  else if (step.action === 'fill') await target.fill(step.value ?? '');
  else if (step.action === 'select') await target.selectOption(step.value ?? '');
  else throw new Error(`Unknown browser action: ${step.action}`);
}

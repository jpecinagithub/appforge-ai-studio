import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium, type Page, type BrowserContext } from 'playwright-core';
import type { ToolResult } from 'appforge-shared';

export interface BrowserStep {
  action: 'click' | 'fill' | 'select' | 'expect_text' | 'reload';
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const errors: string[] = [];
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
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 400 && ['document', 'script', 'stylesheet', 'image'].includes(response.request().resourceType())) {
        errors.push(`HTTP ${response.status()}: ${response.url()}`);
      }
    });
    page.on('requestfailed', (request) => {
      if (['document', 'script', 'stylesheet', 'image'].includes(request.resourceType())) errors.push(`Resource failed: ${request.url()}`);
    });
    const remaining = Math.max(1, timeoutMs - (Date.now() - t0));
    const work = async () => {
      await page.goto(url, { waitUntil: 'networkidle', timeout: Math.min(remaining, 15_000) });
      await page.waitForFunction('document.body.innerText.trim().length > 0', undefined, { timeout: 5000 });
      await assertImagesLoaded(page);
      const screenshot = screenshotPath
        ? await page.screenshot({
          type: 'webp',
          quality: 78,
          animations: 'disabled',
          clip: { x: 0, y: 0, width: 1280, height: 720 },
        })
        : null;
      for (const step of steps) await browserStep(page, step);
      const text = (await page.locator('body').innerText()).slice(0, 6000);
      // Capture accessible controls as feedback for the agent's next interaction test.
      const snapshot = (await page.locator('body').ariaSnapshot()).slice(0, 8000);
      const interactiveControls = await page.locator('button:visible, input:visible, select:visible, textarea:visible, [role="button"]:visible').count();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction('document.body.innerText.trim().length > 0', undefined, { timeout: 5000 });
      await assertImagesLoaded(page);
      if (errors.length) throw new Error([...new Set(errors)].join('\n'));
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
    const diagnostic = [...new Set([...errors, (error as Error).message])].join('\n');
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const errors: string[] = [];
  try {
    browser = await chromium.launch({
      executablePath: process.env.APPFORGE_BROWSER_EXECUTABLE || undefined,
      headless: true, timeout: Math.min(timeoutMs, 15_000), args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 400 && ['document', 'script', 'stylesheet', 'image'].includes(response.request().resourceType())) {
        errors.push(`HTTP ${response.status()}: ${response.url()}`);
      }
    });
    page.on('requestfailed', (request) => {
      if (['document', 'script', 'stylesheet', 'image'].includes(request.resourceType())) errors.push(`Resource failed: ${request.url()}`);
    });
    const remaining = Math.max(1, timeoutMs - (Date.now() - t0));
    const work = async () => {
      await page.goto(url, { waitUntil: 'networkidle', timeout: Math.min(remaining, 15_000) });
      await page.waitForFunction('document.body.innerText.trim().length > 0', undefined, { timeout: 5000 });
      await assertImagesLoaded(page);
      for (const step of steps) await browserStep(page, step);
      const text = (await page.locator('body').innerText()).slice(0, 6000);
      const snapshot = (await page.locator('body').ariaSnapshot()).slice(0, 8000);
      if (errors.length) throw new Error([...new Set(errors)].join('\n'));
      await context.close();
      return { text, snapshot, stepsPassed: steps.length };
    };
    const data = await Promise.race([
      work(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Browser verification timed out')), remaining); }),
    ]);
    return { ok: true, data, output: `Chromium verified the live preview. ${steps.length} interaction steps passed.\n${data.snapshot}`, durationMs: Date.now() - t0 };
  } catch (error) {
    const diagnostic = [...new Set([...errors, (error as Error).message])].join('\n');
    return { ok: false, code: 'BROWSER_FAILED', error: diagnostic, output: diagnostic, durationMs: Date.now() - t0 };
  } finally {
    if (timer) clearTimeout(timer);
    await browser?.close();
  }
}

async function assertImagesLoaded(page: Page): Promise<void> {
  const broken = await page.locator('img').evaluateAll((images) => images
    .map((image) => image as unknown as { complete: boolean; naturalWidth: number; currentSrc: string; src: string; alt: string })
    .filter((image) => image.complete && image.naturalWidth === 0)
    .map((image) => ({ src: image.currentSrc || image.src, alt: image.alt })));
  if (broken.length > 0) {
    const detail = broken.slice(0, 8).map((image) => `${image.alt || '(no alt)'}: ${image.src}`).join('\n');
    throw new Error(`Broken images detected:\n${detail}`);
  }
}

async function browserStep(page: Page, step: BrowserStep): Promise<void> {
  if (step.action === 'reload') { await page.reload({ waitUntil: 'networkidle' }); return; }
  if (step.action === 'expect_text') {
    if (!step.value) throw new Error('expect_text requires value');
    const scope = step.selector ? page.locator(step.selector) : page;
    await scope.getByText(step.value, { exact: true }).first().waitFor({ state: 'visible' });
    return;
  }
  if (!step.selector) throw new Error(`${step.action} requires a CSS selector`);
  const target = page.locator(step.selector);
  if (step.action === 'click') await target.click();
  else if (step.action === 'fill') await target.fill(step.value ?? '');
  else if (step.action === 'select') await target.selectOption(step.value ?? '');
  else throw new Error(`Unknown browser action: ${step.action}`);
}

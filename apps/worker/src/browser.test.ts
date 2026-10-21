import { expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { SourceMapGenerator } from 'source-map-js';
import {
  checkBrowser,
  checkBrowserAtUrl,
  composeFailureDiagnostic,
  escapedBasePathWarnings,
  type BrowserSession,
  type PageDiagnostics,
} from './browser.js';

async function servePage(
  html: string,
  routes: Record<string, { status: number; body?: string }> = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const route = routes[pathname];
    if (route) {
      res.writeHead(route.status, { 'Content-Type': 'application/json' });
      res.end(route.body ?? '{}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

it('keeps localStorage between browser tool calls despite temporary port changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-browser-'));
  const session: BrowserSession = {};
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<button>Me gusta</button><p id="count"></p><script>let n=Number(localStorage.getItem("likes")||0);const show=()=>document.getElementById("count").textContent="Likes: "+n;show();document.querySelector("button").onclick=()=>{localStorage.setItem("likes",String(++n));show();};</script>');
    const first = await checkBrowser(dir, 'test', [{ action: 'click', selector: 'button' }, { action: 'expect_text', value: 'Likes: 1' }], 30000, session);
    expect(first.ok).toBe(true);
    const second = await checkBrowser(dir, 'test', [{ action: 'reload' }, { action: 'expect_text', selector: '#count', value: 'Likes: 1' }], 30000, session);
    expect(second.ok).toBe(true);
    const partial = await checkBrowser(dir, 'test', [{ action: 'expect_text', value: '1' }], 30000, session);
    expect(partial.ok).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it('rejects a bundle with a broken image', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-browser-image-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Catalog</h1><img src="./missing.jpg" alt="Missing motorcycle">');
    const result = await checkBrowser(dir, 'broken-image', [], 30000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Broken images detected');
    expect(result.error).toContain('Missing motorcycle');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it('failure diagnostic names the failed step, the page error and the missing data-testid', async () => {
  // Reproduces the pcBOX shape: a render crash (toFixed on undefined) and a
  // step waiting for a [data-testid="user-email"] that never appears.
  const srv = await servePage(`<!doctype html><html><head><title>Diag Shop</title></head><body>
    <div data-testid="auth-screen"><h1>Sign in to the shop</h1></div>
    <p data-testid="product-price">Price pending</p>
    <script>
      const price = undefined;
      document.querySelector('[data-testid="product-price"]').textContent = price.toFixed(2);
    </script>
  </body></html>`);
  try {
    const result = await checkBrowserAtUrl(srv.url, [
      { action: 'expect_text', selector: '[data-testid="user-email"]', value: 'someone@example.com' },
    ], 30000);
    expect(result.ok).toBe(false);
    const error = result.error ?? '';
    expect(error).toContain('step 1/1 (expect_text "[data-testid="user-email"]") failed:');
    expect(error).toContain('PAGE ERRORS:');
    expect(error).toContain("Cannot read properties of undefined (reading 'toFixed')");
    expect(error).toContain('selector [data-testid="user-email"]: NOT PRESENT in DOM');
    expect(error).toContain('DATA-TESTID INVENTORY:');
    expect(error).toContain('product-price');
    expect(error).toContain('auth-screen');
  } finally { await srv.close(); }
});

it('failure diagnostic lists /api/ network failures, not just static resources', async () => {
  const srv = await servePage(`<!doctype html><html><head><title>Api Shop</title></head><body>
    <h1>Shop home</h1>
    <button data-testid="ok-button">OK</button>
    <script>fetch('/api/boom').catch(() => {});</script>
  </body></html>`, { '/api/boom': { status: 500, body: '{"error":{"code":"BOOM"}}' } });
  try {
    const result = await checkBrowserAtUrl(srv.url, [
      { action: 'expect_visible', selector: '[data-testid="ok-button"]' },
      { action: 'expect_visible', selector: '[data-testid="missing-thing"]' },
    ], 30000);
    expect(result.ok).toBe(false);
    const error = result.error ?? '';
    expect(error).toContain('step 2/2 (expect_visible "[data-testid="missing-thing"]") failed:');
    expect(error).toContain('NETWORK FAILURES:');
    expect(error).toContain('HTTP 500 GET /api/boom');
  } finally { await srv.close(); }
});

it('fails when a step reveals a broken or empty image (post-steps assertion sees the final screen)', async () => {
  // The login/first screen has no images at all: the pre-steps assertion
  // passes. Only after the click does the (post-login) catalog render its
  // product photos — broken and empty — which is exactly the pcBOX shape
  // that used to verify green.
  const srv = await servePage(`<!doctype html><html><head><title>Post Steps Shop</title></head><body>
    <h1>Sign in</h1>
    <button data-testid="show-products">Show products</button>
    <div id="slot"></div>
    <script>
      document.querySelector('[data-testid="show-products"]').addEventListener('click', () => {
        document.getElementById('slot').innerHTML =
          '<p>Products loaded</p>' +
          '<img src="/missing-product.jpg" alt="Broken product photo">' +
          '<img src="" alt="Empty product photo">';
      });
    </script>
  </body></html>`);
  try {
    const result = await checkBrowserAtUrl(srv.url, [
      { action: 'click', selector: '[data-testid="show-products"]' },
      { action: 'expect_text', value: 'Products loaded' },
    ], 30000);
    expect(result.ok).toBe(false);
    const error = result.error ?? '';
    expect(error).toContain('Broken images detected');
    expect(error).toContain('Broken product photo');
    expect(error).toContain('Empty product photo');
  } finally { await srv.close(); }
});

it('passes when the image revealed by a step is healthy', async () => {
  const srv = await servePage(`<!doctype html><html><head><title>Healthy Shop</title></head><body>
    <h1>Sign in</h1>
    <button data-testid="show-products">Show products</button>
    <div id="slot"></div>
    <script>
      document.querySelector('[data-testid="show-products"]').addEventListener('click', () => {
        document.getElementById('slot').innerHTML =
          '<p>Products loaded</p>' +
          '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" alt="Healthy product photo">';
      });
    </script>
  </body></html>`);
  try {
    const result = await checkBrowserAtUrl(srv.url, [
      { action: 'click', selector: '[data-testid="show-products"]' },
      { action: 'expect_text', value: 'Products loaded' },
    ], 30000);
    expect(result.ok).toBe(true);
    expect(result.output ?? '').not.toContain('Broken images');
  } finally { await srv.close(); }
});

it('fails with a page error thrown only after an interaction, snapshotting the final screen', async () => {
  const srv = await servePage(`<!doctype html><html><head><title>Boom Shop</title></head><body>
    <h1>Interactive shop</h1>
    <button data-testid="explode">Load</button>
    <p id="marker">Before click</p>
    <script>
      document.querySelector('[data-testid="explode"]').addEventListener('click', () => {
        document.getElementById('marker').textContent = 'Final screen after click';
        throw new Error('boom after click');
      });
    </script>
  </body></html>`);
  try {
    const result = await checkBrowserAtUrl(srv.url, [
      { action: 'click', selector: '[data-testid="explode"]' },
      { action: 'expect_text', value: 'Final screen after click' },
    ], 30000);
    expect(result.ok).toBe(false);
    const error = result.error ?? '';
    expect(error).toContain('PAGE ERRORS:');
    expect(error).toContain('boom after click');
    // The failure snapshot reflects the FINAL screen, not the initial one.
    expect(error).toContain('Final screen after click');
  } finally { await srv.close(); }
});

it('a passing flow carries no failure diagnostic block', async () => {
  const srv = await servePage(`<!doctype html><html><head><title>Ok Shop</title></head><body>
    <h1>Welcome</h1>
    <p data-testid="user-email">someone@example.com</p>
  </body></html>`);
  try {
    const result = await checkBrowserAtUrl(srv.url, [
      { action: 'expect_text', selector: '[data-testid="user-email"]', value: 'someone@example.com' },
    ], 30000);
    expect(result.ok).toBe(true);
    expect(result.output ?? '').not.toContain('PAGE ERRORS:');
    expect(result.output ?? '').not.toContain('NETWORK FAILURES:');
    expect(result.output ?? '').not.toContain('NOT PRESENT in DOM');
    expect(result.output ?? '').not.toContain(') failed:');
  } finally { await srv.close(); }
});

it('resolves the page-error stack through the bundle sourcemap in the diagnostic', async () => {
  // The T-shirts shape: a render crash whose stack only names the minified
  // bundle. With a sourcemap next to the bundle, the diagnostic must also
  // carry the ORIGINAL location (frontend/src/App.tsx:300) so the agent
  // can open the file and fix the line instead of patching blind.
  const gen = new SourceMapGenerator({ file: 'bundle.js' });
  gen.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 300, column: 4 },
    source: '../../src/App.tsx',
  });
  const bundle = "throw new Error('kaboom from the catalog render');\n//# sourceMappingURL=bundle.js.map";
  const map = gen.toString();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/a/shop1/assets/bundle.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(bundle);
      return;
    }
    if (pathname === '/a/shop1/assets/bundle.js.map') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(map);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>Crash Shop</title></head><body><h1>Crash Shop</h1><script src="./assets/bundle.js"></script></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  try {
    const result = await checkBrowserAtUrl(`http://127.0.0.1:${addr.port}/a/shop1/`, [], 30000);
    expect(result.ok).toBe(false);
    const error = result.error ?? '';
    expect(error).toContain('kaboom from the catalog render');
    expect(error).toContain('↳ original: frontend/src/App.tsx:300');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('base path warnings name the escaped request and stay silent otherwise', () => {
  const page = 'http://127.0.0.1:3001/a/shop1/';
  // The T-shirts signature: the app's own API works below the base, the
  // hand-written absolute path escaped it.
  const warnings = escapedBasePathWarnings(page, [
    'http://127.0.0.1:3001/a/shop1/api/auth/me',
    'http://127.0.0.1:3001/api/shirts',
  ]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('request escaped the app base path');
  expect(warnings[0]).toContain('/api/shirts');
  expect(warnings[0]).toContain('/a/shop1/');
  expect(warnings[0]).toContain('absolute /api path');
  // Prefix-sibling paths are still escapes (base ends with '/').
  expect(escapedBasePathWarnings(page, ['http://127.0.0.1:3001/a/shop1x/api'])).toHaveLength(1);
  // The bare base without trailing slash is the app itself, not an escape.
  expect(escapedBasePathWarnings(page, ['http://127.0.0.1:3001/a/shop1'])).toEqual([]);
  // External origins owe nothing to the base path.
  expect(escapedBasePathWarnings(page, ['https://cdn.example.com/api/shirts'])).toEqual([]);
  // An app served at the root has no prefix to escape.
  expect(escapedBasePathWarnings('http://127.0.0.1:3001/', ['http://127.0.0.1:3001/api/shirts'])).toEqual([]);
});

it('diagnostic carries the BASE PATH WARNING next to the network failures', async () => {
  const srv = await servePage(`<!doctype html><html><head><title>Escape Shop</title></head><body>
    <h1>Escape Shop</h1>
    <p data-testid="user-email">someone@example.com</p>
    <script>
      fetch('/a/shop1/api/auth/me').catch(() => {});
      fetch('/api/shirts').catch(() => {});
    </script>
  </body></html>`, {
    '/a/shop1/api/auth/me': { status: 401, body: '{"error":{"code":"UNAUTHORIZED"}}' },
    '/api/shirts': { status: 404, body: '{"error":{"code":"NOT_FOUND"}}' },
  });
  try {
    // Navigate "into" the app prefix; a step then fails so the diagnostic
    // is composed from the same screen the flow saw.
    const result = await checkBrowserAtUrl(`${srv.url}a/shop1/`, [
      { action: 'expect_text', selector: '[data-testid="user-email"]', value: 'someone@example.com' },
      { action: 'expect_visible', selector: '[data-testid="never-rendered"]' },
    ], 30000);
    expect(result.ok).toBe(false);
    const error = result.error ?? '';
    expect(error).toContain('NETWORK FAILURES:');
    expect(error).toContain('HTTP 404 GET /api/shirts');
    expect(error).toContain('BASE PATH WARNING:');
    expect(error).toContain('request escaped the app base path: /api/shirts');
    // The in-prefix 401 is normal auth probing: listed, never warned about.
    expect(error).not.toContain('escaped the app base path: /a/shop1/api/auth/me');
  } finally { await srv.close(); }
});

it('caps the composed diagnostic at ~6000 chars with the actionable parts first', () => {
  const diag: PageDiagnostics = {
    pageErrors: ["TypeError: Cannot read properties of undefined (reading 'toFixed')"],
    hardNetwork: [],
    network: ['HTTP 500 POST /a/shop1/api/auth/login'],
    networkUrls: ['http://127.0.0.1/a/shop1/api/auth/login'],
    consoleErrors: ['some console error'],
  };
  const out = composeFailureDiagnostic({
    primaryError: new Error('locator timed out'),
    failedStep: { index: 5, total: 9, step: { action: 'expect_text', selector: '[data-testid="user-email"]', value: 'x@example.com' } },
    diag,
    snapshot: {
      url: 'http://127.0.0.1/a/shop1/',
      title: 'Shop',
      selectorVerdict: 'selector [data-testid="user-email"]: NOT PRESENT in DOM',
      testIds: Array.from({ length: 40 }, (_, i) => `tid-${i}`),
      visibleText: 'lorem ipsum '.repeat(2000),
    },
  });
  expect(out.length).toBeLessThanOrEqual(6000);
  expect(out.startsWith('step 5/9 (expect_text "[data-testid="user-email"]") failed: locator timed out')).toBe(true);
  expect(out).toContain('PAGE ERRORS:');
  expect(out).toContain('NOT PRESENT in DOM');
  expect(out).toContain('HTTP 500 POST /a/shop1/api/auth/login');
});

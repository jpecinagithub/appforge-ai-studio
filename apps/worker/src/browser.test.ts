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
  routes: Record<string, { status: number; body?: string | Buffer; contentType?: string }> = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const route = routes[pathname];
    if (route) {
      res.writeHead(route.status, { 'Content-Type': route.contentType ?? 'application/json' });
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

it('reload does not wait for network rest: a slow product photo cannot fail a recovered session', async () => {
  // Regression, T-shirts 497f482d run 0488ed8a: with the shop wired, the
  // authenticated flow failed 3x at the reload step (6/9) — "page.reload:
  // Timeout 5000ms exceeded, waiting for navigation until networkidle" —
  // while its own failure snapshot showed the catalog and the signed-in
  // email. A grid of ~20 product photos keeps connections open far longer
  // than the 5s navigation ceiling. The reload's fact is session
  // persistence, judged by the expectation that follows it — so a slow
  // photo must not be able to fail the step sequence below.
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/slow-photo.jpg') {
      // Slower than the old 5s navigation ceiling, faster than the 15s
      // initial-goto ceiling: under the old networkidle waits the first
      // load survived (idle at ~7s) and only the reload died — the exact
      // production signature.
      const timer = setTimeout(() => {
        try {
          res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
          res.end(Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));
        } catch { /* browser already gone */ }
      }, 6_500);
      timer.unref();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Premier League Shirts</title></head><body>
      <h1>Tienda de Camisetas Premier League</h1>
      <p data-testid="user-email">someone@example.com</p>
      <img src="/slow-photo.jpg" alt="Arsenal Away Shirt">
      <p>Arsenal Away Shirt 74,99 €</p>
    </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  try {
    const result = await checkBrowserAtUrl(`http://127.0.0.1:${addr.port}/`, [
      { action: 'expect_text', selector: '[data-testid="user-email"]', value: 'someone@example.com' },
      { action: 'reload' },
      { action: 'expect_text', selector: '[data-testid="user-email"]', value: 'someone@example.com' },
    ], 60_000);
    expect(result.ok).toBe(true);
    expect((result.data as { stepsPassed: number }).stepsPassed).toBe(3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('reload still fails at the expectation when the session is not recovered after it', async () => {
  // The counterpart: when the reload genuinely loses the session, the flow
  // must fail on the user-email expectation that follows the reload (step
  // 3/3) — the fact the reload exists to set up — not on the navigation.
  const srv = await servePage(`<!doctype html><html><head><title>Session Shop</title></head><body>
    <h1>Session Shop</h1>
    <div id="slot"></div>
    <script>
      const loads = Number(sessionStorage.getItem('loads') || 0) + 1;
      sessionStorage.setItem('loads', String(loads));
      document.getElementById('slot').innerHTML = loads > 1
        ? '<div data-testid="auth-screen"><p>Sign in again</p></div>'
        : '<p data-testid="user-email">someone@example.com</p>';
    </script>
  </body></html>`);
  try {
    const result = await checkBrowserAtUrl(srv.url, [
      { action: 'expect_text', selector: '[data-testid="user-email"]', value: 'someone@example.com' },
      { action: 'reload' },
      { action: 'expect_text', selector: '[data-testid="user-email"]', value: 'someone@example.com' },
    ], 30_000);
    expect(result.ok).toBe(false);
    const error = result.error ?? '';
    expect(error).toContain('step 3/3 (expect_text "[data-testid="user-email"]") failed:');
    expect(error).not.toContain('page.reload');
    expect(error).not.toContain('waiting for navigation');
  } finally { await srv.close(); }
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

it('fails when a step reveals a broken or empty image (per-step assertion judges the screen the step leaves)', async () => {
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
  // Deliberate semantic change (honest image criterion): this test used to
  // reveal the "healthy" photo as an inline data URI. A data URI produces
  // no network response, so its provenance cannot be verified — under the
  // new criterion it no longer counts as a loaded photo (that is exactly
  // the hole an onError substitution exploited). The healthy photo is now
  // a real image served as image/png, which is what "healthy" must mean.
  const srv = await servePage(`<!doctype html><html><head><title>Healthy Shop</title></head><body>
    <h1>Sign in</h1>
    <button data-testid="show-products">Show products</button>
    <div id="slot"></div>
    <script>
      document.querySelector('[data-testid="show-products"]').addEventListener('click', () => {
        document.getElementById('slot').innerHTML =
          '<p>Products loaded</p>' +
          '<img src="/healthy-product.png" alt="Healthy product photo">';
      });
    </script>
  </body></html>`, {
    '/healthy-product.png': {
      status: 200,
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
    },
  });
  try {
    const result = await checkBrowserAtUrl(srv.url, [
      { action: 'click', selector: '[data-testid="show-products"]' },
      { action: 'expect_text', value: 'Products loaded' },
    ], 30000);
    expect(result.ok).toBe(true);
    expect(result.output ?? '').not.toContain('Broken images');
  } finally { await srv.close(); }
});

it('fails when an onError handler substitutes a missing photo with an inline placeholder', async () => {
  // Regression, deployed T-shirts 497f482d: product photos pointed at
  // absolute paths of files that never existed (/assets/products/*.jpg)
  // and the card's onError swapped each broken photo for an inline
  // placeholder, so every <img> ended with naturalWidth > 0 and the flow
  // verified green while production showed empty boxes. Under the honest
  // criterion the substituted image has no valid image response — the
  // swap target is a data URI, which produces no network response — and
  // the assertion must reject it BY NAME with the substitution reason.
  const srv = await servePage(`<!doctype html><html><head><title>Shirts Shop</title></head><body>
    <h1>Tienda de Camisetas Premier League</h1>
    <div class="card">
      <img src="/assets/products/arsenal-away.jpg" alt="Arsenal Away Shirt"
           onerror="this.onerror=null;this.src='data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';">
      <p>Arsenal Away Shirt</p>
      <p>74,99 €</p>
    </div>
  </body></html>`, {
    '/assets/products/arsenal-away.jpg': { status: 404, body: 'not found', contentType: 'text/plain' },
  });
  try {
    const result = await checkBrowserAtUrl(srv.url, [], 30000);
    expect(result.ok).toBe(false);
    const error = result.error ?? '';
    expect(error).toContain('Broken images detected');
    expect(error).toContain('Arsenal Away Shirt');
    expect(error).toContain('no valid image response observed');
    expect(error).toContain('error substitution');
    // The rejection reason is the missing provenance, not the old
    // naturalWidth verdict — the substituted image DID render pixels.
    expect(error).not.toContain('naturalWidth 0');
  } finally { await srv.close(); }
});

it('passes the same product card when the photo really arrives as an image response', async () => {
  // The A/B counterpart: identical page and onError handler, but the
  // photo URL serves real image bytes (200, image/png) — the handler
  // never fires and the observed response proves the photo loaded.
  const srv = await servePage(`<!doctype html><html><head><title>Shirts Shop</title></head><body>
    <h1>Tienda de Camisetas Premier League</h1>
    <div class="card">
      <img src="/assets/products/arsenal-away.jpg" alt="Arsenal Away Shirt"
           onerror="this.onerror=null;this.src='data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';">
      <p>Arsenal Away Shirt</p>
      <p>74,99 €</p>
    </div>
  </body></html>`, {
    '/assets/products/arsenal-away.jpg': {
      status: 200,
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
    },
  });
  try {
    const result = await checkBrowserAtUrl(srv.url, [], 30000);
    expect(result.ok).toBe(true);
    expect(result.output ?? '').not.toContain('Broken images');
  } finally { await srv.close(); }
});

it('passes when the app serves the platform illustrative placeholder as image/svg+xml', async () => {
  // The honest degradation path: the platform placeholder is a real file
  // the app serves itself (public/placeholder-illustrative.svg), so it
  // arrives as a 2xx image/svg+xml response and satisfies the criterion
  // on its own merits — unlike an inline data-URI swap, which cannot.
  const srv = await servePage(`<!doctype html><html><head><title>Placeholder Shop</title></head><body>
    <h1>Catalog</h1>
    <img src="/placeholder-illustrative.svg" alt="Imagen ilustrativa">
    <p>Product without a real photo yet</p>
  </body></html>`, {
    '/placeholder-illustrative.svg': {
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#3a4152"/><text x="400" y="430" text-anchor="middle" font-family="system-ui, sans-serif" font-size="28" fill="#c7cdd9">Imagen ilustrativa</text></svg>',
    },
  });
  try {
    const result = await checkBrowserAtUrl(srv.url, [], 30000);
    expect(result.ok).toBe(true);
    expect(result.output ?? '').not.toContain('Broken images');
  } finally { await srv.close(); }
});

it('fails mid-flow when the content screen between steps carries a substituted photo, even if the final screen is clean', async () => {
  // Regression, T-shirts run fac615d3: the product grid lives BETWEEN the
  // authenticated flow's steps (after login, before logout), and the
  // image assertions only judged the first and the final screen — both
  // the login form — so a shop whose 40 product photos pointed at files
  // that never existed closed 6/6. Three screens here: sign-in (no
  // images) -> catalog (one onError-substituted photo, the exact
  // production signature) -> signed out (no images). The endpoints are
  // clean; only the new per-step assertion can fail this, and it must
  // name the step that led to the offending screen.
  const srv = await servePage(`<!doctype html><html><head><title>Flow Shirts Shop</title></head><body>
    <h1>Sign in</h1>
    <button data-testid="enter-shop">Enter shop</button>
    <div id="slot"></div>
    <script>
      const slot = document.getElementById('slot');
      document.querySelector('[data-testid="enter-shop"]').addEventListener('click', () => {
        slot.innerHTML =
          '<h2>Catalog</h2>' +
          '<img src="/assets/products/arsenal-away.jpg" alt="Arsenal Away Shirt" onerror="this.onerror=null;this.src=\\'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==\\';">' +
          '<p>Arsenal Away Shirt</p>' +
          '<button data-testid="leave-shop">Sign out</button>';
        document.querySelector('[data-testid="leave-shop"]').addEventListener('click', () => {
          slot.innerHTML = '<p>Signed out</p>';
        });
      });
    </script>
  </body></html>`, {
    '/assets/products/arsenal-away.jpg': { status: 404, body: 'not found', contentType: 'text/plain' },
  });
  try {
    const result = await checkBrowserAtUrl(srv.url, [
      { action: 'click', selector: '[data-testid="enter-shop"]' },
      { action: 'expect_text', value: 'Arsenal Away Shirt' },
      { action: 'click', selector: '[data-testid="leave-shop"]' },
    ], 30000);
    expect(result.ok).toBe(false);
    const error = result.error ?? '';
    expect(error).toContain('image assertion failed after step 1/3 (click "[data-testid="enter-shop"]")');
    expect(error).toContain('Broken images detected');
    expect(error).toContain('Arsenal Away Shirt');
    expect(error).toContain('no valid image response observed');
    // The flow stopped at the offending screen: the snapshot shows the
    // catalog, and the clean sign-out screen was never reached.
    expect(error).toContain('Catalog');
    expect(error).not.toContain('Signed out');
  } finally { await srv.close(); }
});

it('passes a three-screen flow whose middle screen carries a real photo', async () => {
  // The counterpart: identical navigation shape, but the catalog photo
  // really arrives as an image response — every per-step assertion
  // passes and the flow completes all three steps.
  const srv = await servePage(`<!doctype html><html><head><title>Flow Shirts Shop</title></head><body>
    <h1>Sign in</h1>
    <button data-testid="enter-shop">Enter shop</button>
    <div id="slot"></div>
    <script>
      const slot = document.getElementById('slot');
      document.querySelector('[data-testid="enter-shop"]').addEventListener('click', () => {
        slot.innerHTML =
          '<h2>Catalog</h2>' +
          '<img src="/assets/products/arsenal-away.jpg" alt="Arsenal Away Shirt">' +
          '<p>Arsenal Away Shirt</p>' +
          '<button data-testid="leave-shop">Sign out</button>';
        document.querySelector('[data-testid="leave-shop"]').addEventListener('click', () => {
          slot.innerHTML = '<p>Signed out</p>';
        });
      });
    </script>
  </body></html>`, {
    '/assets/products/arsenal-away.jpg': {
      status: 200,
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
    },
  });
  try {
    const result = await checkBrowserAtUrl(srv.url, [
      { action: 'click', selector: '[data-testid="enter-shop"]' },
      { action: 'expect_text', value: 'Arsenal Away Shirt' },
      { action: 'click', selector: '[data-testid="leave-shop"]' },
    ], 30000);
    expect(result.ok).toBe(true);
    expect((result.data as { stepsPassed: number }).stepsPassed).toBe(3);
    expect(result.output ?? '').not.toContain('Broken images');
  } finally { await srv.close(); }
});

it('passes a multi-screen flow with no images on any screen (per-step assertions stay silent)', async () => {
  // Vacuity guard: screens without photos must not trip the per-step
  // assertions — an empty image set is a pass, not a failure.
  const srv = await servePage(`<!doctype html><html><head><title>Text Only App</title></head><body>
    <h1>Sign in</h1>
    <button data-testid="enter-app">Enter</button>
    <div id="slot"></div>
    <script>
      const slot = document.getElementById('slot');
      document.querySelector('[data-testid="enter-app"]').addEventListener('click', () => {
        slot.innerHTML =
          '<h2>Welcome back</h2>' +
          '<p>Your tasks are text only.</p>' +
          '<button data-testid="leave-app">Sign out</button>';
        document.querySelector('[data-testid="leave-app"]').addEventListener('click', () => {
          slot.innerHTML = '<p>Signed out</p>';
        });
      });
    </script>
  </body></html>`);
  try {
    const result = await checkBrowserAtUrl(srv.url, [
      { action: 'click', selector: '[data-testid="enter-app"]' },
      { action: 'expect_text', value: 'Welcome back' },
      { action: 'click', selector: '[data-testid="leave-app"]' },
      { action: 'expect_text', value: 'Signed out' },
    ], 30000);
    expect(result.ok).toBe(true);
    expect((result.data as { stepsPassed: number }).stepsPassed).toBe(4);
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
    imageResponses: new Map(),
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

import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBrowser, type BrowserSession } from './browser.js';

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

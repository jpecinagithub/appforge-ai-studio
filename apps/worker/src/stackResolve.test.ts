/**
 * Source-map stack resolution — unit tests (agent's eyes, 2026-10-21).
 *
 * The fixture is a synthetic bundle + map built with source-map-js's own
 * generator: frame (line 1, col 1 in V8 1-based terms) maps to
 * src/App.tsx:300 and (line 1, col 21) to src/components/ShirtCard.tsx:12
 * — the shape of the T-shirts crash, where the agent only saw the
 * minified `index-BRfdI1yM.js:238:16108`.
 */
import { describe, expect, it } from 'vitest';
import { SourceMapGenerator } from 'source-map-js';
import {
  enrichStackWithSourceLocations,
  normalizeSourcePath,
  parseStackFrames,
  type FetchText,
} from './stackResolve.js';

const BUNDLE_URL = 'http://127.0.0.1:3001/a/p1/assets/index-abc.js';

function fixtureFetch(): FetchText {
  const gen = new SourceMapGenerator({ file: 'index-abc.js' });
  gen.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 300, column: 4 },
    source: '../../src/App.tsx',
  });
  gen.addMapping({
    generated: { line: 1, column: 20 },
    original: { line: 12, column: 0 },
    source: '../../src/components/ShirtCard.tsx',
  });
  const map = gen.toString();
  const bundle = "throw new Error('kaboom');\n//# sourceMappingURL=index-abc.js.map";
  return async (url) => {
    if (url === BUNDLE_URL) return bundle;
    if (url === `${BUNDLE_URL}.map`) return map;
    return null;
  };
}

const STACK = [
  "TypeError: Cannot read properties of undefined (reading 'map')",
  `    at PO (${BUNDLE_URL}:1:1)`,
  `    at Object.react_stack_bottom_frame (${BUNDLE_URL}:1:21)`,
  `    at wd (${BUNDLE_URL}:1:1)`,
].join('\n');

describe('parseStackFrames', () => {
  it('extracts named and anonymous frames, deduped, in order', () => {
    const frames = parseStackFrames([
      'Error: x',
      `    at PO (${BUNDLE_URL}:238:16108)`,
      `    at ${BUNDLE_URL}:10:5`,
      `    at PO (${BUNDLE_URL}:238:16108)`,
      '    at node:internal/process/task_queues:95:5',
    ].join('\n'));
    expect(frames).toEqual([
      { url: BUNDLE_URL, line: 238, column: 16108 },
      { url: BUNDLE_URL, line: 10, column: 5 },
    ]);
  });

  it('ignores stacks without http frames', () => {
    expect(parseStackFrames('Error: plain\n    at foo (native)')).toEqual([]);
  });
});

describe('normalizeSourcePath', () => {
  it('maps bundle-relative sources to the frontend tree', () => {
    expect(normalizeSourcePath('../../src/App.tsx')).toBe('frontend/src/App.tsx');
    expect(normalizeSourcePath('../src/components/ShirtCard.tsx')).toBe('frontend/src/components/ShirtCard.tsx');
    expect(normalizeSourcePath('/src/App.tsx')).toBe('frontend/src/App.tsx');
    expect(normalizeSourcePath('frontend/src/App.tsx')).toBe('frontend/src/App.tsx');
  });

  it('leaves non-app sources readable', () => {
    expect(normalizeSourcePath('../../node_modules/react-dom/cjs/react-dom.js')).toBe('node_modules/react-dom/cjs/react-dom.js');
  });
});

describe('enrichStackWithSourceLocations', () => {
  it('annotates the frames with their original .tsx locations', async () => {
    const out = await enrichStackWithSourceLocations(STACK, fixtureFetch());
    expect(out).toContain('↳ original: frontend/src/App.tsx:300:5');
    expect(out).toContain('↳ original: frontend/src/components/ShirtCard.tsx:12:1');
    // The minified frames themselves stay, with the resolution next to them.
    expect(out).toContain(`at PO (${BUNDLE_URL}:1:1)`);
    expect(out.indexOf('frontend/src/App.tsx:300:5')).toBeGreaterThan(out.indexOf(`at PO (${BUNDLE_URL}:1:1)`));
  });

  it('returns the stack untouched when the bundle or map cannot be fetched', async () => {
    const noFetch: FetchText = async () => null;
    expect(await enrichStackWithSourceLocations(STACK, noFetch)).toBe(STACK);
  });

  it('returns the stack untouched when the bundle has no usable map', async () => {
    const noMap: FetchText = async (url) => (url === BUNDLE_URL ? 'var x = 1;' : null);
    expect(await enrichStackWithSourceLocations(STACK, noMap)).toBe(STACK);
  });

  it('supports inline data: sourcemaps', async () => {
    const gen = new SourceMapGenerator({ file: 'index-abc.js' });
    gen.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 300, column: 4 },
      source: '../../src/App.tsx',
    });
    const b64 = Buffer.from(gen.toString(), 'utf8').toString('base64');
    const bundle = `throw new Error('kaboom');\n//# sourceMappingURL=data:application/json;base64,${b64}`;
    const fetchText: FetchText = async (url) => (url === BUNDLE_URL ? bundle : null);
    const out = await enrichStackWithSourceLocations(STACK, fetchText);
    expect(out).toContain('↳ original: frontend/src/App.tsx:300:5');
  });

  it('never throws on a malformed map', async () => {
    const broken: FetchText = async (url) => (url === BUNDLE_URL
      ? "x();\n//# sourceMappingURL=index-abc.js.map"
      : '{not json');
    await expect(enrichStackWithSourceLocations(STACK, broken)).resolves.toBe(STACK);
  });
});

/**
 * Source-map resolution for browser page-error stacks (agent's eyes,
 * 2026-10-21).
 *
 * Live case (project "T-shirts" 8863cc94, run 977a3ab8): the authenticated
 * flow failed with `Cannot read properties of undefined (reading 'map')`
 * and a MINIFIED stack (`at PO (…/assets/index-BRfdI1yM.js:238:16108)`).
 * The diagnostic listed the smoking gun (a 404 on an absolute /api path)
 * but the crash itself could not be located in the sources, so three
 * intervention-ladder directives were spent patching around it.
 *
 * This module maps the frames of a page-error stack back to the original
 * sources through the bundle's sourcemap, so the failure diagnostic can
 * say `frontend/src/App.tsx:300` next to the minified frame. The frontend
 * verification build emits the maps (run_frontend_build passes
 * --sourcemap); production app images build without them.
 *
 * Everything here is best-effort decoration: no map, an unreachable
 * bundle, an unparseable map or an unmapped frame leave the stack text
 * exactly as collected. It never throws.
 */
import { SourceMapConsumer, type RawSourceMap } from 'source-map-js';

/** Fetches a text resource, or null when unavailable. Injectable for tests. */
export type FetchText = (url: string) => Promise<string | null>;

export interface StackFrame {
  url: string;
  /** 1-based line, as printed in the stack. */
  line: number;
  /** 1-based column, as printed in the stack. */
  column: number;
}

const NAMED_FRAME_RE = /^\s*at\s+.*?\((https?:\/\/[^\s()]+):(\d+):(\d+)\)\s*$/;
const ANON_FRAME_RE = /^\s*at\s+(https?:\/\/[^\s()]+):(\d+):(\d+)\s*$/;

/** Extract the http(s) frames of a V8-style stack, in order, deduped. */
export function parseStackFrames(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const seen = new Set<string>();
  for (const rawLine of stack.split('\n')) {
    const m = NAMED_FRAME_RE.exec(rawLine) ?? ANON_FRAME_RE.exec(rawLine);
    if (!m) continue;
    const frame: StackFrame = { url: m[1]!, line: Number(m[2]), column: Number(m[3]) };
    const key = `${frame.url}:${frame.line}:${frame.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    frames.push(frame);
  }
  return frames;
}

/**
 * Present a sourcemap `sources` entry the way the project tree is laid
 * out: map sources are relative to the bundle (e.g. `../../src/App.tsx`
 * for a file in frontend/dist/assets), so leading `../` / `./` segments
 * are stripped, and a path under the app sources is shown with its
 * frontend/ prefix (`frontend/src/App.tsx`). Anything else (notably
 * node_modules/…) is shown as-is.
 */
export function normalizeSourcePath(source: string): string {
  let s = source.split('?')[0]!.replace(/\\/g, '/');
  const scheme = s.indexOf('://');
  if (scheme >= 0) s = s.slice(scheme + 3);
  s = s.replace(/^(\.\.\/)+/, '').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (s.startsWith('src/')) return `frontend/${s}`;
  return s;
}

type Consumer = InstanceType<typeof SourceMapConsumer>;

/** Per-diagnostic cache: bundle URL → consumer (null = no usable map). */
export type SourceMapCache = Map<string, Consumer | null>;

async function loadConsumer(bundleUrl: string, fetchText: FetchText, cache: SourceMapCache): Promise<Consumer | null> {
  const cached = cache.get(bundleUrl);
  if (cached !== undefined) return cached;
  let consumer: Consumer | null = null;
  try {
    const js = await fetchText(bundleUrl);
    let mapText: string | null = null;
    if (js) {
      const marker = js.lastIndexOf('//# sourceMappingURL=');
      const ref = marker >= 0 ? js.slice(marker + '//# sourceMappingURL='.length).split('\n')[0]!.trim() : '';
      if (ref.startsWith('data:')) {
        const comma = ref.indexOf(',');
        if (comma > 0) {
          const meta = ref.slice(0, comma);
          const payload = ref.slice(comma + 1);
          mapText = meta.includes(';base64')
            ? Buffer.from(payload, 'base64').toString('utf8')
            : decodeURIComponent(payload);
        }
      } else if (ref) {
        mapText = await fetchText(new URL(ref, bundleUrl).href);
      } else {
        // No comment: Vite always emits one with --sourcemap, but a plain
        // sibling .map is the only other place a map can live.
        mapText = await fetchText(`${bundleUrl}.map`);
      }
    }
    if (mapText) {
      consumer = await new SourceMapConsumer(JSON.parse(mapText) as RawSourceMap);
    }
  } catch {
    consumer = null;
  }
  cache.set(bundleUrl, consumer);
  return consumer;
}

/** Resolve one frame to `frontend/src/App.tsx:300:5`, or null. */
async function resolveFrame(frame: StackFrame, fetchText: FetchText, cache: SourceMapCache): Promise<string | null> {
  const consumer = await loadConsumer(frame.url, fetchText, cache);
  if (!consumer) return null;
  try {
    // Stack columns are 1-based; sourcemap columns are 0-based.
    const original = consumer.originalPositionFor({ line: frame.line, column: frame.column - 1 });
    if (!original.source || original.line == null) return null;
    return `${normalizeSourcePath(original.source)}:${original.line}:${(original.column ?? 0) + 1}`;
  } catch {
    return null;
  }
}

/**
 * Return the stack text with a `↳ original: <source>:<line>:<col>` line
 * inserted after each of the first `maxResolved` frames that resolve
 * through a sourcemap. Unresolvable input is returned unchanged.
 */
export async function enrichStackWithSourceLocations(
  stack: string,
  fetchText: FetchText,
  cache: SourceMapCache = new Map(),
  maxResolved = 2,
): Promise<string> {
  if (!stack.includes('://')) return stack;
  const lines = stack.split('\n');
  const out: string[] = [];
  let resolved = 0;
  for (const rawLine of lines) {
    out.push(rawLine);
    if (resolved >= maxResolved) continue;
    const m = NAMED_FRAME_RE.exec(rawLine) ?? ANON_FRAME_RE.exec(rawLine);
    if (!m) continue;
    const frame: StackFrame = { url: m[1]!, line: Number(m[2]), column: Number(m[3]) };
    const location = await resolveFrame(frame, fetchText, cache);
    if (location) {
      const indent = /^\s*/.exec(rawLine)?.[0] ?? '';
      out.push(`${indent}↳ original: ${location}`);
      resolved++;
    }
  }
  return resolved > 0 ? out.join('\n') : stack;
}

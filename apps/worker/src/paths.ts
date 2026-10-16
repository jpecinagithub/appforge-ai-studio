/** Shared path utilities (no dependencies — safe to import from anywhere). */
import path from 'node:path';

/**
 * Resolve `p` inside `root`, rejecting null bytes and `..`/absolute escapes.
 * Throws an Error with code 'INVALID_PATH' on violation.
 */
export function resolveIn(root: string, p: string): string {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) {
    const e = new Error(`invalid path: ${JSON.stringify(p)}`) as Error & { code: string };
    e.code = 'INVALID_PATH';
    throw e;
  }
  const absRoot = path.resolve(root);
  const resolved = path.resolve(absRoot, p);
  if (resolved !== absRoot && !resolved.startsWith(absRoot + path.sep)) {
    const e = new Error(`path escapes project directory: ${p}`) as Error & { code: string };
    e.code = 'INVALID_PATH';
    throw e;
  }
  return resolved;
}

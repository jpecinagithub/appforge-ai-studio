import fs from 'node:fs';
import path from 'node:path';

export interface MissingLocalImage {
  alt: string;
  requestPath: string;
  publicRelativePath: string;
  acquisitionPath: string;
  query: string;
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.json']);

/** Extract local image 404s from browser diagnostics, preserving useful alt text. */
export function extractMissingLocalImages(diagnostic: string, projectId: string): MissingLocalImage[] {
  const altByUrl = new Map<string, string>();
  for (const line of diagnostic.split('\n')) {
    const match = line.match(/^(.+?):\s+(https?:\/\/127\.0\.0\.1:\d+\/\S+)$/);
    if (match && !match[1].startsWith('HTTP ')) altByUrl.set(match[2], match[1].trim());
  }

  const found = new Map<string, MissingLocalImage>();
  for (const match of diagnostic.matchAll(/https?:\/\/127\.0\.0\.1:\d+(\/[^\s]+)/g)) {
    let requestPath: string;
    try { requestPath = decodeURIComponent(new URL(match[0]).pathname); } catch { continue; }
    const prefix = `/p/${projectId}/`;
    const relative = requestPath.startsWith(prefix)
      ? requestPath.slice(prefix.length)
      : /^\/(images|assets)\//.test(requestPath) ? requestPath.slice(1) : '';
    const extension = path.posix.extname(relative).toLowerCase();
    if (!relative || relative.includes('..') || !IMAGE_EXTENSIONS.has(extension)) continue;
    const normalizedRequest = `/${relative}`;
    if (found.has(normalizedRequest)) continue;
    const sourceUrl = match[0];
    const alt = altByUrl.get(sourceUrl) ?? path.posix.basename(relative, extension).replaceAll('-', ' ');
    found.set(normalizedRequest, {
      alt,
      requestPath: normalizedRequest,
      publicRelativePath: relative,
      acquisitionPath: `public/${relative.slice(0, -extension.length)}`,
      query: `${alt} football jersey`.slice(0, 160),
    });
  }
  return [...found.values()].slice(0, 12);
}

export function isUsableRasterAsset(filePath: string): boolean {
  try {
    const bytes = fs.readFileSync(filePath).subarray(0, 16);
    const extension = path.extname(filePath).toLowerCase();
    if (extension === '.jpg' || extension === '.jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (extension === '.png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (extension === '.webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    return false;
  } catch {
    return false;
  }
}

export function imageQueryVariants(issue: MissingLocalImage): string[] {
  const subject = issue.alt
    .replace(/^(camiseta|equipaci[oó]n)\s+(local|visitante|oficial)\s+(del|de la|de)\s+/i, '')
    .replace(/^(home|away|official)\s+(shirt|jersey)\s+(of|for)\s+/i, '')
    .replace(/Bayern\s+(de\s+)?M[úüu]nich|Bayern\s+Muenchen/gi, 'Bayern Munich')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim();
  const slugSubject = path.posix.basename(issue.publicRelativePath, path.posix.extname(issue.publicRelativePath))
    .replaceAll('-', ' ')
    .trim();
  return [...new Set([
    issue.query,
    `${subject} jersey`,
    `${slugSubject} football jersey`,
  ].map((query) => query.replaceAll(/\s+/g, ' ').trim().slice(0, 160)))];
}

/** Replace broken root-absolute/relative asset references with the acquired Vite-safe URL. */
export function patchImageReferences(frontendDir: string, requestPath: string, publicUrl: string): string[] {
  const roots = [path.join(frontendDir, 'src'), path.join(frontendDir, 'index.html')];
  const relative = requestPath.replace(/^\//, '');
  const escapedRelative = relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match root-relative and any accidentally accumulated ./ or ../ prefixes in
  // one pass. Replacing substrings sequentially turns ./images into ././images.
  const localReference = new RegExp(`(?<![A-Za-z0-9_:])(?:\\.{1,2}/|/)*${escapedRelative}`, 'g');
  const changed: string[] = [];
  const visit = (target: string) => {
    if (!fs.existsSync(target)) return;
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) visit(path.join(target, entry));
      return;
    }
    if (!TEXT_EXTENSIONS.has(path.extname(target).toLowerCase())) return;
    const before = fs.readFileSync(target, 'utf8');
    let after = before;
    after = after.replace(localReference, publicUrl);
    if (after !== before) {
      fs.writeFileSync(target, after, 'utf8');
      changed.push(path.relative(frontendDir, target).replaceAll('\\', '/'));
    }
  };
  for (const root of roots) visit(root);
  return changed;
}

export function repairStateKey(frontendFingerprint: string, diagnostic: string): string {
  const stableDiagnostic = diagnostic
    .replaceAll(/127\.0\.0\.1:\d+/g, '127.0.0.1:PORT')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 12_000);
  return `${frontendFingerprint}\n${stableDiagnostic}`;
}

/**
 * Fase 1 (agent hardening): signature of a verification DIAGNOSTIC alone,
 * independent of any source fingerprint.
 *
 * The stagnation key above mixes fingerprint + diagnostic, so ANY source
 * edit — even one that leaves the exact same compiler error standing —
 * resets the stagnation counter and the run can die on the identical error
 * for dozens of iterations (observed in the pcBOX / PlayStation regression
 * cases). This signature deliberately ignores the sources: it extracts the
 * salient, stable parts of the diagnostic (compiler errors by file + TS
 * code + message, process exit lines, gate headers, ALL-CAPS error codes),
 * drops ephemeral details (ports, line/column numbers, durations) and
 * returns them sorted and deduplicated. Two failed verifications with the
 * same signature mean the repair is going in circles even if files changed
 * between them.
 */
export function repairErrorSignature(diagnostic: string): string {
  const salient = new Set<string>();
  for (const rawLine of diagnostic.split('\n')) {
    const line = rawLine
      .replaceAll(/127\.0\.0\.1:\d+/g, '127.0.0.1:PORT')
      .replaceAll(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/g, 'TIMESTAMP')
      .replaceAll(/\s+/g, ' ')
      .trim();
    if (!line) continue;
    // Compiler diagnostics: keep file + TS code + message; drop (line,col)
    // so an edit that merely MOVES the same error still counts as the same
    // signature.
    const tsError = line.match(/(\S+?\.(?:ts|tsx|js|jsx|mts|cts))\(\d+,\d+\):\s*(error TS\d+:\s*.*)$/);
    if (tsError) {
      salient.add(`${tsError[1]}: ${tsError[2]}`);
      continue;
    }
    if (line.includes('error TS')) {
      salient.add(line.replace(/\(\d+,\d+\)/g, ''));
      continue;
    }
    // Process outcomes (build/test/migration exits) — counts inside the
    // line (e.g. "10/17 passed") are meaningful: same counts = no progress.
    if (/exited with code \d+/.test(line)) {
      salient.add(line);
      continue;
    }
    // The dynamic gate header already names the missing/stale checks.
    if (line.startsWith('DYNAMIC CHECKS INCOMPLETE')) {
      salient.add(line);
      continue;
    }
    // Bare tool error codes: API_TESTS_FAILED, MIGRATION_CHECKSUM_MISMATCH…
    const codeLine = line.match(/^([A-Z][A-Z0-9_]{3,})(?::|\s-)\s*(.*)$/);
    if (codeLine) {
      salient.add(`${codeLine[1]}: ${codeLine[2]}`.trim());
      continue;
    }
  }
  if (salient.size > 0) return [...salient].sort().join('\n').slice(0, 12_000);
  // Fallback: the normalized diagnostic itself (same normalization as the
  // repair state key, minus the fingerprint).
  return diagnostic
    .replaceAll(/127\.0\.0\.1:\d+/g, '127.0.0.1:PORT')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 12_000);
}

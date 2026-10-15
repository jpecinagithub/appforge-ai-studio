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
      : requestPath.replace(/^\/+/, '');
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

/** Replace broken root-absolute/relative asset references with the acquired Vite-safe URL. */
export function patchImageReferences(frontendDir: string, requestPath: string, publicUrl: string): string[] {
  const roots = [path.join(frontendDir, 'src'), path.join(frontendDir, 'index.html')];
  const variants = new Set([requestPath, `.${requestPath}`, requestPath.replace(/^\//, '')]);
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
    for (const variant of variants) after = after.replaceAll(variant, publicUrl);
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

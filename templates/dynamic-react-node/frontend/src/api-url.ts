/**
 * Resolve an API path against the document's base URL.
 *
 * The app is served under `/` in Docker and under `/a/:projectId/` behind
 * the Studio proxy (contract §9.11). Absolute `/api/...` paths would escape
 * the project prefix and hit the Studio's own API, so every call is resolved
 * relative to the page's base instead:
 *
 *   resolveApiUrl('/api/auth/login', 'https://host/')                 → https://host/api/auth/login
 *   resolveApiUrl('/api/auth/login', 'https://host/a/abc123/')        → https://host/a/abc123/api/auth/login
 *   resolveApiUrl('/api/auth/login', 'https://host/a/abc123/index.html') → https://host/a/abc123/api/auth/login
 *
 * Pure function (no DOM access) so it can be unit-tested under node.
 */
export function resolveApiUrl(path: string, baseURI: string): string {
  const withoutLeadingSlash = path.replace(/^\//, '');
  // `new URL('.', base)` normalises to the containing directory with a
  // trailing slash, whatever the page URL looks like.
  const base = new URL('.', baseURI).href;
  return new URL(withoutLeadingSlash, base).href;
}

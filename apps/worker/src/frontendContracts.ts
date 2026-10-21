/**
 * Frontend contract lint for dynamic projects (agent's guardrails,
 * 2026-10-21) — the mirror of backendContracts.ts, for the other side of
 * the stack.
 *
 * Live case (project "T-shirts" 8863cc94, run 977a3ab8): the agent
 * hand-wrote `fetch('/api/shirts')` in frontend/src/App.tsx instead of
 * using the template's API client. A dynamic app is served below a
 * project prefix (/a/<projectId>/ through the Studio proxy in preview,
 * and below the same prefix in production), so the absolute path escaped
 * the app, hit the platform's own API and returned 404. The page stored
 * `data.items` (undefined) as its catalog and crashed rendering
 * (`Cannot read properties of undefined (reading 'map')`). The code
 * compiles perfectly — this class of bug only exists at runtime — and
 * the authenticated flow burned three intervention directives on it.
 *
 * The contract: every API call goes through the project API client
 * (frontend/src/api.ts), which resolves each path against
 * document.baseURI (frontend/src/api-url.ts) so it stays below the
 * prefix. This lint is pure text scanning, like the backend one: it
 * annotates the write result in the SAME turn, never blocks the write.
 *
 * Deliberately narrow patterns — only a string literal that starts with
 * /api handed DIRECTLY to fetch()/axios in a frontend file:
 *  - the API client itself (src/api.ts, src/api-url.ts) is excluded by
 *    path: '/api/...' literals are its raw material;
 *  - fetch(resolveApiUrl('/api/...', document.baseURI)) is the client
 *    pattern used by hand and is NOT matched (the literal is not the
 *    first argument of fetch);
 *  - relative URLs ('./api/…', 'api/…') and external absolute URLs
 *    ('https://…') are NOT matched.
 */
export interface FrontendSnippet {
  /** Frontend-relative posix path of the written file (e.g. src/App.tsx). */
  path: string;
  /** The written content (for patch_file: the replacement text). */
  content: string;
}

/** The template's API client and its resolver: excluded from the lint. */
export const API_CLIENT_FILES: ReadonlySet<string> = new Set(['src/api.ts', 'src/api-url.ts']);

export function isApiClientFile(relPosixPath: string): boolean {
  return API_CLIENT_FILES.has(relPosixPath);
}

const ABSOLUTE_API_CALL_RES: readonly RegExp[] = [
  /\bfetch\s*\(\s*['"`]\/api\b/g,
  /\baxios\s*(?:\.\s*(?:get|post|put|patch|delete|head|options|request))?\s*\(\s*['"`]\/api\b/g,
];

const EXPLANATION =
  "this app is served below a project prefix (/a/<projectId>/ in preview and production), so an absolute '/api/…' request escapes the app, " +
  "hits the platform's own API and returns 404 — the page then stores the error body as data (undefined) and crashes rendering it. " +
  'Route every API call through the project API client (frontend/src/api.ts, which resolves each path against document.baseURI via resolveApiUrl), ' +
  'or use a relative URL.';

/** One violation per offending file, with the first matched call as evidence. */
export function frontendContractViolations(snippets: FrontendSnippet[]): string[] {
  const violations: string[] = [];
  for (const snippet of snippets) {
    if (!snippet.content || isApiClientFile(snippet.path)) continue;
    let excerpt: string | null = null;
    for (const re of ABSOLUTE_API_CALL_RES) {
      re.lastIndex = 0; // module-level /g regexes carry state between calls
      const m = re.exec(snippet.content);
      if (m) {
        excerpt = snippet.content.slice(m.index, m.index + 48).split('\n')[0]!.trim();
        break;
      }
    }
    if (excerpt !== null) {
      violations.push(`${snippet.path}: hand-written absolute API call \`${excerpt}…\` — ${EXPLANATION}`);
    }
  }
  return violations;
}

/** Note text to append to a frontend write result, or null when clean. */
export function frontendContractsNote(snippets: FrontendSnippet[]): string | null {
  try {
    const violations = frontendContractViolations(snippets);
    if (violations.length === 0) return null;
    return `Frontend contract check (fix now, this compiles fine but breaks at runtime):\n${violations.map((v) => `- ${v}`).join('\n')}`;
  } catch {
    return null;
  }
}

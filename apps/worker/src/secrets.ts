/**
 * Secret sanitization for logs (extracted from dynamicTools.ts, Fase 6).
 * Single home for the redaction patterns; dynamicTools re-exports
 * `sanitizeSecrets` so existing imports keep working.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/((?:password|passwd|pwd|client[_-]secret|api[_-]key)["']?\s*[:=]\s*['"]?)[^\s"',}\]]+/gi, '$1[redacted]'],
  [/(authorization\s*[:=]\s*['"]?)(bearer\s+)?[A-Za-z0-9\-._~+/=]{8,}/gi, '$1[redacted]'],
  [/(af_session=)[^;\s"']+/gi, '$1[redacted]'],
  [/(set-cookie\s*:[^\r\n]*?af_session=)[^;\s]+/gi, '$1[redacted]'],
  [/(cookie\s*:\s*)[^\r\n]+/gi, '$1[redacted]'],
  [/((?:session[_-]?token|auth[_-]?token)["']?\s*[:=]\s*['"]?)[A-Za-z0-9\-._~+/=]{8,}/gi, '$1[redacted]'],
  // Revisión Codex (Fase 6): clave genérica `token` (p. ej. `token=abc…`).
  [/((?:\btoken\b)["']?\s*[:=]\s*['"]?)[A-Za-z0-9\-._~+/=]{8,}/gi, '$1[redacted]'],
];

/** Remove passwords, cookies, tokens and secrets from captured logs. */
export function sanitizeSecrets(s: string): string {
  let out = s;
  for (const [re, replacement] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, replacement);
  }
  return out;
}

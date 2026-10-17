/**
 * Fase 7A — Variables de entorno y secretos (§9).
 *
 * - El `.env` del proyecto lo crea/actualiza código del Studio (0600,
 *   gitignored, fuera del snapshot/imagen/ZIP).
 * - El driver escribe una COPIA VALIDADA en el directorio privado del
 *   deployment (0600) y la pasa con `--env-file`. Así un cambio concurrente
 *   del `.env` del proyecto no puede alterar un deployment aceptado (TOCTOU).
 * - Lista permitida de nombres; se rechazan claves con caracteres inválidos,
 *   null bytes, valores multilínea y duplicados ambiguos.
 * - Ninguna variable del proceso del Studio se hereda en bloque.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Nombres permitidos en el env-file del contenedor de proyecto. */
export const ALLOWED_ENV_NAMES = new Set([
  'PORT',
  'HOST',
  'NODE_ENV',
  'DB_PATH',
  'PUBLIC_PATH',
  'SESSION_COOKIE_NAME',
  'SESSION_TTL_DAYS',
]);

/** Valores base fijados por el Studio (el driver los impone). */
export function baseEnvFor(projectId: string): Record<string, string> {
  return {
    PORT: '8080',
    HOST: '0.0.0.0',
    NODE_ENV: 'production',
    DB_PATH: '/data/app.db',
    PUBLIC_PATH: `/a/${projectId}/`,
    SESSION_COOKIE_NAME: 'af_session',
    SESSION_TTL_DAYS: '7',
  };
}

export class EnvError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EnvError';
    this.code = code;
  }
}

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function assertValidEnvName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new EnvError('INVALID_ENV_NAME', `invalid env name '${name.slice(0, 80)}'`);
  }
  if (!ALLOWED_ENV_NAMES.has(name)) {
    throw new EnvError('ENV_NOT_ALLOWED', `env name '${name}' is not in the allowlist`);
  }
}

/**
 * Parsea un `.env` de forma estricta: líneas `NOMBRE=valor`, comentarios `#`
 * y líneas vacías. Falla ante null bytes, valores multilínea, claves
 * duplicadas (ambiguas) o nombres fuera de la lista permitida.
 */
export function parseEnvFile(content: string): Array<[string, string]> {
  if (content.includes('\0')) {
    throw new EnvError('NULL_BYTE', 'env file contains a null byte');
  }
  const out: Array<[string, string]> = [];
  const seen = new Map<string, string>();
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/[\r]/.test(raw)) {
      throw new EnvError('BAD_LINE', `env line ${i + 1} contains a carriage return (not allowed)`);
    }
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      throw new EnvError('BAD_LINE', `env line ${i + 1} is not NAME=value`);
    }
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1); // el valor conserva espacios intencionales
    assertValidEnvName(name);
    if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
      throw new EnvError('BAD_VALUE', `env '${name}' has a multiline or null value`);
    }
    if (seen.has(name)) {
      if (seen.get(name) !== value) {
        throw new EnvError('DUPLICATE_ENV', `ambiguous duplicate env '${name}'`);
      }
      throw new EnvError('DUPLICATE_ENV', `duplicate env '${name}'`);
    }
    seen.set(name, value);
    out.push([name, value]);
  }
  return out;
}

/**
 * Escribe la copia validada del env en `destPath` (modo 0600). Los valores
 * base del Studio prevalecen; el `.env` del proyecto solo puede aportar
 * nombres de la lista permitida. Falla si el origen no existe o es inválido.
 */
export function writeValidatedEnvFile(opts: {
  projectEnvPath: string;
  destPath: string;
  projectId: string;
}): void {
  const { projectEnvPath, destPath, projectId } = opts;
  const base = baseEnvFor(projectId);
  let extra: Array<[string, string]> = [];
  if (fs.existsSync(projectEnvPath)) {
    const st = fs.statSync(projectEnvPath);
    if (!st.isFile()) throw new EnvError('ENV_NOT_FILE', 'project .env is not a regular file');
    extra = parseEnvFile(fs.readFileSync(projectEnvPath, 'utf8'));
  }
  const merged = new Map<string, string>(Object.entries(base));
  for (const [k, v] of extra) {
    // Los valores base del Studio no son sobrescribibles por el proyecto.
    if (!(k in base)) merged.set(k, v);
  }
  const lines = [...merged.entries()].map(([k, v]) => `${k}=${v}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  // Endurece el modo por si el umask interfiere.
  fs.chmodSync(destPath, 0o600);
}

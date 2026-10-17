/**
 * Fase 7A — DockerCommandRunner: ejecutor auditado del CLI `docker`.
 *
 * Garantías:
 * - NUNCA usa shell (`shell: false` siempre): ejecutable + vector fijo de
 *   argumentos. No hay concatenación de texto ni interpolación.
 * - Solo acepta subcomandos de una lista cerrada (`ALLOWED_SUBCOMMANDS`).
 *   Cualquier otro subcomando → error estable antes de spawnear.
 * - Los argumentos se validan: strings no vacíos, sin null bytes, con tope
 *   de longitud. No se aceptan "comandos libres".
 * - `AbortSignal`: al abortar mata el proceso (SIGKILL) y ESPERA su salida.
 *   Cero procesos vivos tras un abort/timeout.
 * - Captura limitada y sanitizada de stdout/stderr (tope configurable, con
 *   indicador de truncado). No hereda el entorno del proceso: env mínima
 *   explícita.
 * - Timeouts configurables por llamada y por defecto.
 *
 * Este módulo no conoce proyectos, contenedores ni despliegues: solo ejecuta
 * argv contra el binario docker. La semántica vive en `dockerDriver.ts`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { sanitizeSecrets } from '../secrets.js';

/** Subcomandos docker permitidos (lista cerrada). Sin shell, sin `exec` dinámico. */
const ALLOWED_SUBCOMMANDS = new Set([
  'build',
  'images',
  'inspect',
  'ps',
  'run',
  'create',
  'rm',
  'rmi',
  'start',
  'stop',
  'kill',
  'wait',
  'cp',
  'logs',
  'volume',
  'network',
  'info',
  'version',
  'pull',
]);

/** Segundos niveles permitidos para `docker volume|network <sub>`. `prune` queda excluido a propósito. */
const ALLOWED_SECOND_LEVEL = new Set(['create', 'rm', 'ls', 'inspect']);

const MAX_ARG_CHARS = 16_384;

export class DockerCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DockerCommandError';
    this.code = code;
  }
}

export interface DockerRunOptions {
  /** Vector FIJO de argumentos (argv[0] = subcomando). Nunca un string de shell. */
  args: string[];
  timeoutMs?: number;
  /** Tope total de bytes capturados entre stdout+stderr. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** Entorno mínimo explícito. NUNCA se hereda process.env en bloque. */
  env?: Record<string, string>;
  /** Datos para stdin (se escribe y se cierra). */
  stdin?: string;
}

export interface DockerRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export interface DockerRunRawResult extends Omit<DockerRunResult, 'stdout'> {
  /** stdout como bytes crudos (para `docker cp` tar). stderr sigue sanitizado como texto. */
  stdoutBytes: Buffer;
}

export interface DockerCommandRunnerOptions {
  dockerBin?: string;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
}

function assertValidArgs(args: string[]): void {
  if (!Array.isArray(args) || args.length === 0) {
    throw new DockerCommandError('INVALID_ARGV', 'docker argv must be a non-empty array');
  }
  const [sub, second] = args;
  if (!ALLOWED_SUBCOMMANDS.has(sub)) {
    throw new DockerCommandError('COMMAND_NOT_ALLOWED', `docker subcommand '${sub}' is not allowed`);
  }
  if ((sub === 'volume' || sub === 'network') && second !== undefined) {
    if (!ALLOWED_SECOND_LEVEL.has(second)) {
      throw new DockerCommandError(
        'COMMAND_NOT_ALLOWED',
        `docker ${sub} subcommand '${second}' is not allowed`,
      );
    }
  }
  for (const a of args) {
    if (typeof a !== 'string' || a.length === 0) {
      throw new DockerCommandError('INVALID_ARGV', 'every docker argument must be a non-empty string');
    }
    if (a.length > MAX_ARG_CHARS) {
      throw new DockerCommandError('INVALID_ARGV', `docker argument exceeds ${MAX_ARG_CHARS} chars`);
    }
    if (a.includes('\0')) {
      throw new DockerCommandError('INVALID_ARGV', 'docker argument contains a null byte');
    }
  }
}

/** Entorno mínimo para el CLI docker: nunca process.env completo. */
export function minimalDockerEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { PATH: '/usr/local/bin:/usr/bin:/bin' };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        throw new DockerCommandError('INVALID_ENV', `invalid env name '${k}'`);
      }
      if (typeof v !== 'string' || v.includes('\0')) {
        throw new DockerCommandError('INVALID_ENV', `invalid env value for '${k}'`);
      }
      env[k] = v;
    }
  }
  return env;
}

export class DockerCommandRunner {
  private readonly dockerBin: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(opts: DockerCommandRunnerOptions = {}) {
    this.dockerBin = opts.dockerBin ?? 'docker';
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
    this.maxOutputBytes = opts.maxOutputBytes ?? 1_048_576; // 1 MiB
  }

  /**
   * Ejecuta `docker <args>`. Nunca lanza por salidas del proceso: los
   * resultados (incluidos timeout/abort) se devuelven en el resultado.
   * Solo lanza `DockerCommandError` por argv inválido o fallo de spawn.
   */
  async run(options: DockerRunOptions): Promise<DockerRunResult> {
    const raw = await this.runRaw(options);
    const out = raw.truncated
      ? `${sanitizeSecrets(raw.stdoutBytes.toString('utf8'))}\n…[truncated: output exceeded ${options.maxOutputBytes ?? this.maxOutputBytes} bytes]`
      : sanitizeSecrets(raw.stdoutBytes.toString('utf8'));
    return { ...raw, stdout: out };
  }

  /**
   * Variante binaria: stdout como Buffer crudo (p. ej. para `docker cp`).
   * stderr se sanitiza como texto.
   */
  async runRaw(options: DockerRunOptions): Promise<DockerRunRawResult> {
    assertValidArgs(options.args);
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const cap = options.maxOutputBytes ?? this.maxOutputBytes;
    const t0 = Date.now();

    // Abort previo al spawn: no se crea ningún proceso.
    if (options.signal?.aborted) {
      return {
        code: null,
        signal: null,
        stdoutBytes: Buffer.alloc(0),
        stderr: '',
        truncated: false,
        timedOut: false,
        aborted: true,
        durationMs: Date.now() - t0,
      };
    }

    let child: ChildProcess;
    try {
      child = spawn(this.dockerBin, options.args, {
        shell: false,
        env: minimalDockerEnv(options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Grupo de procesos propio: el kill llega también a los nietos.
        // Sin esto, un hijo que hace fork (sh -> sleep) deja al nieto vivo
        // heredando los pipes y el 'close' de Node no se emite nunca.
        detached: true,
      });
    } catch (e) {
      throw new DockerCommandError('SPAWN_FAILED', `failed to spawn docker: ${(e as Error).message}`);
    }

    return new Promise<DockerRunRawResult>((resolve) => {
      const outChunks: Buffer[] = [];
      let stderr = '';
      let truncated = false;
      let stored = 0;
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const appendOut = (chunk: Buffer): void => {
        if (stored >= cap) {
          truncated = true;
          return;
        }
        const room = cap - stored;
        if (chunk.length <= room) {
          stored += chunk.length;
          outChunks.push(chunk);
        } else {
          outChunks.push(chunk.subarray(0, room));
          stored = cap;
          truncated = true;
        }
      };
      const appendErr = (chunk: Buffer): void => {
        const text = chunk.toString('utf8');
        if (stderr.length < cap) stderr += text.slice(0, cap - stderr.length);
      };
      child.stdout?.on('data', (c: Buffer) => appendOut(c));
      child.stderr?.on('data', (c: Buffer) => appendErr(c));
      child.on('error', () => {
        // El error de spawn se gestiona abajo vía 'close' con código null;
        // si el proceso nunca arrancó, resolvemos como SPAWN_FAILED.
        if (!settled && child.exitCode === null && !child.killed) {
          settled = true;
          clearTimeout(timer);
          resolve({
            code: null,
            signal: null,
            stdoutBytes: Buffer.alloc(0),
            stderr: sanitizeSecrets(`spawn failed: ${this.dockerBin} not executable`),
            truncated: false,
            timedOut: false,
            aborted: false,
            durationMs: Date.now() - t0,
          });
        }
      });

      const killAll = (): void => {
        // SIGKILL a TODO el grupo de procesos: cero procesos vivos tras
        // abort/timeout, aunque el hijo haya hecho fork (el nieto heredaría
        // los pipes y bloquearía el 'close' de Node).
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* ya terminado */
        }
        try {
          child.kill('SIGKILL');
        } catch {
          /* ya terminado */
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        killAll();
      }, Math.max(1, timeoutMs));
      // No retener el event loop si el llamador ya no espera.
      timer.unref?.();

      const onAbort = (): void => {
        if (settled) return;
        aborted = true;
        killAll();
      };
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }

      if (options.stdin !== undefined && child.stdin) {
        child.stdin.write(options.stdin);
        child.stdin.end();
      } else {
        child.stdin?.end();
      }

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve({
          code,
          signal,
          stdoutBytes: Buffer.concat(outChunks),
          stderr: sanitizeSecrets(stderr),
          truncated,
          timedOut,
          aborted,
          durationMs: Date.now() - t0,
        });
      });
    });
  }

  /** Ejecuta y parsea stdout como JSON. Lanza DockerCommandError si falla. */
  async runJson<T>(options: DockerRunOptions): Promise<T> {
    const r = await this.run(options);
    if (r.timedOut) throw new DockerCommandError('DOCKER_TIMEOUT', `docker ${options.args[0]} timed out`);
    if (r.aborted) throw new DockerCommandError('DOCKER_ABORTED', `docker ${options.args[0]} aborted`);
    if (r.code !== 0) {
      throw new DockerCommandError(
        'DOCKER_JSON_FAILED',
        `docker ${options.args.join(' ')} exited ${r.code}: ${r.stderr.slice(0, 500)}`,
      );
    }
    try {
      return JSON.parse(r.stdout) as T;
    } catch (e) {
      throw new DockerCommandError('DOCKER_BAD_JSON', `invalid JSON from docker: ${(e as Error).message}`);
    }
  }
}

/**
 * Fase 7A — Endurecimiento de contenedores de proyecto (§8).
 *
 * Construye el vector EXACTO de argumentos para `docker run`/`docker create`
 * con todas las protecciones obligatorias. Las pruebas inspeccionan el
 * vector (unitarias) y `docker inspect` (integración); nunca se confía solo
 * en buscar flags en el código.
 *
 * Reglas aplicadas a live y verify:
 * - usuario 1001 no root; `--read-only`; `/tmp` en tmpfs con límites;
 * - único montaje escribible: volumen propio en `/data`;
 * - `--cap-drop=ALL`; `--security-opt=no-new-privileges:true`;
 * - `--pids-limit=128`; `--cpus=1.0`; `--memory=512m` (+swap igualado);
 * - sin `--privileged`, sin dispositivos, sin host PID/IPC/network;
 * - sin puertos publicados; solo red interna indicada;
 * - migraciones: `--network=none` + `--rm` (efímero);
 * - restart `unless-stopped` solo en live.
 */

import { labelArgs, type ManagedLabels } from './resources.js';

export type HardenedRole = 'live' | 'verify' | 'migration';

export interface HardenedContainerSpec {
  name: string;
  image: string;
  /** Nombre del volumen Docker a montar en /data. */
  volume: string;
  labels: ManagedLabels;
  /** Ruta ABSOLUTA del env-file validado (0600). */
  envFile: string;
  /** Red interna (p. ej. appforge-apps). Ignorada en migraciones. */
  network: string;
  role: HardenedRole;
  /** Comando fijo del entrypoint (solo migraciones; p. ej. node backend/dist/migrate.js como argv). */
  command?: string[];
}

export class HardeningError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'HardeningError';
    this.code = code;
  }
}

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SAFE_ABS_PATH = /^\/[^\0]{1,1024}$/;

function assertSafe(value: string, what: string, re: RegExp): void {
  if (typeof value !== 'string' || !re.test(value)) {
    throw new HardeningError('INVALID_SPEC', `invalid ${what}: '${String(value).slice(0, 80)}'`);
  }
}

/**
 * Vector completo para `docker run` (o `docker create` si `createOnly`).
 * Orden determinista para que las pruebas comparen vectores exactos.
 */
export function hardenedRunArgs(spec: HardenedContainerSpec, createOnly = false): string[] {
  assertSafe(spec.name, 'container name', SAFE_NAME);
  assertSafe(spec.image, 'image', /^[a-z0-9][a-z0-9_.\-/]{0,255}:[a-zA-Z0-9_.\-]{1,128}$/);
  assertSafe(spec.volume, 'volume', SAFE_NAME);
  assertSafe(spec.envFile, 'env file', SAFE_ABS_PATH);
  assertSafe(spec.network, 'network', SAFE_NAME);
  if (spec.command) {
    for (const c of spec.command) assertSafe(c, 'command arg', /^[^\0]{1,1024}$/);
  }

  const ephemeral = spec.role === 'migration';
  const args: string[] = [createOnly ? 'create' : 'run'];
  if (!createOnly && !ephemeral) args.push('-d');
  if (ephemeral) args.push('--rm');
  args.push('--name', spec.name);
  args.push(...labelArgs(spec.labels));
  // Identidad y filesystem
  args.push('--user', '1001');
  args.push('--read-only');
  args.push('--tmpfs', '/tmp:rw,noexec,nosuid,size=64m');
  // Capacidades y privilegios
  args.push('--cap-drop=ALL');
  args.push('--security-opt', 'no-new-privileges:true');
  // Límites de recursos
  args.push('--pids-limit', '128');
  args.push('--cpus', '1.0');
  args.push('--memory', '512m');
  args.push('--memory-swap', '512m');
  // Red: interna para live/verify; ninguna para migraciones.
  args.push('--network', ephemeral ? 'none' : spec.network);
  // Sin puertos publicados: no hay -p/--publish aquí por diseño.
  // Reinicio
  args.push('--restart', spec.role === 'live' ? 'unless-stopped' : 'no');
  // Parada graciosa acotada
  args.push('--stop-timeout', '10');
  // Único montaje escribible: el volumen propio en /data.
  args.push('-v', `${spec.volume}:/data`);
  // Variables: solo vía --env-file validado.
  args.push('--env-file', spec.envFile);
  args.push(spec.image);
  if (spec.command) args.push(...spec.command);
  return args;
}

/** Comprueba que un vector NO contiene patrones prohibidos (defensa en profundidad). */
export function assertNoForbiddenFlags(args: string[]): void {
  const joined = `\n${args.join('\n')}\n`;
  const forbidden: Array<[RegExp, string]> = [
    [/^--privileged$/m, '--privileged'],
    [/^(-p|--publish)\b/m, 'published ports'],
    [/--device\b/m, '--device'],
    [/--pid=host\b/m, 'host PID'],
    [/--ipc=host\b/m, 'host IPC'],
    [/--network=host\b/m, 'host network'],
    [/\/var\/run\/docker\.sock/, 'docker socket mount'],
    [/^--cap-add\b/m, '--cap-add'],
  ];
  for (const [re, name] of forbidden) {
    if (re.test(joined)) {
      throw new HardeningError('FORBIDDEN_FLAG', `hardened argv must not contain ${name}`);
    }
  }
}

/**
 * Fase 7A — Modelo de recursos Docker administrados por AppForge.
 *
 * - Todos los recursos llevan las 5 labels completas; los nombres
 *   abreviados NO bastan para decidir propiedad.
 * - Antes de reutilizar o eliminar un recurso por nombre, se comparan las
 *   labels con los UUID completos. Colisión o recurso sin labels →
 *   error estable; nunca se adopta, detiene ni elimina un recurso ajeno.
 * - Solo se enumeran/limpian recursos con `com.appforge.managed=true`.
 * - Prohibido `docker system prune` y borrados globales o por prefijo sin
 *   comprobar labels (el runner ni siquiera admite `prune`).
 */

import { DockerCommandRunner } from './commandRunner.js';

export const MANAGED_LABEL = 'com.appforge.managed';
export const LABEL_PROJECT = 'com.appforge.project-id';
export const LABEL_DEPLOYMENT = 'com.appforge.deployment-id';
export const LABEL_ROLE = 'com.appforge.role';
export const LABEL_FINGERPRINT = 'com.appforge.source-fingerprint';
/** Componente de infraestructura (red `appforge-apps`, volumen de datos del Studio). */
export const LABEL_COMPONENT = 'com.appforge.component';

export type ResourceRole = 'live' | 'verify' | 'migration';

export interface ManagedLabels {
  projectId: string;
  deploymentId: string;
  role: ResourceRole;
  fingerprint: string;
}

export class ResourceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ResourceError';
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/i;

export function assertUuid(value: string, name: string): void {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new ResourceError('INVALID_UUID', `${name} must be a UUID`);
  }
}

/** 8 primeros caracteres hex del UUID (para nombres abreviados). */
export function id8(uuid: string): string {
  assertUuid(uuid, 'uuid');
  return uuid.slice(0, 8).toLowerCase();
}

export function assertFingerprint(fp: string): void {
  if (typeof fp !== 'string' || !HEX64_RE.test(fp)) {
    throw new ResourceError('INVALID_FINGERPRINT', 'source fingerprint must be a 64-char hex SHA-256');
  }
}

export function assertRole(role: string): asserts role is ResourceRole {
  if (role !== 'live' && role !== 'verify' && role !== 'migration') {
    throw new ResourceError('INVALID_ROLE', `role must be live|verify|migration, got '${role}'`);
  }
}

/** Nombres canónicos de recursos (§5 de la especificación de Fase 7). */
export interface ResourceNames {
  /** appforge/app-<id8>:dep-<dep8>-<sha12> */
  image: string;
  /** appforge-app-<id8> */
  liveContainer: string;
  /** appforge-app-<id8>-verify-<dep8> */
  verifyContainer: string;
  /** appforge-project-<uuid>-data */
  liveVolume: string;
  /** appforge-verify-<deploymentId>-data */
  verifyVolume: string;
}

export function resourceNames(projectId: string, deploymentId: string, fingerprint: string): ResourceNames {
  assertUuid(projectId, 'projectId');
  assertUuid(deploymentId, 'deploymentId');
  assertFingerprint(fingerprint);
  const p8 = id8(projectId);
  const d8 = id8(deploymentId);
  const sha12 = fingerprint.slice(0, 12).toLowerCase();
  return {
    image: `appforge/app-${p8}:dep-${d8}-${sha12}`,
    liveContainer: `appforge-app-${p8}`,
    verifyContainer: `appforge-app-${p8}-verify-${d8}`,
    liveVolume: projectLiveVolumeName(projectId),
    verifyVolume: `appforge-verify-${deploymentId.toLowerCase()}-data`,
  };
}

/**
 * Nombre del volumen live: identidad ESTABLE por proyecto (revisión Codex,
 * Fase 7A). No depende del deployment ni del fingerprint: dos despliegues
 * consecutivos del mismo proyecto comparten el volumen y, por tanto, los
 * datos.
 */
export function projectLiveVolumeName(projectId: string): string {
  assertUuid(projectId, 'projectId');
  return `appforge-project-${projectId.toLowerCase()}-data`;
}

/**
 * Labels del volumen live: identidad estable por proyecto (revisión Codex,
 * Fase 7A). NO incluyen deployment-id ni fingerprint: el volumen sobrevive
 * a los deployments y su propiedad se decide solo por proyecto + rol.
 */
export function liveVolumeLabelArgs(projectId: string): string[] {
  assertUuid(projectId, 'projectId');
  return [
    '--label',
    `${MANAGED_LABEL}=true`,
    '--label',
    `${LABEL_PROJECT}=${projectId.toLowerCase()}`,
    '--label',
    `${LABEL_ROLE}=live`,
  ];
}

/**
 * Verifica que un volumen existente sea el volumen live del proyecto:
 * managed=true, project-id exacto y rol live. Cualquier divergencia
 * (ausencia de labels, otro proyecto, otro rol) → ResourceError: el
 * volumen es ajeno o corrupto y NO debe tocarse (p. ej. `volume rm`).
 */
export function assertLiveVolumeLabels(
  actual: Record<string, string> | undefined,
  projectId: string,
): void {
  assertUuid(projectId, 'projectId');
  const a = actual ?? {};
  const problems: string[] = [];
  if (a[MANAGED_LABEL] !== 'true') problems.push(`${MANAGED_LABEL}!=true`);
  if ((a[LABEL_PROJECT] ?? '').toLowerCase() !== projectId.toLowerCase()) {
    problems.push(`${LABEL_PROJECT} mismatch`);
  }
  if (a[LABEL_ROLE] !== 'live') problems.push(`${LABEL_ROLE} mismatch`);
  if (problems.length > 0) {
    throw new ResourceError(
      'FOREIGN_RESOURCE',
      `refusing to touch live volume with non-matching labels: ${problems.join(', ')}`,
    );
  }
}

/** Vector de `--label k=v` para `docker run/create/build/volume/network`. */
export function labelArgs(l: ManagedLabels): string[] {
  assertUuid(l.projectId, 'projectId');
  assertUuid(l.deploymentId, 'deploymentId');
  assertRole(l.role);
  assertFingerprint(l.fingerprint);
  return [
    '--label',
    `${MANAGED_LABEL}=true`,
    '--label',
    `${LABEL_PROJECT}=${l.projectId.toLowerCase()}`,
    '--label',
    `${LABEL_DEPLOYMENT}=${l.deploymentId.toLowerCase()}`,
    '--label',
    `${LABEL_ROLE}=${l.role}`,
    '--label',
    `${LABEL_FINGERPRINT}=${l.fingerprint.toLowerCase()}`,
  ];
}

export interface InspectedLabels {
  [MANAGED_LABEL]?: string;
  [LABEL_PROJECT]?: string;
  [LABEL_DEPLOYMENT]?: string;
  [LABEL_ROLE]?: string;
  [LABEL_FINGERPRINT]?: string;
}

/**
 * Compara las labels inspeccionadas con las esperadas (UUID completos).
 * Lanza `ResourceError` si falta alguna label o no coincide: el recurso es
 * ajeno o está corrupto y NO debe tocarse.
 */
export function assertLabelsMatch(actual: Record<string, string> | undefined, expected: ManagedLabels): void {
  const a = actual ?? {};
  const problems: string[] = [];
  if (a[MANAGED_LABEL] !== 'true') problems.push(`${MANAGED_LABEL}!=true`);
  if ((a[LABEL_PROJECT] ?? '').toLowerCase() !== expected.projectId.toLowerCase()) {
    problems.push(`${LABEL_PROJECT} mismatch`);
  }
  if ((a[LABEL_DEPLOYMENT] ?? '').toLowerCase() !== expected.deploymentId.toLowerCase()) {
    problems.push(`${LABEL_DEPLOYMENT} mismatch`);
  }
  if (a[LABEL_ROLE] !== expected.role) problems.push(`${LABEL_ROLE} mismatch`);
  if ((a[LABEL_FINGERPRINT] ?? '').toLowerCase() !== expected.fingerprint.toLowerCase()) {
    problems.push(`${LABEL_FINGERPRINT} mismatch`);
  }
  if (problems.length > 0) {
    throw new ResourceError('FOREIGN_RESOURCE', `refusing to touch non-matching resource: ${problems.join(', ')}`);
  }
}

export interface ListedResource {
  id: string;
  name: string;
  labels: Record<string, string>;
}

function parseLines(jsonLines: string): ListedResource[] {
  const out: ListedResource[] = [];
  for (const line of jsonLines.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as { ID?: string; Id?: string; Name?: string; Names?: string; Labels?: string; Repository?: string; Tag?: string };
      const labels: Record<string, string> = {};
      // `docker ... ls --format '{{json .}}'` serializa Labels como "k=v,k=v".
      for (const pair of String(o.Labels ?? '').split(',')) {
        const i = pair.indexOf('=');
        if (i > 0) labels[pair.slice(0, i)] = pair.slice(i + 1);
      }
      // `docker images` usa Repository/Tag en lugar de Name.
      const repo = o.Repository && o.Tag ? `${o.Repository}:${o.Tag}` : '';
      out.push({
        id: String(o.ID ?? o.Id ?? ''),
        name: String(o.Name ?? o.Names ?? repo).replace(/^\//, ''),
        labels,
      });
    } catch {
      // Línea no parseable: se ignora (no se decide nada sobre ella).
    }
  }
  return out;
}

/**
 * Enumera recursos AppForge. SIEMPRE filtra por `com.appforge.managed=true`
 * en el propio daemon; además, el llamador debe verificar labels completas
 * antes de actuar.
 */
export async function listManagedResources(
  runner: DockerCommandRunner,
  kind: 'container' | 'image' | 'volume' | 'network',
  timeoutMs = 30_000,
): Promise<ListedResource[]> {
  const filter = ['--filter', `label=${MANAGED_LABEL}=true`, '--format', '{{json .}}'];
  let args: string[];
  switch (kind) {
    case 'container':
      args = ['ps', '-a', ...filter];
      break;
    case 'image':
      args = ['images', ...filter];
      break;
    case 'volume':
      args = ['volume', 'ls', ...filter];
      break;
    case 'network':
      args = ['network', 'ls', ...filter];
      break;
  }
  const r = await runner.run({ args, timeoutMs });
  if (r.code !== 0) {
    throw new ResourceError('LIST_FAILED', `docker ${kind} list failed: ${r.stderr.slice(0, 300)}`);
  }
  return parseLines(r.stdout);
}

/** `docker inspect` genérico que devuelve el JSON parseado. */
export async function inspectResource(
  runner: DockerCommandRunner,
  kind: 'container' | 'image' | 'volume' | 'network',
  name: string,
  timeoutMs = 30_000,
): Promise<unknown> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.\-/:@]{0,255}$/.test(name)) {
    throw new ResourceError('INVALID_NAME', `invalid resource name for inspect: '${name}'`);
  }
  const r = await runner.run({ args: ['inspect', name], timeoutMs });
  if (r.code !== 0) {
    throw new ResourceError(
      'INSPECT_FAILED',
      `docker inspect ${kind} '${name}' failed: ${r.stderr.slice(0, 300)}`,
    );
  }
  try {
    const arr = JSON.parse(r.stdout) as unknown[];
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new ResourceError('INSPECT_EMPTY', `docker inspect ${kind} '${name}' returned empty`);
    }
    return arr[0];
  } catch (e) {
    if (e instanceof ResourceError) throw e;
    throw new ResourceError('INSPECT_BAD_JSON', `invalid inspect JSON for '${name}'`);
  }
}

/** ¿Existe el recurso? (true/false; nunca lanza por ausencia). */
export async function resourceExists(
  runner: DockerCommandRunner,
  kind: 'container' | 'image' | 'volume' | 'network',
  name: string,
): Promise<boolean> {
  try {
    await inspectResource(runner, kind, name);
    return true;
  } catch (e) {
    if (e instanceof ResourceError && e.code === 'INSPECT_FAILED') return false;
    throw e;
  }
}

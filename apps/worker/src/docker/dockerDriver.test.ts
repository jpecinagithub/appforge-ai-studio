/**
 * Fase 7A — Tests unitarios del DockerDeploymentDriver que no necesitan
 * Docker: kill switches, preflight negativo y validación de args.
 */
import { describe, test, expect } from 'vitest';
import {
  resolveDockerDriverConfig,
  preflightDocker,
  DockerDeploymentDriver,
} from './dockerDriver.js';
import { DockerCommandRunner } from './commandRunner.js';
import { assertDriverArgs } from '../deploy/driver.js';
import Database from 'better-sqlite3';
import { ensureVerificationReceiptsTable, recordVerificationReceipt } from '../deploy/receipts.js';
import type { DynamicCheckKey } from '../dynamicTools.js';

const BASE_ENV = {
  APPFORGE_DEPLOY_DRIVER: 'docker',
  APPFORGE_ENABLE_DOCKER_DEPLOY: '1',
  APPFORGE_DOCKER_NETWORK: 'appforge-apps',
  APPFORGE_DOCKER_DATA_VOLUME: 'appforge-data',
};

/** DB en memoria con tabla de receipts canónica (Fase 6). */
function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  ensureVerificationReceiptsTable(db);
  return db;
}

describe('kill switches (§4)', () => {
  test('null sin doble kill switch', () => {
    expect(resolveDockerDriverConfig({}, '/data')).toBeNull();
    expect(resolveDockerDriverConfig({ APPFORGE_DEPLOY_DRIVER: 'docker' }, '/data')).toBeNull();
    expect(
      resolveDockerDriverConfig({ ...BASE_ENV, APPFORGE_ENABLE_DOCKER_DEPLOY: '0' }, '/data'),
    ).toBeNull();
    expect(resolveDockerDriverConfig({ ...BASE_ENV, APPFORGE_DOCKER_NETWORK: '' }, '/data')).toBeNull();
  });
  test('config completa', () => {
    const c = resolveDockerDriverConfig({ ...BASE_ENV, APPFORGE_MAX_CONCURRENT_DEPLOYS: '3' }, '/data')!;
    expect(c).not.toBeNull();
    expect(c.network).toBe('appforge-apps');
    expect(c.maxConcurrentDeploys).toBe(3);
    expect(c.socketPath).toBe('/var/run/docker.sock');
  });
  test('max concurrent por defecto 1 y saneado', () => {
    expect(resolveDockerDriverConfig(BASE_ENV, '/d')!.maxConcurrentDeploys).toBe(1);
    expect(resolveDockerDriverConfig({ ...BASE_ENV, APPFORGE_MAX_CONCURRENT_DEPLOYS: '0' }, '/d')!.maxConcurrentDeploys).toBe(1);
    expect(resolveDockerDriverConfig({ ...BASE_ENV, APPFORGE_MAX_CONCURRENT_DEPLOYS: 'abc' }, '/d')!.maxConcurrentDeploys).toBe(1);
  });
  test('rechaza nombres de red/volumen maliciosos', () => {
    expect(resolveDockerDriverConfig({ ...BASE_ENV, APPFORGE_DOCKER_NETWORK: 'a;b' }, '/d')).toBeNull();
  });
});

describe('preflight negativo', () => {
  test('falla sin socket', async () => {
    const cfg = resolveDockerDriverConfig(BASE_ENV, '/tmp/af-preflight-ut')!;
    const bad = { ...cfg, socketPath: '/tmp/af-no-such-socket-xyz.sock' };
    const r = await preflightDocker(new DockerCommandRunner(), bad);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.join(' ')).toMatch(process.platform === 'linux' ? /socket/ : /linux/);
  });
});

describe('driver: validación de args', () => {
  test('cada op rechaza args inválidos sin tocar Docker', async () => {
    const cfg = resolveDockerDriverConfig(BASE_ENV, '/tmp/af-driver-ut')!;
    const d = new DockerDeploymentDriver(cfg, { db: openTestDb() });
    const bad = { deploymentId: '../evil', projectId: 'p', candidateId: 'c' } as never;
    for (const op of [
      'buildCandidate',
      'prepareVerificationDatabase',
      'discardCandidate',
      'stopCurrentLiveRuntime',
    ] as const) {
      await expect((d[op] as (a: never) => Promise<unknown>)(bad)).rejects.toThrow();
    }
  });
  test('el driver exige DB: sin ella falla cerrado en el constructor', () => {
    const cfg = resolveDockerDriverConfig(BASE_ENV, '/tmp/af-driver-ut')!;
    for (const fn of [() => new DockerDeploymentDriver(cfg), () => new DockerDeploymentDriver(cfg, {} as never)]) {
      let code: string | undefined;
      try {
        fn();
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe('RECEIPT_DB_REQUIRED');
    }
  });
  test('assertDriverArgs del contrato sigue vigente', () => {
    expect(() =>
      assertDriverArgs({ deploymentId: 'd', projectId: 'p', candidateId: 'c; rm' }),
    ).toThrow();
  });
});

/**
 * Fase 7A — Tests unitarios del endurecimiento (vectores exactos de argv).
 */
import { describe, test, expect } from 'vitest';
import { hardenedRunArgs, hardenedTempVolumeArgs, assertNoForbiddenFlags, HardeningError } from './hardening.js';
import type { ManagedLabels } from './resources.js';

const LABELS: ManagedLabels = {
  projectId: '12345678-1234-1234-1234-1234567890ab',
  deploymentId: 'abcdefab-1234-1234-1234-1234567890ab',
  role: 'verify',
  fingerprint: 'a'.repeat(64),
};

const BASE = {
  name: 'appforge-app-12345678-verify-abcdefab',
  image: 'appforge/app-12345678:dep-abcdefab-aaaaaaaaaaaa',
  volume: 'appforge-verify-abcdefab-1234-1234-1234-1234567890ab-data',
  labels: LABELS,
  envFile: '/data/deploy-snapshots/abcdefab/runtime.env',
  network: 'appforge-apps',
};

describe('vectores exactos', () => {
  test('verify: flags completas de §8', () => {
    const args = hardenedRunArgs({ ...BASE, role: 'verify' });
    expect(args).toEqual([
      'run', '-d',
      '--name', BASE.name,
      '--label', 'com.appforge.managed=true',
      '--label', 'com.appforge.project-id=12345678-1234-1234-1234-1234567890ab',
      '--label', 'com.appforge.deployment-id=abcdefab-1234-1234-1234-1234567890ab',
      '--label', 'com.appforge.role=verify',
      '--label', 'com.appforge.source-fingerprint=' + 'a'.repeat(64),
      '--user', '1001',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--cap-drop=ALL',
      '--security-opt', 'no-new-privileges:true',
      '--pids-limit', '128',
      '--cpus', '1.0',
      '--memory', '512m',
      '--memory-swap', '512m',
      '--network', 'appforge-apps',
      '--restart', 'no',
      '--stop-timeout', '10',
      '-v', `${BASE.volume}:/data`,
      '--env-file', BASE.envFile,
      BASE.image,
    ]);
  });
  test('live: restart unless-stopped', () => {
    const args = hardenedRunArgs({ ...BASE, role: 'live', labels: { ...LABELS, role: 'live' } });
    expect(args).toContain('--restart');
    expect(args[args.indexOf('--restart') + 1]).toBe('unless-stopped');
  });
  test('migration: --rm, red none, comando fijo', () => {
    const args = hardenedRunArgs({
      ...BASE,
      role: 'migration',
      labels: { ...LABELS, role: 'migration' },
      command: ['node', 'backend/dist/migrate.js'],
    });
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '--name']);
    expect(args).toContain('none');
    expect(args).not.toContain('appforge-apps');
    expect(args.slice(-2)).toEqual(['node', 'backend/dist/migrate.js']);
    expect(args[args.length - 3]).toBe(BASE.image);
    expect(args).toContain('--restart');
    expect(args[args.indexOf('--restart') + 1]).toBe('no');
  });
  test('createOnly genera docker create', () => {
    const args = hardenedRunArgs({ ...BASE, role: 'verify' }, true);
    expect(args[0]).toBe('create');
    expect(args).not.toContain('-d');
  });
  test('sin puertos publicados por diseño', () => {
    for (const role of ['live', 'verify', 'migration'] as const) {
      const args = hardenedRunArgs({ ...BASE, role, labels: { ...LABELS, role } });
      expect(args).not.toContain('-p');
      expect(args).not.toContain('--publish');
    }
  });
});

describe('assertNoForbiddenFlags', () => {
  test('rechaza flags prohibidas', () => {
    expect(() => assertNoForbiddenFlags(['run', '--privileged', 'img'])).toThrowError(HardeningError);
    expect(() => assertNoForbiddenFlags(['run', '-p', '8080:8080', 'img'])).toThrowError(HardeningError);
    expect(() => assertNoForbiddenFlags(['run', '-v', '/var/run/docker.sock:/x', 'img'])).toThrowError(HardeningError);
    expect(() => assertNoForbiddenFlags(['run', '--network=host', 'img'])).toThrowError(HardeningError);
  });
  test('acepta vector endurecido', () => {
    expect(() => assertNoForbiddenFlags(hardenedRunArgs({ ...BASE, role: 'verify' }))).not.toThrow();
  });
});

describe('validación de spec', () => {
  test('rechaza nombres/imágenes/env-file maliciosos', () => {
    expect(() => hardenedRunArgs({ ...BASE, role: 'verify', name: '../evil' })).toThrowError(HardeningError);
    expect(() => hardenedRunArgs({ ...BASE, role: 'verify', image: 'evil; rm -rf /' })).toThrowError(HardeningError);
    expect(() => hardenedRunArgs({ ...BASE, role: 'verify', envFile: 'relative/path' })).toThrowError(HardeningError);
  });
});

describe('hardenedTempVolumeArgs (temporal de copia, NO-GO2 B2)', () => {
  test('vector endurecido sin labels de managed ni red', () => {
    const args = hardenedTempVolumeArgs({
      name: 'appforge-tmp-backup-abc12345',
      image: 'appforge/app-12345678:dep-abcdefab-aaaaaaaaaaaa',
      volume: 'appforge-project-12345678-1234-1234-1234-1234567890ab-data',
    });
    expect(args).toEqual([
      'create',
      '--name', 'appforge-tmp-backup-abc12345',
      '--user', '1001',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--cap-drop=ALL',
      '--security-opt', 'no-new-privileges:true',
      '--pids-limit', '128',
      '--cpus', '1.0',
      '--memory', '512m',
      '--memory-swap', '512m',
      '--network', 'none',
      '--stop-timeout', '5',
      '-v', 'appforge-project-12345678-1234-1234-1234-1234567890ab-data:/data',
      'appforge/app-12345678:dep-abcdefab-aaaaaaaaaaaa',
    ]);
    expect(() => assertNoForbiddenFlags(args)).not.toThrow();
  });

  test('rechaza nombres/imágenes/volúmenes inválidos', () => {
    const good = {
      name: 'appforge-tmp-backup-abc12345',
      image: 'appforge/app-12345678:dep-abcdefab-aaaaaaaaaaaa',
      volume: 'appforge-project-12345678-1234-1234-1234-1234567890ab-data',
    };
    expect(() => hardenedTempVolumeArgs({ ...good, name: 'mal nombre' })).toThrow(HardeningError);
    expect(() => hardenedTempVolumeArgs({ ...good, image: 'sin-tag' })).toThrow(HardeningError);
    expect(() => hardenedTempVolumeArgs({ ...good, volume: '' })).toThrow(HardeningError);
  });
});

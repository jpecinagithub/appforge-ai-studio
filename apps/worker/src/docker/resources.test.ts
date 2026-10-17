/**
 * Fase 7A — Tests unitarios del modelo de recursos (nombres, labels).
 * Las operaciones contra el daemon (list/create/rm de volúmenes) corren
 * si hay socket local; no necesitan imágenes.
 */
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import {
  resourceNames,
  labelArgs,
  assertLabelsMatch,
  assertUuid,
  id8,
  assertFingerprint,
  listManagedResources,
  inspectResource,
  resourceExists,
  MANAGED_LABEL,
  LABEL_PROJECT,
  ResourceError,
} from './resources.js';
import { DockerCommandRunner } from './commandRunner.js';

const PROJECT = '12345678-1234-1234-1234-1234567890ab';
const DEPLOY = 'abcdefab-1234-1234-1234-1234567890ab';
const FP = 'a'.repeat(64);

const HAS_DOCKER = (() => {
  try {
    fs.accessSync('/var/run/docker.sock');
    return true;
  } catch {
    return false;
  }
})();

describe('nombres canónicos (§5)', () => {
  test('vector exacto', () => {
    expect(resourceNames(PROJECT, DEPLOY, FP)).toEqual({
      image: `appforge/app-12345678:dep-abcdefab-${'a'.repeat(12)}`,
      liveContainer: 'appforge-app-12345678',
      verifyContainer: 'appforge-app-12345678-verify-abcdefab',
      liveVolume: `appforge-project-${PROJECT}-data`,
      verifyVolume: `appforge-verify-${DEPLOY}-data`,
    });
  });
  test('rechaza UUID malformados', () => {
    expect(() => resourceNames('no-uuid', DEPLOY, FP)).toThrowError(ResourceError);
    expect(() => resourceNames(PROJECT, DEPLOY, 'zzz')).toThrowError(ResourceError);
  });
  test('id8', () => {
    expect(id8(PROJECT)).toBe('12345678');
  });
  test('assertUuid / assertFingerprint', () => {
    expect(() => assertUuid('x', 'p')).toThrowError(ResourceError);
    expect(() => assertFingerprint('x'.repeat(64))).toThrowError(ResourceError);
    expect(() => assertFingerprint('g'.repeat(64))).toThrowError(ResourceError);
  });
});

describe('labels', () => {
  test('vector exacto de labelArgs', () => {
    expect(labelArgs({ projectId: PROJECT, deploymentId: DEPLOY, role: 'verify', fingerprint: FP })).toEqual([
      '--label',
      'com.appforge.managed=true',
      '--label',
      `com.appforge.project-id=${PROJECT}`,
      '--label',
      'com.appforge.deployment-id=abcdefab-1234-1234-1234-1234567890ab',
      '--label',
      'com.appforge.role=verify',
      '--label',
      `com.appforge.source-fingerprint=${FP}`,
    ]);
  });
  test('assertLabelsMatch acepta coincidencia exacta', () => {
    expect(() =>
      assertLabelsMatch(
        {
          [MANAGED_LABEL]: 'true',
          [LABEL_PROJECT]: PROJECT,
          'com.appforge.deployment-id': DEPLOY,
          'com.appforge.role': 'live',
          'com.appforge.source-fingerprint': FP,
        },
        { projectId: PROJECT, deploymentId: DEPLOY, role: 'live', fingerprint: FP },
      ),
    ).not.toThrow();
  });
  test('assertLabelsMatch rechaza recurso ajeno o sin labels', () => {
    const good = { projectId: PROJECT, deploymentId: DEPLOY, role: 'live' as const, fingerprint: FP };
    expect(() => assertLabelsMatch({}, good)).toThrowError(expect.objectContaining({ code: 'FOREIGN_RESOURCE' }));
    expect(() => assertLabelsMatch(undefined, good)).toThrowError(expect.objectContaining({ code: 'FOREIGN_RESOURCE' }));
    expect(() =>
      assertLabelsMatch({ [MANAGED_LABEL]: 'true', [LABEL_PROJECT]: 'other-project' }, good),
    ).toThrowError(expect.objectContaining({ code: 'FOREIGN_RESOURCE' }));
  });
});

describe('operaciones contra el daemon (volúmenes)', () => {
  test('create/list/exists/rm con labels', async () => {
    if (!HAS_DOCKER) return;
    const runner = new DockerCommandRunner();
    const vol = `af-ut-vol-${Date.now()}`;
    try {
      const c = await runner.run({
        args: ['volume', 'create', '--label', `${MANAGED_LABEL}=true`, '--label', `${LABEL_PROJECT}=${PROJECT}`, vol],
        timeoutMs: 15_000,
      });
      expect(c.code).toBe(0);
      expect(await resourceExists(runner, 'volume', vol)).toBe(true);
      expect(await resourceExists(runner, 'volume', 'af-ut-vol-missing-xyz')).toBe(false);
      const listed = await listManagedResources(runner, 'volume');
      expect(listed.some((r) => r.name === vol)).toBe(true);
      const info = (await inspectResource(runner, 'volume', vol)) as { Labels?: Record<string, string> };
      expect(info.Labels?.[MANAGED_LABEL]).toBe('true');
    } finally {
      await runner.run({ args: ['volume', 'rm', vol], timeoutMs: 15_000 });
    }
    expect(await resourceExists(runner, 'volume', vol)).toBe(false);
  });
});

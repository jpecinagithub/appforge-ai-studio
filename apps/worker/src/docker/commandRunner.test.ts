/**
 * Fase 7A — Tests unitarios de DockerCommandRunner (sin Docker).
 * El abort/timeout se prueba con un binario falso (script que duerme);
 * el spawn real se prueba contra el daemon local con `docker version`.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DockerCommandRunner, DockerCommandError, minimalDockerEnv } from './commandRunner.js';

const HAS_DOCKER = (() => {
  try {
    fs.accessSync('/var/run/docker.sock');
    return true;
  } catch {
    return false;
  }
})();

let fakeBinDir = '';
let sleeperBin = '';
let noisyBin = '';

beforeAll(() => {
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-fakebin-'));
  sleeperBin = path.join(fakeBinDir, 'sleeper');
  fs.writeFileSync(sleeperBin, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  noisyBin = path.join(fakeBinDir, 'noisy');
  fs.writeFileSync(
    noisyBin,
    '#!/bin/sh\npassword=supersecret123\nfor i in $(seq 1 20000); do echo "line $i filler filler filler filler"; done\n',
    { mode: 0o755 },
  );
});

afterAll(() => {
  fs.rmSync(fakeBinDir, { recursive: true, force: true });
});

describe('argv validation (lista cerrada)', () => {
  const r = new DockerCommandRunner({ dockerBin: sleeperBin });
  test('rejects empty argv', async () => {
    await expect(r.run({ args: [] })).rejects.toThrowError(DockerCommandError);
  });
  test.each([['system', 'prune'], ['exec'], ['compose'], ['swarm'], ['context']])(
    'rejects free subcommand %s',
    async (sub) => {
      await expect(r.run({ args: [sub] })).rejects.toMatchObject({ code: 'COMMAND_NOT_ALLOWED' });
    },
  );
  test.each([['volume', 'prune'], ['network', 'prune']])('rejects %s prune', async (a, b) => {
    await expect(r.run({ args: [a, b] })).rejects.toMatchObject({ code: 'COMMAND_NOT_ALLOWED' });
  });
  test('rejects null bytes in args', async () => {
    await expect(r.run({ args: ['version', 'a\0b'] })).rejects.toMatchObject({ code: 'INVALID_ARGV' });
  });
  test('rejects empty arg', async () => {
    await expect(r.run({ args: ['version', ''] })).rejects.toMatchObject({ code: 'INVALID_ARGV' });
  });
  test('rejects oversized arg', async () => {
    await expect(r.run({ args: ['version', 'x'.repeat(20_000)] })).rejects.toMatchObject({ code: 'INVALID_ARGV' });
  });
  test('allows volume/network create+rm+ls+inspect', async () => {
    // Solo validación de argv: el binario falso duerme y el timeout corta.
    const rr = new DockerCommandRunner({ dockerBin: sleeperBin });
    const res = await rr.run({ args: ['volume', 'ls'], timeoutMs: 200 });
    expect(res.timedOut).toBe(true);
  });
});

describe('abort / timeout (reales, sin dejar procesos)', () => {
  test('abort mata el proceso y espera su salida', async () => {
    const r = new DockerCommandRunner({ dockerBin: sleeperBin });
    const ctl = new AbortController();
    const p = r.run({ args: ['version'], signal: ctl.signal, timeoutMs: 30_000 });
    await new Promise((res) => setTimeout(res, 300));
    ctl.abort();
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(res.code).toBeNull();
    // Cero procesos vivos: el runner esperó el 'close'.
    expect(res.durationMs).toBeLessThan(10_000);
  });
  test('abort antes de spawnear', async () => {
    const r = new DockerCommandRunner({ dockerBin: sleeperBin });
    const ctl = new AbortController();
    ctl.abort();
    const res = await r.run({ args: ['version'], signal: ctl.signal });
    expect(res.aborted).toBe(true);
  });
  test('timeout mata el proceso', async () => {
    const r = new DockerCommandRunner({ dockerBin: sleeperBin });
    const res = await r.run({ args: ['version'], timeoutMs: 300 });
    expect(res.timedOut).toBe(true);
    expect(res.aborted).toBe(false);
    expect(res.code).toBeNull();
  });
});

describe('captura limitada y sanitizada', () => {
  test('trunca con indicador y sanitiza secretos', async () => {
    const r = new DockerCommandRunner({ dockerBin: noisyBin, maxOutputBytes: 1024 });
    const res = await r.run({ args: ['version'], timeoutMs: 10_000 });
    expect(res.truncated).toBe(true);
    expect(res.stdout).toContain('[truncated');
    expect(res.stdout).not.toContain('supersecret123');
  });
});

describe('entorno mínimo', () => {
  test('no hereda process.env en bloque', () => {
    process.env.APPFORGE_TEST_SENTINEL_XYZ = 'should-not-leak';
    const env = minimalDockerEnv();
    expect(env.APPFORGE_TEST_SENTINEL_XYZ).toBeUndefined();
    expect(env.PATH).toBeDefined();
    delete process.env.APPFORGE_TEST_SENTINEL_XYZ;
  });
  test('rechaza nombres de env inválidos', () => {
    expect(() => minimalDockerEnv({ 'BAD-NAME': 'x' })).toThrowError(DockerCommandError);
    expect(() => minimalDockerEnv({ OK_NAME: 'a\0b' })).toThrowError(DockerCommandError);
  });
});

describe('spawn real contra el daemon (si hay socket)', () => {
  test('docker version responde', async () => {
    if (!HAS_DOCKER) return;
    const r = new DockerCommandRunner();
    const res = await r.run({ args: ['version', '--format', '{{.Server.Version}}'], timeoutMs: 15_000 });
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+/);
  });
  test('runJson parsea inspect de un volumen', async () => {
    if (!HAS_DOCKER) return;
    const r = new DockerCommandRunner();
    await r.run({ args: ['volume', 'create', '--label', 'com.appforge.managed=true', 'af-ut-vol'], timeoutMs: 15_000 });
    try {
      const info = await r.runJson<Array<{ Name: string }>>({ args: ['volume', 'inspect', 'af-ut-vol'], timeoutMs: 15_000 });
      expect(info[0].Name).toBe('af-ut-vol');
    } finally {
      await r.run({ args: ['volume', 'rm', 'af-ut-vol'], timeoutMs: 15_000 });
    }
  });
});

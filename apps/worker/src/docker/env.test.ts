/**
 * Fase 7A — Tests unitarios de variables/secretos (§9).
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseEnvFile,
  writeValidatedEnvFile,
  baseEnvFor,
  ALLOWED_ENV_NAMES,
  EnvError,
} from './env.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-env-ut-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parseEnvFile', () => {
  test('parsea líneas válidas e ignora comentarios', () => {
    expect(parseEnvFile('# hola\nPORT=8080\n\nHOST=0.0.0.0\n')).toEqual([
      ['PORT', '8080'],
      ['HOST', '0.0.0.0'],
    ]);
  });
  test('rechaza nombres fuera de la allowlist', () => {
    expect(() => parseEnvFile('EVIL_VAR=1\n')).toThrowError(expect.objectContaining({ code: 'ENV_NOT_ALLOWED' }));
  });
  test('rechaza nombres malformados', () => {
    expect(() => parseEnvFile('bad-name=1\n')).toThrowError(expect.objectContaining({ code: 'INVALID_ENV_NAME' }));
  });
  test('rechaza null bytes', () => {
    expect(() => parseEnvFile('PORT=80\0\n')).toThrowError(expect.objectContaining({ code: 'NULL_BYTE' }));
  });
  test('rechaza duplicados ambiguos', () => {
    expect(() => parseEnvFile('PORT=8080\nPORT=9090\n')).toThrowError(expect.objectContaining({ code: 'DUPLICATE_ENV' }));
  });
  test('rechaza líneas sin =', () => {
    expect(() => parseEnvFile('PORT\n')).toThrowError(expect.objectContaining({ code: 'BAD_LINE' }));
  });
  test('rechaza valores con \\r', () => {
    expect(() => parseEnvFile('PORT=8080\r\n')).toThrowError(EnvError);
  });
});

describe('writeValidatedEnvFile', () => {
  const pid = '12345678-1234-1234-1234-1234567890ab';
  test('base del Studio + modo 0600', () => {
    const dest = path.join(root, 'runtime.env');
    writeValidatedEnvFile({ projectEnvPath: path.join(root, 'no-existe.env'), destPath: dest, projectId: pid });
    const st = fs.statSync(dest);
    expect(st.mode & 0o777).toBe(0o600);
    const content = fs.readFileSync(dest, 'utf8');
    expect(content).toContain('PORT=8080');
    expect(content).toContain(`PUBLIC_PATH=/a/${pid}/`);
    expect(content).toContain('NODE_ENV=production');
  });
  test('los valores base no son sobrescribibles', () => {
    const src = path.join(root, '.env');
    fs.writeFileSync(src, 'PORT=9999\nSESSION_TTL_DAYS=30\n');
    const dest = path.join(root, 'runtime.env');
    writeValidatedEnvFile({ projectEnvPath: src, destPath: dest, projectId: pid });
    const content = fs.readFileSync(dest, 'utf8');
    expect(content).toContain('PORT=8080');
    expect(content).toContain('SESSION_TTL_DAYS=7');
  });
  test('.env inválido del proyecto → error', () => {
    const src = path.join(root, '.env');
    fs.writeFileSync(src, 'EVIL=1\n');
    expect(() =>
      writeValidatedEnvFile({ projectEnvPath: src, destPath: path.join(root, 'r.env'), projectId: pid }),
    ).toThrowError(EnvError);
  });
});

describe('baseEnvFor', () => {
  test('valores exactos', () => {
    const pid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(baseEnvFor(pid)).toEqual({
      PORT: '8080',
      HOST: '0.0.0.0',
      NODE_ENV: 'production',
      DB_PATH: '/data/app.db',
      PUBLIC_PATH: `/a/${pid}/`,
      SESSION_COOKIE_NAME: 'af_session',
      SESSION_TTL_DAYS: '7',
    });
    for (const k of Object.keys(baseEnvFor(pid))) {
      expect(ALLOWED_ENV_NAMES.has(k)).toBe(true);
    }
  });
});

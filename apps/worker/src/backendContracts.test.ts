/**
 * Backend contract lint — unit tests (agent autonomy, 2026-10-21).
 * Reproduces the two contract violations of the live run a9864671
 * ("PcBox online"): an invented sendError code and db.transaction().
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backendContractViolations, backendContractsNote, parseErrorCodes } from './backendContracts.js';

const ERRORS_TS = `import type { FastifyReply } from 'fastify';
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL';
const STATUS: Record<ErrorCode, number> = { VALIDATION_ERROR: 400, UNAUTHORIZED: 401, NOT_FOUND: 404, CONFLICT: 409, RATE_LIMITED: 429, INTERNAL: 500 };
export function sendError(reply: FastifyReply, code: ErrorCode, message: string) { return reply.status(STATUS[code]).send({ error: { code, message } }); }
`;

function makeProject(errorsTs: string | null = ERRORS_TS): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-contracts-'));
  if (errorsTs !== null) {
    fs.mkdirSync(path.join(dir, 'backend', 'src', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'backend', 'src', 'lib', 'errors.ts'), errorsTs);
  }
  return dir;
}

describe('parseErrorCodes', () => {
  it('extracts the union members', () => {
    const codes = parseErrorCodes(ERRORS_TS);
    expect([...codes].sort()).toEqual(['CONFLICT', 'INTERNAL', 'NOT_FOUND', 'RATE_LIMITED', 'UNAUTHORIZED', 'VALIDATION_ERROR']);
  });
  it('returns empty when there is no union', () => {
    expect(parseErrorCodes('export const x = 1;').size).toBe(0);
  });
});

describe('backendContractViolations', () => {
  it('flags an invented sendError code, naming the valid set and the file to extend', () => {
    const dir = makeProject();
    const v = backendContractViolations(dir, ["return sendError(reply, 'INSUFFICIENT_STOCK', 'Not enough stock.');"]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('INSUFFICIENT_STOCK');
    expect(v[0]).toContain('backend/src/lib/errors.ts');
    expect(v[0]).toContain('VALIDATION_ERROR');
  });

  it('accepts valid codes', () => {
    const dir = makeProject();
    expect(backendContractViolations(dir, ["return sendError(reply, 'NOT_FOUND', 'Product not found.');"])).toEqual([]);
  });

  it('respects a union the project itself extended', () => {
    const dir = makeProject(ERRORS_TS.replace("'INTERNAL';", "'INTERNAL'\n  | 'INSUFFICIENT_STOCK';"));
    expect(backendContractViolations(dir, ["sendError(reply, 'INSUFFICIENT_STOCK', 'x')"])).toEqual([]);
  });

  it('flags .transaction( with the BEGIN IMMEDIATE pattern', () => {
    const dir = makeProject();
    const v = backendContractViolations(dir, ['const tx = db.transaction(() => { insert(); }); tx();']);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('NO .transaction()');
    expect(v[0]).toContain('BEGIN IMMEDIATE');
  });

  it('reports both violations together and stays silent on clean code', () => {
    const dir = makeProject();
    const bad = "sendError(reply, 'INSUFFICIENT_STOCK', 'x'); db.transaction(() => {})();";
    expect(backendContractViolations(dir, [bad])).toHaveLength(2);
    expect(backendContractsNote(dir, ['export const ok = 1;'])).toBeNull();
    expect(backendContractsNote(dir, [bad])).toContain('Backend contract check');
  });

  it('skips the code check when the project has no lib/errors.ts', () => {
    const dir = makeProject(null);
    expect(backendContractViolations(dir, ["sendError(reply, 'WHATEVER', 'x')"])).toEqual([]);
    // the transaction check is file-independent and still applies
    expect(backendContractViolations(dir, ['db.transaction(() => {})();'])).toHaveLength(1);
  });
});

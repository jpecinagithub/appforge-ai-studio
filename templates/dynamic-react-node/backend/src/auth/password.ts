import { randomBytes } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

// Contract §9.1: Argon2id, memory 19456 KiB, iterations 2, parallelism 1,
// 32-byte hash, 16-byte random salt. hash-wasm = pure WASM (no node-gyp).
const PARAMS = {
  parallelism: 1,
  iterations: 2,
  memorySize: 19456,
  hashLength: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return argon2id({
    password,
    salt,
    ...PARAMS,
    outputType: 'encoded', // PHC string embeds params + salt + hash
  });
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash: encodedHash });
  } catch {
    return false;
  }
}

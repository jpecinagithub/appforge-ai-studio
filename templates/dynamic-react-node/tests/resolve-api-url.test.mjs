/**
 * Unit tests for resolveApiUrl (frontend/src/api-url.ts).
 * The function is imported as TypeScript via node's type stripping —
 * this exercises the real implementation, not a copy.
 *
 * Run from the project root:  npm test
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiUrl } from '../frontend/src/api-url.ts';

describe('resolveApiUrl', () => {
  test('root deployment keeps /api at the origin', () => {
    assert.equal(
      resolveApiUrl('/api/auth/login', 'https://host/'),
      'https://host/api/auth/login',
    );
  });

  test('project prefix is preserved behind the Studio proxy', () => {
    assert.equal(
      resolveApiUrl('/api/auth/login', 'https://host/a/abc123/'),
      'https://host/a/abc123/api/auth/login',
    );
  });

  test('page file name in the URL does not leak into the API path', () => {
    assert.equal(
      resolveApiUrl('/api/auth/login', 'https://host/a/abc123/index.html'),
      'https://host/a/abc123/api/auth/login',
    );
  });

  test('nested API paths resolve under the prefix', () => {
    assert.equal(
      resolveApiUrl('/api/todos/9f2a', 'https://host/a/abc123/'),
      'https://host/a/abc123/api/todos/9f2a',
    );
  });

  test('local dev server', () => {
    assert.equal(
      resolveApiUrl('/api/todos', 'http://localhost:5173/'),
      'http://localhost:5173/api/todos',
    );
  });
});

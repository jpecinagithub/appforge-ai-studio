import { describe, expect, it } from 'vitest';
import { API_BASE, apiResourceUrl } from './client';

describe('apiResourceUrl', () => {
  it('resolves backend-relative asset paths against the configured API base', () => {
    expect(apiResourceUrl('/p/project/thumbnail.webp')).toBe(`${API_BASE}/p/project/thumbnail.webp`);
  });

  it('preserves absolute asset URLs', () => {
    expect(apiResourceUrl('https://cdn.example.com/thumbnail.webp')).toBe('https://cdn.example.com/thumbnail.webp');
  });
});

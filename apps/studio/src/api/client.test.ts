import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, api, apiResourceUrl, liveAppUrlFor } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('apiResourceUrl', () => {
  it('resolves backend-relative asset paths against the configured API base', () => {
    expect(apiResourceUrl('/p/project/thumbnail.webp')).toBe(`${API_BASE}/p/project/thumbnail.webp`);
  });

  it('preserves absolute asset URLs', () => {
    expect(apiResourceUrl('https://cdn.example.com/thumbnail.webp')).toBe('https://cdn.example.com/thumbnail.webp');
  });
});

describe('liveAppUrlFor', () => {
  it('builds the live dynamic-app URL under /a/', () => {
    expect(liveAppUrlFor('my-project')).toBe(`${API_BASE}/a/my-project/`);
  });

  it('encodes project ids', () => {
    expect(liveAppUrlFor('project/with spaces?')).toBe(`${API_BASE}/a/project%2Fwith%20spaces%3F/`);
  });
});

describe('production operation requests', () => {
  it('sends a fresh idempotency key and the Oracle target when deploying', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 202,
      text: async () => JSON.stringify({ id: 'deployment-1', status: 'pending' }),
      init,
    }));
    vi.stubGlobal('fetch', fetchMock);
    await api.deploy('project-1');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/project-1/deploy');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ target: 'oracle' }));
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

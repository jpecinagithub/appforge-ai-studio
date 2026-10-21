import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, api, apiResourceUrl, isProjectDeployed, liveAppUrlFor, publicAppUrlFor } from './client';

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

describe('publicAppUrlFor', () => {
  it('points static projects at the /p/ route by default', () => {
    expect(publicAppUrlFor('my app', 'https://studio.example')).toBe(
      'https://studio.example/p/my%20app/',
    );
  });

  it('points dynamic projects at the full-stack /a/ route, never /p/', () => {
    expect(publicAppUrlFor('my app', 'https://studio.example', 'dynamic')).toBe(
      'https://studio.example/a/my%20app/',
    );
  });
});

describe('isProjectDeployed', () => {
  it('is true when the deployment wrote productionUrl even if previewUrl is null', () => {
    expect(isProjectDeployed({ previewUrl: null, productionUrl: '/a/p1/' }, false)).toBe(true);
  });

  it('is true for legacy rows that only carry a previewUrl', () => {
    expect(isProjectDeployed({ previewUrl: '/p/p1/', productionUrl: null }, false)).toBe(true);
  });

  it('is false when both URLs are null', () => {
    expect(isProjectDeployed({ previewUrl: null, productionUrl: null }, false)).toBe(false);
  });

  it('is false in demo mode even with URLs present', () => {
    expect(isProjectDeployed({ previewUrl: '/p/p1/', productionUrl: '/a/p1/' }, true)).toBe(false);
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

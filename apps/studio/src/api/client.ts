import { demoArchiveBlob, demoFetch, demoPreviewHtml } from './demo';
import type {
  BuildRecord,
  ChatMessage,
  FileNode,
  Page,
  PreviewInfo,
  Project,
  RevisionInfo,
  Run,
  Settings,
} from './types';

/** Base del backend. Vacío = mismo origen (proxy de dev o despliegue conjunto). */
export const API_BASE: string =
  ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/$/, '');

const TOKEN_KEY = 'appforge_token';
const DEMO_KEY = 'appforge_demo';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
}

/** Modo demo: datos de ejemplo locales, siempre marcados como DEMO en la UI. */
export function isDemoMode(): boolean {
  if ((import.meta.env.VITE_DEMO as string | undefined) === '1') return true;
  try {
    return localStorage.getItem(DEMO_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDemoMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(DEMO_KEY, '1');
    else localStorage.removeItem(DEMO_KEY);
  } catch {
    /* noop */
  }
}

export class ApiError extends Error {
  code: string;
  status: number;
  detail?: string;

  constructor(code: string, status: number, detail?: string) {
    super(detail ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

interface SimpleResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

async function doFetch(path: string, init: RequestInit): Promise<SimpleResponse> {
  if (isDemoMode()) return demoFetch(path, init);
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...headers, ...((init.headers as Record<string, string> | undefined) ?? {}) },
    });
  } catch {
    throw new ApiError('NETWORK', 0);
  }
  return res;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await doFetch(path, init);
  if (res.status === 401 && !isDemoMode()) {
    window.dispatchEvent(new Event('appforge:unauthorized'));
    throw new ApiError('UNAUTHORIZED', 401);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(err?.code ?? `HTTP_${res.status}`, res.status, err?.message);
  }
  return data as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const post = (path: string, body?: unknown) =>
  request<never>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  health: () => request<{ ok: boolean; version: string }>('/api/health'),

  listProjects: (p: { search?: string; type?: string; status?: string; page?: number; pageSize?: number } = {}) =>
    request<Page<Project>>(`/api/projects${qs(p)}`),

  createProject: (body: { name: string; description?: string; type?: 'static' | 'dynamic' }) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),

  getProject: (id: string) => request<Project>(`/api/projects/${id}`),

  patchProject: (id: string, body: Partial<Pick<Project, 'name' | 'description' | 'status'>>) =>
    request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  listMessages: (id: string) =>
    request<{ items: ChatMessage[] }>(`/api/projects/${id}/messages`),

  postMessage: (id: string, body: { role: 'user' | 'assistant' | 'system'; content: string }) =>
    request<ChatMessage>(`/api/projects/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  createRun: (id: string, prompt: string) =>
    request<Run>(`/api/projects/${id}/runs`, { method: 'POST', body: JSON.stringify({ prompt }) }),

  listRuns: (id: string) => request<{ items: Run[] }>(`/api/projects/${id}/runs`),

  getRun: (runId: string) => request<Run>(`/api/runs/${runId}`),

  cancelRun: (runId: string) =>
    request<{ ok: boolean }>(`/api/runs/${runId}/cancel`, { method: 'POST' }),

  listFiles: (id: string) => request<{ tree: FileNode[] }>(`/api/projects/${id}/files`),

  getFileContent: (id: string, path: string) =>
    request<{ path: string; content: string }>(
      `/api/projects/${id}/files/content?path=${encodeURIComponent(path)}`,
    ),

  putFileContent: (id: string, path: string, content: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}/files/content`, {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),

  createBuild: (id: string) =>
    request<BuildRecord>(`/api/projects/${id}/builds`, { method: 'POST' }),

  listBuilds: (id: string) => request<{ items: BuildRecord[] }>(`/api/projects/${id}/builds`),

  getBuild: (buildId: string) => request<BuildRecord>(`/api/builds/${buildId}`),

  listRevisions: (id: string) =>
    request<{ items: RevisionInfo[] }>(`/api/projects/${id}/revisions`),

  createRevision: (id: string, label?: string) =>
    request<RevisionInfo>(`/api/projects/${id}/revisions`, {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),

  restoreRevision: (id: string, rid: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}/revisions/${rid}/restore`, { method: 'POST' }),

  getPreview: (id: string) => request<PreviewInfo>(`/api/projects/${id}/preview`),

  getSettings: () => request<Settings>('/api/settings'),

  patchSettings: (body: Partial<Settings>) =>
    request<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(body) }),

  deploy: (id: string) => post(`/api/projects/${id}/deploy`),
};

/** URL pública de la preview estática de un proyecto. */
export function previewUrlFor(projectId: string): string {
  return `${API_BASE}/p/${encodeURIComponent(projectId)}/`;
}

/** Abre la preview real o, en demo, un documento local funcional. */
export function openProjectPreview(projectId: string): void {
  if (!isDemoMode()) {
    window.open(previewUrlFor(projectId), '_blank', 'noopener');
    return;
  }
  const html = demoPreviewHtml(projectId);
  if (!html) return;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Descarga el ZIP del proyecto (GET /api/projects/:id/archive). */
export async function downloadArchive(project: Project): Promise<void> {
  let blob: Blob;
  let filename = `${project.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() || project.id}.zip`;
  if (isDemoMode()) {
    blob = demoArchiveBlob(project);
  } else {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/projects/${project.id}/archive`, { headers });
    } catch {
      throw new ApiError('NETWORK', 0);
    }
    if (res.status === 401) {
      window.dispatchEvent(new Event('appforge:unauthorized'));
      throw new ApiError('UNAUTHORIZED', 401);
    }
    if (!res.ok) throw new ApiError(`HTTP_${res.status}`, res.status);
    blob = await res.blob();
    const cd = res.headers.get('content-disposition');
    const m = cd && /filename="?([^"]+)"?/.exec(cd);
    if (m) filename = m[1];
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

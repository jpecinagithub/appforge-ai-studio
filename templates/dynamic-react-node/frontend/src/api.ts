import { resolveApiUrl } from './api-url';

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export interface Todo {
  id: string;
  title: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ApiErrorShape {
  error: { code: string; message: string };
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // API paths are resolved against the document base (see api-url.ts):
  // under the Studio proxy the app lives at /a/:projectId/ and absolute
  // /api/... paths would hit the Studio's own API instead of the project's.
  // Content-Type only when there is a body: Fastify rejects
  // application/json with an empty body (400).
  const url = resolveApiUrl(path, document.baseURI);
  const headers: Record<string, string> =
    init?.body !== undefined ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(url, {
    credentials: 'include',
    headers,
    ...init,
  });
  if (!res.ok) {
    let code = 'INTERNAL';
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as ApiErrorShape;
      code = body.error.code;
      message = body.error.message;
    } catch {
      /* keep defaults */
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export const api = {
  register: (email: string, password: string) =>
    request<{ user: User }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  login: (email: string, password: string) =>
    request<{ user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/api/auth/me'),
  profile: () => request<{ user: User }>('/api/users/me'),
  listTodos: () => request<{ items: Todo[] }>('/api/todos'),
  createTodo: (title: string) =>
    request<Todo>('/api/todos', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  updateTodo: (id: string, patch: { title?: string; done?: boolean }) =>
    request<Todo>(`/api/todos/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteTodo: (id: string) =>
    request<{ ok: true }>(`/api/todos/${id}`, { method: 'DELETE' }),
};

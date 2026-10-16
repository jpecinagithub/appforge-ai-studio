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
  // Relative API path: same origin as the frontend (no CORS).
  // Content-Type only when there is a body: Fastify rejects
  // application/json with an empty body (400).
  const headers: Record<string, string> =
    init?.body !== undefined ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(path, {
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

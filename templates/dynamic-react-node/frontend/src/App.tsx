import { useEffect, useState } from 'react';
import { ApiError, api, type Todo, type User } from './api';

type AuthMode = 'login' | 'register';

function AuthScreen({ onAuth }: { onAuth: (u: User) => void }) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { user } =
        mode === 'login'
          ? await api.login(email, password)
          : await api.register(email, password);
      onAuth(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" data-testid="auth-screen">
      <h1>{mode === 'login' ? 'Sign in' : 'Create account'}</h1>
      <p className="muted">
        {mode === 'login'
          ? 'Welcome back. Your session is a secure HttpOnly cookie.'
          : 'Password needs at least 12 characters. Stored as Argon2id.'}
      </p>
      <form onSubmit={submit}>
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            data-testid="auth-email"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            data-testid="auth-password"
          />
        </label>
        {error && <p className="error" data-testid="auth-error">{error}</p>}
        <button type="submit" disabled={busy} data-testid="auth-submit">
          {busy ? '…' : mode === 'login' ? 'Sign in' : 'Register'}
        </button>
      </form>
      <button
        className="link"
        data-testid="auth-toggle-mode"
        onClick={() => {
          setMode(mode === 'login' ? 'register' : 'login');
          setError(null);
        }}
      >
        {mode === 'login'
          ? 'No account? Register'
          : 'Have an account? Sign in'}
      </button>
    </div>
  );
}

function TasksScreen({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const { items } = await api.listTodos();
      setTodos(items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load tasks.');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    setTitle('');
    try {
      const todo = await api.createTodo(t);
      setTodos((prev) => [todo, ...prev]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create task.');
    }
  }

  async function toggle(todo: Todo) {
    try {
      const updated = await api.updateTodo(todo.id, { done: !todo.done });
      setTodos((prev) => prev.map((x) => (x.id === todo.id ? updated : x)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update task.');
    }
  }

  async function remove(todo: Todo) {
    try {
      await api.deleteTodo(todo.id);
      setTodos((prev) => prev.filter((x) => x.id !== todo.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete task.');
    }
  }

  return (
    <div className="card wide" data-testid="tasks-screen">
      <header className="topbar">
        <div>
          <h1>My tasks</h1>
          <p className="muted" data-testid="user-email">{user.email}</p>
        </div>
        <button className="ghost" onClick={onLogout} data-testid="logout-button">
          Sign out
        </button>
      </header>
      <form className="add" onSubmit={add}>
        <input
          placeholder="New task…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          data-testid="new-todo-input"
        />
        <button type="submit" data-testid="add-todo-button">Add</button>
      </form>
      {error && <p className="error" data-testid="tasks-error">{error}</p>}
      <ul className="todos" data-testid="todo-list">
        {todos.map((t) => (
          <li key={t.id} className={t.done ? 'done' : ''} data-testid="todo-item">
            <button
              className="check"
              onClick={() => void toggle(t)}
              aria-label={t.done ? 'Mark as pending' : 'Mark as done'}
            >
              {t.done ? '✓' : ''}
            </button>
            <span data-testid="todo-title">{t.title}</span>
            <button className="ghost danger" onClick={() => void remove(t)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      {todos.length === 0 && (
        <p className="muted">No tasks yet. Add your first one above.</p>
      )}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // Session recovery on reload: the HttpOnly cookie goes along.
    api
      .me()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  async function logout() {
    await api.logout().catch(() => {});
    setUser(null);
  }

  if (checking) {
    return (
      <div className="page">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="page">
      {user ? (
        <TasksScreen user={user} onLogout={() => void logout()} />
      ) : (
        <AuthScreen onAuth={setUser} />
      )}
    </div>
  );
}

import type { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { queryAll, queryOne } from '../db/index.js';
import { requireAuth } from '../auth/routes.js';
import { sendError } from '../lib/errors.js';
import type { AppConfig } from '../config.js';

const TITLE_MAX = 200;

interface TodoRow {
  id: string;
  user_id: string;
  title: string;
  done: number;
  created_at: string;
  updated_at: string;
}

function toJson(row: TodoRow) {
  return {
    id: row.id,
    title: row.title,
    done: row.done === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getTodo(db: DatabaseSync, id: string, userId: string) {
  return queryOne<TodoRow>(
    db,
    'SELECT * FROM todos WHERE id = ? AND user_id = ?',
    id,
    userId,
  );
}

/** Example domain resource. Every query is scoped by user_id (§9.6). */
export function registerTodoRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  config: AppConfig,
) {
  const auth = { preHandler: [requireAuth(db, config)] };

  app.get('/api/todos', auth, async (req, reply) => {
    const rows = queryAll<TodoRow>(
      db,
      'SELECT * FROM todos WHERE user_id = ? ORDER BY created_at DESC',
      req.userId!,
    );
    return reply.send({ items: rows.map(toJson) });
  });

  app.post('/api/todos', auth, async (req, reply) => {
    const body = (req.body ?? {}) as { title?: unknown };
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > TITLE_MAX) {
      return sendError(
        reply,
        'VALIDATION_ERROR',
        `Title is required (1-${TITLE_MAX} chars).`,
      );
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO todos(id, user_id, title, done, created_at, updated_at)
       VALUES(?, ?, ?, 0, ?, ?)`,
    ).run(id, req.userId!, title, now, now);
    const row = getTodo(db, id, req.userId!);
    if (!row) return sendError(reply, 'NOT_FOUND', 'Todo not found.');
    return reply.status(201).send(toJson(row));
  });

  app.get('/api/todos/:id', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = getTodo(db, id, req.userId!);
    // 404 even for other users' rows: never reveal existence (§9.6).
    if (!row) return sendError(reply, 'NOT_FOUND', 'Todo not found.');
    return reply.send(toJson(row));
  });

  app.patch('/api/todos/:id', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { title?: unknown; done?: unknown };
    const updates: string[] = [];
    const params: SQLInputValue[] = [];
    if (typeof body.title === 'string') {
      const title = body.title.trim();
      if (!title || title.length > TITLE_MAX) {
        return sendError(
          reply,
          'VALIDATION_ERROR',
          `Title must be 1-${TITLE_MAX} chars.`,
        );
      }
      updates.push('title = ?');
      params.push(title);
    }
    if (typeof body.done === 'boolean') {
      updates.push('done = ?');
      params.push(body.done ? 1 : 0);
    }
    if (updates.length === 0) {
      return sendError(
        reply,
        'VALIDATION_ERROR',
        'Nothing to update (title, done).',
      );
    }
    updates.push('updated_at = ?');
    params.push(new Date().toISOString(), id, req.userId!);
    const info = db
      .prepare(
        `UPDATE todos SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
      )
      .run(...params);
    if (info.changes === 0) {
      return sendError(reply, 'NOT_FOUND', 'Todo not found.');
    }
    const row = getTodo(db, id, req.userId!);
    if (!row) return sendError(reply, 'NOT_FOUND', 'Todo not found.');
    return reply.send(toJson(row));
  });

  app.delete('/api/todos/:id', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const info = db
      .prepare('DELETE FROM todos WHERE id = ? AND user_id = ?')
      .run(id, req.userId!);
    if (info.changes === 0) {
      return sendError(reply, 'NOT_FOUND', 'Todo not found.');
    }
    return reply.send({ ok: true });
  });
}

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword } from './password.js';
import { createSession, revokeSession, verifySession } from './session.js';
import { publicUser, sendError } from '../lib/errors.js';
import type { AppConfig } from '../config.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

const CredentialsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(256),
});

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  created_at: string;
}

function getUser(db: DatabaseSync, id: string): UserRow | undefined {
  return db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(id) as UserRow | undefined;
}

function setSessionCookie(
  reply: FastifyReply,
  config: AppConfig,
  token: string,
) {
  reply.setCookie(config.sessionCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: config.publicPath,
    maxAge: config.sessionTtlDays * 86_400,
  });
}

/**
 * preHandler for protected routes. Sets req.userId or answers 401.
 * Attach explicitly per route — never globally.
 */
export function requireAuth(
  db: DatabaseSync,
  config: AppConfig,
): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[config.sessionCookieName];
    const session = token ? verifySession(db, token) : null;
    if (!session) {
      return sendError(reply, 'UNAUTHORIZED', 'Not authenticated.');
    }
    req.userId = session.userId;
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  config: AppConfig,
) {
  // Public: register -------------------------------------------------------
  app.post('/api/auth/register', async (req, reply) => {
    const parsed = CredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(
        reply,
        'VALIDATION_ERROR',
        'Email must be valid and password at least 12 characters.',
      );
    }
    const { email, password } = parsed.data;
    const existing = db
      .prepare('SELECT id FROM users WHERE email = ?')
      .get(email.toLowerCase());
    if (existing) {
      return sendError(reply, 'CONFLICT', 'Email already registered.');
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO users(id, email, password_hash, display_name, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      email.toLowerCase(),
      await hashPassword(password),
      null,
      now,
      now,
    );
    const { token } = createSession(db, id, config.sessionTtlDays);
    setSessionCookie(reply, config, token);
    const user = getUser(db, id)!;
    return reply.status(201).send({ user: publicUser(user) });
  });

  // Public: login ----------------------------------------------------------
  app.post('/api/auth/login', async (req, reply) => {
    const parsed = CredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 'UNAUTHORIZED', 'Invalid email or password.');
    }
    const { email, password } = parsed.data;
    const user = db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email.toLowerCase()) as UserRow | undefined;
    // Same message for unknown users: no account enumeration.
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return sendError(reply, 'UNAUTHORIZED', 'Invalid email or password.');
    }
    const { token } = createSession(db, user.id, config.sessionTtlDays);
    setSessionCookie(reply, config, token);
    return reply.send({ user: publicUser(user) });
  });

  // Logout (idempotent) ----------------------------------------------------
  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[config.sessionCookieName];
    if (token) revokeSession(db, token);
    reply.clearCookie(config.sessionCookieName, { path: config.publicPath });
    return reply.send({ ok: true });
  });

  // Current session --------------------------------------------------------
  app.get(
    '/api/auth/me',
    { preHandler: [requireAuth(db, config)] },
    async (req, reply) => {
      const user = getUser(db, req.userId!);
      if (!user) return sendError(reply, 'UNAUTHORIZED', 'Not authenticated.');
      return reply.send({ user: publicUser(user) });
    },
  );
}

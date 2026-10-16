import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/routes.js';
import { publicUser, sendError } from '../lib/errors.js';
import type { AppConfig } from '../config.js';

export function registerUserRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  config: AppConfig,
) {
  app.get(
    '/api/users/me',
    { preHandler: [requireAuth(db, config)] },
    async (req, reply) => {
      const user = db
        .prepare('SELECT * FROM users WHERE id = ?')
        .get(req.userId!) as
        | {
            id: string;
            email: string;
            display_name: string | null;
            created_at: string;
          }
        | undefined;
      if (!user) return sendError(reply, 'UNAUTHORIZED', 'Not authenticated.');
      return reply.send({ user: publicUser(user) });
    },
  );
}

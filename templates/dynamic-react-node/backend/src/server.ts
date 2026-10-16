import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.js';
import {
  frontendDistDir,
  migrationsDir,
  openDatabase,
  runMigrations,
} from './db/index.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerUserRoutes } from './routes/users.js';
import { registerTodoRoutes } from './routes/todos.js';
import { rateLimit } from './lib/rate-limit.js';
import { sendError } from './lib/errors.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

export async function buildServer() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);

  // Migrations run at startup: every boot converges to the right schema.
  const applied = runMigrations(db, migrationsDir(), (m) =>
    console.log(`[migrate] ${m}`),
  );
  const fresh = applied.filter((m) => m.applied).length;
  if (fresh > 0) console.log(`[migrate] applied ${fresh} migration(s)`);

  const app = Fastify({ logger: false });
  await app.register(cookie);

  // Tolerate `Content-Type: application/json` with an empty body
  // (some clients send the header on bodyless requests): treat as no
  // body instead of 400. Malformed JSON still 400s.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      const text = typeof body === 'string' ? body : '';
      if (text.trim().length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  // Rate limit on the credential endpoints (contract §9.5).
  const authLimit = rateLimit(10);
  app.addHook('onRequest', async (req, reply) => {
    if (
      req.method === 'POST' &&
      (req.url === '/api/auth/register' || req.url === '/api/auth/login')
    ) {
      return authLimit(req, reply);
    }
  });

  // Public: health (no auth, no sensitive info — contract §9.8).
  app.get('/healthz', async (_req, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return reply.send({ ok: true, version });
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  registerAuthRoutes(app, db, config);
  registerUserRoutes(app, db, config);
  registerTodoRoutes(app, db, config);

  // Serve the built frontend (same origin: no CORS — contract §9.11).
  const dist = frontendDistDir();
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return sendError(reply, 'NOT_FOUND', 'Not found.');
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return sendError(reply, 'NOT_FOUND', 'Not found.');
      }
      return reply
        .type('text/html')
        .send(
          '<h1>Frontend not built</h1><p>Run <code>npm run build</code> in frontend/.</p>',
        );
    });
  }

  return { app, config, db };
}

async function main() {
  const { app, config } = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  const address = app.server.address();
  const actualPort =
    typeof address === 'object' && address ? address.port : config.port;
  console.log(`ready port=${actualPort} env=${config.nodeEnv}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

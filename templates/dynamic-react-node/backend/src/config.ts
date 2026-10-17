import { z } from 'zod';

const ConfigSchema = z.object({
  port: z.coerce.number().int().min(0).max(65535).default(8080),
  host: z.string().min(1).default('0.0.0.0'),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  dbPath: z.string().min(1).default('./data/app.db'),
  publicPath: z.string().min(1).default('/'),
  sessionCookieName: z.string().min(1).default('af_session'),
  sessionTtlDays: z.coerce.number().int().min(1).max(90).default(7),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/** All runtime configuration comes from the environment (never from code). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return ConfigSchema.parse({
    port: env.PORT,
    host: env.HOST,
    nodeEnv: env.NODE_ENV,
    dbPath: env.DB_PATH,
    publicPath: env.PUBLIC_PATH,
    sessionCookieName: env.SESSION_COOKIE_NAME,
    sessionTtlDays: env.SESSION_TTL_DAYS,
  });
}

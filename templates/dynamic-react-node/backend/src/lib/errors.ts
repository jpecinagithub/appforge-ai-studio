import type { FastifyReply } from 'fastify';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/** Uniform error shape: {"error":{"code","message"}}. Never leaks internals. */
export function sendError(
  reply: FastifyReply,
  code: ErrorCode,
  message: string,
) {
  return reply.status(STATUS[code]).send({ error: { code, message } });
}

export function publicUser(row: {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
}) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

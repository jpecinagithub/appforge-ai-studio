import type { FastifyRequest, FastifyReply } from 'fastify';
import { sendError } from './errors.js';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Tiny in-memory fixed-window rate limiter. Good enough for a single
 * instance (contract §9.5: 10 req/min/IP on register + login).
 */
export function rateLimit(maxPerMinute: number) {
  const buckets = new Map<string, Bucket>();
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.ip;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + 60_000 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maxPerMinute) {
      return sendError(reply, 'RATE_LIMITED', 'Too many requests.');
    }
    // Opportunistic cleanup so the map can't grow forever.
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) {
        if (b.resetAt <= now) buckets.delete(k);
      }
    }
  };
}

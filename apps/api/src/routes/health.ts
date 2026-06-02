import type { Context } from 'hono';

import { logToDatadog } from '../datadog';
import type { Env } from '../env';
import { json } from '../http';
import type { PrismaFactory } from '../lib/handler-utils';
import { getPrisma } from '../prisma';

export type HealthResponse =
  | { ok: true; db: 'ok'; latencyMs: number }
  | { ok: false; db: 'error'; latencyMs: number; error: string };

export function createHealthHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const prisma = prismaFor(c.env);
    const started = performance.now();

    try {
      await prisma.$queryRaw`SELECT 1`;
      const latencyMs = Math.round(performance.now() - started);
      const body: HealthResponse = { ok: true, db: 'ok', latencyMs };
      // AECI-31 smoke test: every /api/health call emits a Datadog log entry.
      // Distinct success / failure messages so Datadog Log Explorer can pivot
      // on `@route:/api/health @outcome:ok` vs `@outcome:db_error` without
      // parsing message strings.
      logToDatadog(c.executionCtx, c.env, c.req.raw, {
        message: `/api/health ok (${latencyMs}ms)`,
        route: '/api/health',
        outcome: 'ok',
        latencyMs,
        db: 'ok',
      });
      return json(body);
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const errorMessage = error instanceof Error ? error.message : 'Unexpected error';
      const body: HealthResponse = {
        ok: false,
        db: 'error',
        latencyMs,
        error: errorMessage,
      };
      console.error(`/api/health failed after ${latencyMs}ms`, error);
      logToDatadog(c.executionCtx, c.env, c.req.raw, {
        message: `/api/health failed: ${errorMessage} (${latencyMs}ms)`,
        level: 'error',
        route: '/api/health',
        outcome: 'db_error',
        latencyMs,
        db: 'error',
        error: errorMessage,
      });
      return json(body, { status: 500 });
    }
  };
}

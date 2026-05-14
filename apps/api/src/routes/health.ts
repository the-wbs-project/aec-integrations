import type { Context } from "hono";

import type { Env } from "../env";
import { json } from "../http";
import { getPrisma, type AcceleratedPrisma } from "../prisma";

export type HealthResponse =
  | { ok: true; db: "ok"; latencyMs: number }
  | { ok: false; db: "error"; latencyMs: number; error: string };

type PrismaFactory = (env: Env) => Pick<AcceleratedPrisma, "$queryRaw">;

export function createHealthHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const prisma = prismaFor(c.env);
    const started = performance.now();

    try {
      await prisma.$queryRaw`SELECT 1`;
      const latencyMs = Math.round(performance.now() - started);
      const body: HealthResponse = { ok: true, db: "ok", latencyMs };
      return json(body);
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const body: HealthResponse = {
        ok: false,
        db: "error",
        latencyMs,
        error: error instanceof Error ? error.message : "Unexpected error",
      };
      console.error(`/api/health failed after ${latencyMs}ms`, error);
      return json(body, { status: 500 });
    }
  };
}

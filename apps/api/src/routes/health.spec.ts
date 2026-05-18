import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { makeMockPrisma, type MockPrisma } from "../test/factories/prisma";
import { createHealthHandler } from "./health";

function buildApp(prisma: MockPrisma) {
  const app = new Hono<{ Bindings: Env }>();
  app.get(
    "/api/health",
    createHealthHandler(() => prisma as never),
  );
  return app;
}

function fakeExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  };
}

const env: Env = { DATABASE_URL: "prisma://test", ENV: "preview" };

describe("createHealthHandler", () => {
  it("returns 200 with { ok: true, db: 'ok', latencyMs } on Prisma success", async () => {
    // Guards: happy path response shape — the contract /api/health exposes to callers.
    const prisma = makeMockPrisma();
    const res = await buildApp(prisma).request("/api/health", {}, env, fakeExecutionContext());

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.db).toBe("ok");
    expect(typeof body.latencyMs).toBe("number");
  });

  it("calls prisma.$queryRaw with a SELECT 1 template", async () => {
    // Guards: AECI-28 acceptance — /api/health must round-trip a SELECT 1 via Prisma.
    const prisma = makeMockPrisma();
    await buildApp(prisma).request("/api/health", {}, env, fakeExecutionContext());

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const firstArg = prisma.$queryRaw.mock.calls[0]?.[0];
    expect(Array.isArray(firstArg)).toBe(true);
    expect((firstArg as TemplateStringsArray).join("")).toBe("SELECT 1");
  });

  it("returns 500 with { ok: false, db: 'error', error } when Prisma rejects", async () => {
    // Guards: error path surfaces the failure message so on-call can debug from logs.
    const prisma = makeMockPrisma({
      queryRaw: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    const res = await buildApp(prisma).request("/api/health", {}, env, fakeExecutionContext());
    errorSpy.mockRestore();

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      ok: false,
      db: "error",
      error: "connection refused",
    });
  });

  it("reports latencyMs as a non-negative integer", async () => {
    // Guards: rounding via Math.round; downstream dashboards parse this as an int.
    const prisma = makeMockPrisma();
    const res = await buildApp(prisma).request("/api/health", {}, env, fakeExecutionContext());
    const body = (await res.json()) as { latencyMs: number };

    expect(Number.isInteger(body.latencyMs)).toBe(true);
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("forwards a Datadog log via ctx.waitUntil when DD_API_KEY is set (AECI-31 smoke)", async () => {
    // Guards: every /api/health response emits a `message:health` log so the
    // §"smoke test: API health log visible in Datadog Logs" criterion can be
    // exercised every request — not just a one-off probe.
    const prisma = makeMockPrisma();
    const ctx = fakeExecutionContext();
    const envWithDd: Env = {
      ...env,
      DD_API_KEY: "secret-key",
      DD_SITE: "us5.datadoghq.com",
    };
    await buildApp(prisma).request("/api/health", {}, envWithDd, ctx);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("does not call ctx.waitUntil when DD_API_KEY is absent (no observability outage)", async () => {
    const prisma = makeMockPrisma();
    const ctx = fakeExecutionContext();
    await buildApp(prisma).request("/api/health", {}, env, ctx);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});

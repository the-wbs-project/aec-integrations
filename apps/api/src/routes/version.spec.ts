import { VersionResponseSchema } from '@aeci/shared';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { createVersionHandler } from './version';

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/api/version', createVersionHandler());
  return app;
}

function fakeExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  };
}

const baseEnv: Env = { DATABASE_URL: 'prisma://test' };

describe('createVersionHandler', () => {
  it('returns 200 with a body matching VersionResponseSchema', async () => {
    // Guards: AECI-74 contract — both apps/api and apps/web (proxied) must
    // serve the same shape that AECI-71's promote-to-prod workflow parses.
    const env: Env = {
      ...baseEnv,
      ENV: 'preview',
      COMMIT_SHA: 'abc123def456',
      DEPLOYED_AT: '2026-05-25T03:30:00.000Z',
    };
    const res = await buildApp().request('/api/version', {}, env, fakeExecutionContext());

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = VersionResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body).toEqual({
      sha: 'abc123def456',
      deployedAt: '2026-05-25T03:30:00.000Z',
      environment: 'preview',
    });
  });

  it("sets Cache-Control: 'private, no-store' so a stale value never lies", async () => {
    // Guards: the deployed SHA is mutable per push; caching this response
    // would tell callers the wrong commit is live, breaking the promotion
    // guard. The default in http.ts already does this; this test pins it.
    const res = await buildApp().request('/api/version', {}, baseEnv, fakeExecutionContext());
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('maps env.ENV verbatim to the response environment field', async () => {
    // Guards: AECI-71's promote-to-prod step compares the staging response's
    // `environment` against the workflow's expected stage. Any rewrite here
    // (uppercasing, aliasing) would silently break that check.
    for (const env of ['preview', 'staging', 'production'] as const) {
      const res = await buildApp().request(
        '/api/version',
        {},
        { ...baseEnv, ENV: env, COMMIT_SHA: 'sha', DEPLOYED_AT: '2026-05-25T00:00:00.000Z' },
        fakeExecutionContext(),
      );
      const body = (await res.json()) as { environment: string };
      expect(body.environment).toBe(env);
    }
  });

  it("returns environment: 'development' when ENV is undefined (local wrangler dev)", async () => {
    // Guards: `wrangler dev` without `--env preview` boots with no ENV var.
    // The local-development label keeps the response schema-valid and
    // distinguishes ad-hoc local runs from a deployed `preview` Worker.
    const res = await buildApp().request('/api/version', {}, baseEnv, fakeExecutionContext());
    const body = (await res.json()) as { environment: string };
    expect(body.environment).toBe('development');
  });

  it("returns sha: 'unknown' and an epoch deployedAt when injection vars are absent", async () => {
    // Guards: if a deploy script forgets the `--var COMMIT_SHA` flag, the
    // endpoint must still respond with a schema-valid body — the missing
    // injection is what's visible (sha=unknown), not a 500.
    const res = await buildApp().request('/api/version', {}, baseEnv, fakeExecutionContext());
    const body = (await res.json()) as { sha: string; deployedAt: string };
    expect(body.sha).toBe('unknown');
    expect(body.deployedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(VersionResponseSchema.safeParse(body).success).toBe(true);
  });
});

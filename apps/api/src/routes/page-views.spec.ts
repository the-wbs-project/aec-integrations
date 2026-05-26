import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { createPageViewsHandler } from './page-views';

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/api/page-views', createPageViewsHandler());
  return app;
}

function fakeExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  };
}

const env: Env = { DATABASE_URL: 'prisma://test', ENV: 'preview' };

function jsonRequest(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('createPageViewsHandler', () => {
  it('returns 204 with empty body for a minimal valid payload', async () => {
    // Guards: Phase 2 §7.1 contract — endpoint accepts { route } and returns
    // 204 No Content as a fire-and-forget capture hook.
    const res = await buildApp().request(
      '/api/page-views',
      jsonRequest({ route: '/products/foo' }),
      env,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('returns 204 for a fully populated payload (route, entity_type, entity_id)', async () => {
    // Guards: optional fields documented in PageViewPayloadSchema do not
    // change the response shape — still 204, still body-less.
    const res = await buildApp().request(
      '/api/page-views',
      jsonRequest({
        route: '/vendors/acme',
        entity_type: 'vendor',
        entity_id: 'acme',
      }),
      env,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('returns 400 when route is missing', async () => {
    // Guards: Zod schema requires route — missing field surfaces as 400.
    const res = await buildApp().request(
      '/api/page-views',
      jsonRequest({}),
      env,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/route/);
  });

  it('returns 400 when route is an empty string', async () => {
    // Guards: PageViewPayloadSchema's .min(1) on route — empty strings are
    // not a valid route and must be rejected, not silently accepted.
    const res = await buildApp().request(
      '/api/page-views',
      jsonRequest({ route: '' }),
      env,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/route/);
  });

  it('returns 400 when the body is malformed JSON', async () => {
    // Guards: c.req.json() throws on syntactically invalid JSON; the handler
    // must convert that to a typed 400 rather than letting Hono surface a 500.
    const res = await buildApp().request(
      '/api/page-views',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      },
      env,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/JSON/i);
  });

  it("sets Cache-Control: 'private, no-store' on the 204 success response (AECI-43)", async () => {
    // Guards: capture endpoint must never be cached — applies to body-less
    // 204 responses just as much as JSON ones.
    const res = await buildApp().request(
      '/api/page-views',
      jsonRequest({ route: '/products/foo' }),
      env,
      fakeExecutionContext(),
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it("sets Cache-Control: 'private, no-store' on the 400 error response (AECI-43)", async () => {
    // Guards: validation failures inherit the same no-cache default via the
    // shared badRequest() helper.
    const res = await buildApp().request(
      '/api/page-views',
      jsonRequest({}),
      env,
      fakeExecutionContext(),
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('does not import the Prisma client (Phase 2 no-op acceptance criterion)', () => {
    // Guards: AECI-55 explicitly requires no DB connection in Phase 2 — the
    // simplest structural enforcement is that the handler module never
    // imports getPrisma / AcceleratedPrisma. If a future change reintroduces
    // a DB dependency before Phase 4, this test fails loudly.
    const source = readFileSync(fileURLToPath(new URL('./page-views.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\.\/prisma['"]/);
    expect(source).not.toMatch(/getPrisma/);
  });

  it('is idempotent and side-effect-free across repeated calls', async () => {
    // Guards: §"Endpoint is idempotent and side-effect-free in Phase 2;
    // tests assert this" — two identical posts produce identical 204s and
    // touch no shared state.
    const app = buildApp();
    const first = await app.request(
      '/api/page-views',
      jsonRequest({ route: '/products/foo' }),
      env,
      fakeExecutionContext(),
    );
    const second = await app.request(
      '/api/page-views',
      jsonRequest({ route: '/products/foo' }),
      env,
      fakeExecutionContext(),
    );

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(await first.text()).toBe('');
    expect(await second.text()).toBe('');
  });
});

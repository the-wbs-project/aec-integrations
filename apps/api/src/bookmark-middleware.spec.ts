/**
 * `bookmarkMiddleware` (AECI-250) — emits the D1 Sessions API `x-d1-bookmark`
 * response header from the per-request `dbCtx`.
 *
 * Mirrors the production wiring (and `metrics-middleware.spec.ts`): the middleware
 * lives on the PARENT app while the handler that stashes `dbCtx` lives on a
 * mounted sub-router — which is exactly how the real write handlers sit relative
 * to the root middleware. Hono's `route()` runs both on the same context, so this
 * also guards that cross-app `c.set('dbCtx')` → root `c.get('dbCtx')` sharing.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { bookmarkMiddleware } from './bookmark-middleware';
import type { DbContext } from './db/client';
import type { Env } from './env';

const env = { DATABASE_URL: 'prisma://x', ENV: 'preview' } as unknown as Env;

function dbCtx(bookmark: string | null): DbContext {
  return { db: {} as DbContext['db'], getBookmark: () => bookmark };
}

function makeApp() {
  const sub = new Hono<{ Bindings: Env }>();
  // A write handler stashes its DbContext exactly like `writeDb()` does.
  sub.post('/api/write', (c) => {
    c.set('dbCtx', dbCtx('bk-1'));
    return c.json({ ok: true });
  });
  sub.post('/api/write-null', (c) => {
    c.set('dbCtx', dbCtx(null));
    return c.json({ ok: true });
  });
  // A read handler never sets dbCtx.
  sub.get('/api/read', (c) => c.json({ ok: true }));

  const app = new Hono<{ Bindings: Env }>();
  app.use('*', bookmarkMiddleware());
  app.route('/', sub);
  return app;
}

describe('bookmarkMiddleware (AECI-250)', () => {
  it('emits x-d1-bookmark from a sub-router write handler dbCtx', async () => {
    const res = await makeApp().fetch(new Request('http://api/api/write', { method: 'POST' }), env);
    expect(res.headers.get('x-d1-bookmark')).toBe('bk-1');
  });

  it('omits the header when getBookmark() returns null', async () => {
    const res = await makeApp().fetch(
      new Request('http://api/api/write-null', { method: 'POST' }),
      env,
    );
    expect(res.headers.get('x-d1-bookmark')).toBeNull();
  });

  it('omits the header on reads that never set dbCtx', async () => {
    const res = await makeApp().fetch(new Request('http://api/api/read'), env);
    expect(res.headers.get('x-d1-bookmark')).toBeNull();
  });
});

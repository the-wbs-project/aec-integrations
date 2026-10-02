/**
 * `activityMiddleware()` (AECI-1208) against the in-memory D1 harness.
 *
 * Mirrors production wiring: the middleware sits on the ROOT app, and the handlers
 * with their guard sit on a mounted sub-router, exactly as `index.ts` registers
 * them. A stand-in guard sets `c.get('auth')` the way `requireAuth()` does.
 *
 * The two tests that matter most are the erasure ones. `DELETE /api/account`
 * followed by a drained `waitUntil` must leave zero rows for the user, and so must
 * a request from another tab whose write lands after the erasure batch.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { activityMiddleware, USER_ACTIVITY_WRITE_METRIC } from './activity-middleware';
import type { DbContext } from './db/client';
import { profiles, userActivityDaily } from './db/schema';
import type { Env } from './env';
import { errorHandler } from './errors';
import type { AuthenticatedSession, AuthzVariables } from './lib/authz';
import type { DbFactory } from './lib/handler-utils';
import { ActivityThrottle } from './lib/user-activity';
import { submitCount } from './posthog';
import { createDeleteAccountHandler } from './routes/account';
import { makeTestDb, type TestDb } from './test/d1';
import { TEST_ENV } from './test/helpers';

vi.mock('./posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));
vi.mock('./lib/email', () => ({
  sendAccountDeletionEmail: vi.fn(() => Promise.resolve('sent')),
}));

const USER = '00000000-0000-4000-8000-000000000900';

const session = (over: Partial<AuthenticatedSession> = {}): AuthenticatedSession => ({
  userId: USER,
  email: 'me@example.com',
  role: 'vendor_admin',
  vendorId: 'v1',
  entitlementTier: 'unclaimed',
  entitlement: null,
  ...over,
});

/** An ExecutionContext that keeps every `waitUntil` promise so a test can drain it. */
function collectingCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, drain: () => Promise.all(pending.splice(0)) };
}

let t: TestDb;
let clock: Date;
let throttle: ActivityThrottle;

beforeEach(async () => {
  t = await makeTestDb();
  clock = new Date('2026-10-02T10:00:00.000Z');
  throttle = new ActivityThrottle();
  vi.mocked(submitCount).mockClear();
});
afterEach(() => t.dispose());

function makeApp(opts: { dbFor?: DbFactory; auth?: AuthenticatedSession | null } = {}) {
  const sub = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  sub.onError(errorHandler());
  sub.use('*', async (c, next) => {
    const auth = opts.auth === undefined ? session() : opts.auth;
    if (auth) c.set('auth', auth);
    await next();
  });
  sub.get('/api/vendor/me', (c) => c.json({ ok: true }));
  sub.get('/api/admin/summary', (c) => c.json({ ok: true }));
  sub.get('/api/account', (c) => c.json({ ok: true }));
  sub.get('/api/vendor/boom', () => {
    throw new Error('handler blew up');
  });
  sub.get('/api/vendor/teapot', (c) => c.json({ ok: false }, 418));
  sub.post('/api/activity/arrival', () => new Response(null, { status: 204 }));
  sub.delete(
    '/api/account',
    createDeleteAccountHandler(t.factory, async () => ({ ok: true })) as never,
  );

  const app = new Hono<{ Bindings: Env }>();
  app.use('*', activityMiddleware({ dbFor: opts.dbFor ?? t.factory, now: () => clock, throttle }));
  app.route('/', sub);
  return app;
}

async function call(
  app: Hono<{ Bindings: Env }>,
  path: string,
  method = 'GET',
  ctx = collectingCtx(),
) {
  const res = await app.fetch(new Request(`http://api${path}`, { method }), TEST_ENV, ctx.ctx);
  return { res, ctx };
}

const rows = () => t.db.select().from(userActivityDaily);
const metricOutcomes = () =>
  vi
    .mocked(submitCount)
    .mock.calls.filter((c) => c[3] === USER_ACTIVITY_WRITE_METRIC)
    .map((c) => c[5]);

describe('activityMiddleware — the write', () => {
  beforeEach(async () => {
    await t.db.insert(profiles).values({ id: USER, role: 'vendor_admin', vendorId: null });
  });

  it('gives a signed-in user one row for the day on any authenticated request', async () => {
    const app = makeApp();
    const { res, ctx } = await call(app, '/api/vendor/me');
    await ctx.drain();

    expect(res.status).toBe(200);
    expect(await rows()).toEqual([
      expect.objectContaining({
        userId: USER,
        day: '2026-10-02',
        role: 'vendor_admin',
        vendorId: 'v1',
        firstSeenAt: '2026-10-02T10:00:00.000Z',
        lastSeenAt: '2026-10-02T10:00:00.000Z',
        surfaces: 1,
      }),
    ]);
    expect(metricOutcomes()).toEqual([['outcome:written']]);
  });

  it('two requests on one day give one row: bits OR together and last_seen advances', async () => {
    const app = makeApp();
    await (await call(app, '/api/vendor/me')).ctx.drain();
    clock = new Date('2026-10-02T10:01:00.000Z');
    await (await call(app, '/api/admin/summary')).ctx.drain();

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      surfaces: 1 | 2,
      firstSeenAt: '2026-10-02T10:00:00.000Z',
      lastSeenAt: '2026-10-02T10:01:00.000Z',
    });
  });

  it('throttles a repeat inside 5 minutes and emits no metric for it', async () => {
    const app = makeApp();
    await (await call(app, '/api/vendor/me')).ctx.drain();
    clock = new Date('2026-10-02T10:04:00.000Z');
    await (await call(app, '/api/vendor/me')).ctx.drain();
    expect((await rows())[0]?.lastSeenAt).toBe('2026-10-02T10:00:00.000Z');
    expect(metricOutcomes()).toHaveLength(1);

    clock = new Date('2026-10-02T10:05:00.000Z');
    await (await call(app, '/api/vendor/me')).ctx.drain();
    expect((await rows())[0]?.lastSeenAt).toBe('2026-10-02T10:05:00.000Z');
    expect(metricOutcomes()).toHaveLength(2);
  });

  it('a request on the next day gives a second row', async () => {
    const app = makeApp();
    await (await call(app, '/api/vendor/me')).ctx.drain();
    clock = new Date('2026-10-03T00:00:01.000Z');
    await (await call(app, '/api/vendor/me')).ctx.drain();
    expect((await rows()).map((r) => r.day)).toEqual(['2026-10-02', '2026-10-03']);
  });

  it('records the header probe on /api/account without setting a surface bit', async () => {
    const app = makeApp();
    await (await call(app, '/api/account')).ctx.drain();
    expect(await rows()).toEqual([expect.objectContaining({ surfaces: 0 })]);
  });

  it('a write failure never fails the request, and counts outcome:failed', async () => {
    const failing: DbFactory = () => {
      throw new Error('D1 down');
    };
    const app = makeApp({ dbFor: failing });
    const { res, ctx } = await call(app, '/api/vendor/me');
    await ctx.drain();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(metricOutcomes()).toEqual([['outcome:failed']]);
  });

  it('writes on a 4xx the handler chose, since the guard let the user in', async () => {
    const app = makeApp();
    const { res, ctx } = await call(app, '/api/vendor/teapot');
    await ctx.drain();
    expect(res.status).toBe(418);
    expect(await rows()).toHaveLength(1);
  });
});

describe('activityMiddleware — what it never writes', () => {
  beforeEach(async () => {
    await t.db.insert(profiles).values({ id: USER, role: 'vendor_admin' });
  });

  it('writes nothing without a session (a guard that 401s sets none)', async () => {
    const app = makeApp({ auth: null });
    const { ctx } = await call(app, '/api/vendor/me');
    await ctx.drain();
    expect(await rows()).toEqual([]);
    expect(metricOutcomes()).toEqual([]);
  });

  it('writes nothing on a 5xx', async () => {
    const app = makeApp();
    const { res, ctx } = await call(app, '/api/vendor/boom');
    await ctx.drain();
    expect(res.status).toBe(500);
    expect(await rows()).toEqual([]);
  });

  it('leaves the arrival beacon to write its own row', async () => {
    const app = makeApp();
    const { ctx } = await call(app, '/api/activity/arrival', 'POST');
    await ctx.drain();
    expect(await rows()).toEqual([]);
  });
});

describe('activityMiddleware — erasure (AUTH_AND_RLS.md §8)', () => {
  beforeEach(async () => {
    await t.db.insert(profiles).values({ id: USER, role: 'reviewer' });
  });

  it('DELETE /api/account then a drained waitUntil leaves zero rows for the user', async () => {
    const app = makeApp({ auth: session({ role: 'reviewer', vendorId: null }) });
    await (await call(app, '/api/vendor/me')).ctx.drain();
    expect(await rows()).toHaveLength(1);

    // A new surface bit, so the throttle would let a write through if the
    // middleware tried one on the delete.
    clock = new Date('2026-10-02T11:00:00.000Z');
    const before = metricOutcomes().length;
    const { res, ctx } = await call(app, '/api/account', 'DELETE');
    await ctx.drain();

    expect(res.status).toBe(200);
    expect(await t.db.select().from(profiles)).toEqual([]);
    expect(await rows()).toEqual([]);
    // The middleware did not even attempt a write on the erasure request; the
    // profile gate is the second line, not the first.
    expect(metricOutcomes()).toHaveLength(before);
  });

  it('a racing request whose write lands after the erasure leaves zero rows', async () => {
    // The racing request's write is held until the erasure has committed, the way
    // a slow `waitUntil` from another tab would land.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const delayed: DbFactory = () => {
      const db = new Proxy(t.db, {
        get(target, prop, receiver) {
          if (prop === 'run') {
            return async (q: Parameters<typeof target.run>[0]) => {
              await gate;
              return target.run(q);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return { db, getBookmark: () => null } satisfies DbContext;
    };

    const racer = makeApp({ dbFor: delayed, auth: session({ role: 'reviewer', vendorId: null }) });
    const { ctx: racing } = await call(racer, '/api/vendor/me');

    const app = makeApp({ auth: session({ role: 'reviewer', vendorId: null }) });
    const { res, ctx } = await call(app, '/api/account', 'DELETE');
    await ctx.drain();
    expect(res.status).toBe(200);

    release();
    await racing.drain();

    // The racing write ran (and counted as written), but the profile gate made it
    // insert nothing.
    expect(metricOutcomes()).toContainEqual(['outcome:written']);
    expect(await rows()).toEqual([]);
  });
});

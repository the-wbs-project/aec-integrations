/**
 * `POST /api/activity/arrival` (AECI-1208) against the in-memory D1 harness, plus
 * its registration in `index.ts` (guard, then the write limiter).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { profiles, userActivityDaily } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { upsertUserActivity } from '../lib/user-activity';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createActivityArrivalHandler } from './activity-arrival';

const USER = '00000000-0000-4000-8000-000000000901';

let t: TestDb;
let clock: Date;
beforeEach(async () => {
  t = await makeTestDb();
  clock = new Date('2026-10-02T10:00:00.000Z');
});
afterEach(() => t.dispose());

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', {
      userId: USER,
      email: 'v@example.com',
      role: 'vendor_admin',
      vendorId: 'v1',
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
    await next();
  });
  a.post(
    '/api/activity/arrival',
    createActivityArrivalHandler(t.factory, () => clock),
  );
  return a;
}

const post = (body: unknown) =>
  app().request(
    '/api/activity/arrival',
    {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
    TEST_ENV,
    fakeExecutionContext(),
  );

const rows = () => t.db.select().from(userActivityDaily);

describe('POST /api/activity/arrival', () => {
  beforeEach(async () => {
    await t.db.insert(profiles).values({ id: USER, role: 'vendor_admin' });
  });

  it('creates the day row with the arrival when it is the first request of the day', async () => {
    const res = await post({ utm_source: 'email', utm_campaign: 'seat_invite', n: '42' });

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(await rows()).toEqual([
      {
        userId: USER,
        day: '2026-10-02',
        role: 'vendor_admin',
        vendorId: 'v1',
        firstSeenAt: '2026-10-02T10:00:00.000Z',
        lastSeenAt: '2026-10-02T10:00:00.000Z',
        surfaces: 0,
        arrivalUtmSource: 'email',
        arrivalUtmCampaign: 'seat_invite',
        arrivalNotificationId: '42',
        arrivalAt: '2026-10-02T10:00:00.000Z',
      },
    ]);
  });

  it('a second beacon does not overwrite the first', async () => {
    await post({ utm_source: 'email', n: '42' });
    clock = new Date('2026-10-02T10:02:00.000Z');
    const res = await post({ utm_source: 'linkedin', utm_campaign: 'launch' });

    expect(res.status).toBe(204);
    const [row] = await rows();
    expect(row).toMatchObject({
      arrivalUtmSource: 'email',
      arrivalUtmCampaign: null,
      arrivalNotificationId: '42',
      arrivalAt: '2026-10-02T10:00:00.000Z',
      lastSeenAt: '2026-10-02T10:02:00.000Z',
    });
  });

  it('adds the arrival to a row the middleware already wrote, keeping its surfaces', async () => {
    await upsertUserActivity(t.db, {
      userId: USER,
      role: 'vendor_admin',
      vendorId: 'v1',
      at: new Date('2026-10-02T09:00:00.000Z'),
      surfaces: 1,
    });
    await post({ n: '7' });
    const [row] = await rows();
    expect(row).toMatchObject({
      firstSeenAt: '2026-10-02T09:00:00.000Z',
      surfaces: 1,
      arrivalNotificationId: '7',
      arrivalAt: '2026-10-02T10:00:00.000Z',
    });
  });

  it('refuses a body that is empty, has an unknown key, or a bad value', async () => {
    for (const body of [
      {},
      { utm_source: 'email', utm_medium: 'x' },
      { utm_source: 'a'.repeat(101) },
      { n: 'abc' },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect((await post('not json')).status).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it('writes nothing once the profile is gone', async () => {
    await t.db.delete(profiles);
    const res = await post({ utm_source: 'email' });
    expect(res.status).toBe(204);
    expect(await rows()).toEqual([]);
  });
});

describe('route registration (apps/api/src/index.ts)', () => {
  const index = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
  const squash = (s: string) => s.replace(/\s+/g, ' ');

  it('guards the beacon with requireAuth, THEN the write limiter', () => {
    expect(squash(index)).toContain(
      "authActivity.post( '/api/activity/arrival', requireAuth(), rateLimit('write'), createActivityArrivalHandler(), );",
    );
  });

  it('registers the activity middleware on the root app', () => {
    expect(index).toContain("app.use('*', activityMiddleware());");
  });
});

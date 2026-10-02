/**
 * `lib/user-activity.ts` (AECI-1208): the surface map, the per-isolate throttle,
 * and the profile-gated upsert against the in-memory D1 harness.
 */

import { USER_ACTIVITY_SURFACE_BITS } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { profiles, userActivityDaily } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  ACTIVITY_THROTTLE_MAX_KEYS,
  ACTIVITY_THROTTLE_MS,
  ActivityThrottle,
  surfacesForRequest,
  upsertUserActivity,
  utcDay,
} from './user-activity';

const B = USER_ACTIVITY_SURFACE_BITS;

describe('surfacesForRequest', () => {
  it('maps each prefix to its bit', () => {
    expect(surfacesForRequest('/api/vendor/me')).toBe(B.vendor_portal);
    expect(surfacesForRequest('/api/vendor/products/p1/versions')).toBe(B.vendor_portal);
    expect(surfacesForRequest('/api/admin/summary')).toBe(B.admin);
    expect(surfacesForRequest('/api/account/reviews')).toBe(B.account);
    expect(surfacesForRequest('/api/seat-invites/tok/accept')).toBe(B.account);
    expect(surfacesForRequest('/api/reviews')).toBe(B.reviews);
    expect(surfacesForRequest('/api/reviews/abc')).toBe(B.reviews);
  });

  it('marks nothing for the header probe on exact /api/account', () => {
    expect(surfacesForRequest('/api/account')).toBe(0);
  });

  it('marks nothing outside the map, and is not fooled by look-alikes', () => {
    expect(surfacesForRequest('/api/products')).toBe(0);
    expect(surfacesForRequest('/api/vendors/acme')).toBe(0);
    expect(surfacesForRequest('/api/vendor')).toBe(0);
    expect(surfacesForRequest('/api/administrator')).toBe(0);
    expect(surfacesForRequest('/api/reviewsx')).toBe(0);
    expect(surfacesForRequest('/api/activity/arrival')).toBe(0);
  });
});

describe('ActivityThrottle', () => {
  it('writes the first time it sees a key', () => {
    const t = new ActivityThrottle();
    expect(t.shouldWrite('u|d', 0, 0)).toBe(true);
  });

  it('skips a repeat inside the interval with no new bit', () => {
    const t = new ActivityThrottle();
    t.shouldWrite('u|d', B.admin, 0);
    expect(t.shouldWrite('u|d', B.admin, ACTIVITY_THROTTLE_MS - 1)).toBe(false);
    expect(t.shouldWrite('u|d', 0, 1000)).toBe(false);
  });

  it('writes when a new surface bit appears, even inside the interval', () => {
    const t = new ActivityThrottle();
    t.shouldWrite('u|d', B.admin, 0);
    expect(t.shouldWrite('u|d', B.vendor_portal, 1000)).toBe(true);
    // Both bits are now remembered.
    expect(t.shouldWrite('u|d', B.admin, 2000)).toBe(false);
    expect(t.shouldWrite('u|d', B.vendor_portal, 2000)).toBe(false);
  });

  it('writes again once 5 minutes have passed since the last write', () => {
    const t = new ActivityThrottle();
    t.shouldWrite('u|d', 0, 0);
    expect(t.shouldWrite('u|d', 0, ACTIVITY_THROTTLE_MS)).toBe(true);
    expect(t.shouldWrite('u|d', 0, ACTIVITY_THROTTLE_MS + 1)).toBe(false);
  });

  it('treats a new day as a new key', () => {
    const t = new ActivityThrottle();
    t.shouldWrite('u|2026-10-01', 0, 0);
    expect(t.shouldWrite('u|2026-10-02', 0, 1)).toBe(true);
  });

  it('clears itself when full, and the cost is one extra write', () => {
    expect(ACTIVITY_THROTTLE_MAX_KEYS).toBe(5000);
    const t = new ActivityThrottle(ACTIVITY_THROTTLE_MS, 3);
    t.shouldWrite('a', 0, 0);
    t.shouldWrite('b', 0, 0);
    t.shouldWrite('c', 0, 0);
    expect(t.size).toBe(3);
    // A known key does not trigger the reset.
    expect(t.shouldWrite('a', 0, 1)).toBe(false);
    expect(t.size).toBe(3);
    // A fourth key clears the map, then is remembered alone.
    expect(t.shouldWrite('d', 0, 1)).toBe(true);
    expect(t.size).toBe(1);
    // `a` is forgotten, so it writes again.
    expect(t.shouldWrite('a', 0, 2)).toBe(true);
  });
});

describe('utcDay', () => {
  it('is the UTC date', () => {
    expect(utcDay(new Date('2026-10-02T23:59:59.000Z'))).toBe('2026-10-02');
    expect(utcDay(new Date('2026-10-03T00:00:00.000Z'))).toBe('2026-10-03');
  });
});

describe('upsertUserActivity', () => {
  const USER = 'user-1';
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  const rows = () => t.db.select().from(userActivityDaily);

  it('writes nothing when the profile does not exist', async () => {
    await upsertUserActivity(t.db, {
      userId: USER,
      role: 'reviewer',
      vendorId: null,
      at: new Date('2026-10-02T10:00:00.000Z'),
      surfaces: B.reviews,
    });
    expect(await rows()).toEqual([]);
  });

  it('inserts the first row, then ORs bits and advances last_seen_at only', async () => {
    await t.db.insert(profiles).values({ id: USER });
    await upsertUserActivity(t.db, {
      userId: USER,
      role: 'vendor_admin',
      vendorId: 'v1',
      at: new Date('2026-10-02T10:00:00.000Z'),
      surfaces: B.vendor_portal,
    });
    await upsertUserActivity(t.db, {
      userId: USER,
      role: 'admin',
      vendorId: 'v2',
      at: new Date('2026-10-02T11:00:00.000Z'),
      surfaces: B.account,
    });
    // An out-of-order older write never moves last_seen_at back.
    await upsertUserActivity(t.db, {
      userId: USER,
      role: 'admin',
      vendorId: null,
      at: new Date('2026-10-02T09:00:00.000Z'),
      surfaces: 0,
    });

    expect(await rows()).toEqual([
      {
        userId: USER,
        day: '2026-10-02',
        role: 'vendor_admin',
        vendorId: 'v1',
        firstSeenAt: '2026-10-02T10:00:00.000Z',
        lastSeenAt: '2026-10-02T11:00:00.000Z',
        surfaces: B.vendor_portal | B.account,
        arrivalUtmSource: null,
        arrivalUtmCampaign: null,
        arrivalNotificationId: null,
        arrivalAt: null,
      },
    ]);
  });

  it('keeps the first arrival group of the day and never mixes a later one in', async () => {
    await t.db.insert(profiles).values({ id: USER });
    await upsertUserActivity(t.db, {
      userId: USER,
      role: 'reviewer',
      vendorId: null,
      at: new Date('2026-10-02T10:00:00.000Z'),
      surfaces: 0,
      arrival: { utmSource: 'email', utmCampaign: null, notificationId: null },
    });
    await upsertUserActivity(t.db, {
      userId: USER,
      role: 'reviewer',
      vendorId: null,
      at: new Date('2026-10-02T10:05:00.000Z'),
      surfaces: 0,
      arrival: { utmSource: 'linkedin', utmCampaign: 'launch', notificationId: '9' },
    });
    // A plain request afterwards leaves the arrival alone too.
    await upsertUserActivity(t.db, {
      userId: USER,
      role: 'reviewer',
      vendorId: null,
      at: new Date('2026-10-02T10:10:00.000Z'),
      surfaces: B.reviews,
    });

    const [row] = await rows();
    expect(row).toMatchObject({
      arrivalUtmSource: 'email',
      arrivalUtmCampaign: null,
      arrivalNotificationId: null,
      arrivalAt: '2026-10-02T10:00:00.000Z',
      surfaces: B.reviews,
      lastSeenAt: '2026-10-02T10:10:00.000Z',
    });
  });

  it('fills the arrival on an existing row that has none', async () => {
    await t.db.insert(profiles).values({ id: USER });
    await upsertUserActivity(t.db, {
      userId: USER,
      role: 'reviewer',
      vendorId: null,
      at: new Date('2026-10-02T10:00:00.000Z'),
      surfaces: B.reviews,
    });
    await upsertUserActivity(t.db, {
      userId: USER,
      role: 'reviewer',
      vendorId: null,
      at: new Date('2026-10-02T10:01:00.000Z'),
      surfaces: 0,
      arrival: { utmSource: 'email', utmCampaign: 'seat_invite', notificationId: '42' },
    });
    const [row] = await rows();
    expect(row).toMatchObject({
      firstSeenAt: '2026-10-02T10:00:00.000Z',
      surfaces: B.reviews,
      arrivalUtmSource: 'email',
      arrivalUtmCampaign: 'seat_invite',
      arrivalNotificationId: '42',
      arrivalAt: '2026-10-02T10:01:00.000Z',
    });
  });

  it('writes a second row on the next UTC day', async () => {
    await t.db.insert(profiles).values({ id: USER });
    for (const at of ['2026-10-02T23:59:00.000Z', '2026-10-03T00:01:00.000Z']) {
      await upsertUserActivity(t.db, {
        userId: USER,
        role: 'reviewer',
        vendorId: null,
        at: new Date(at),
        surfaces: 0,
      });
    }
    expect((await rows()).map((r) => r.day)).toEqual(['2026-10-02', '2026-10-03']);
  });
});

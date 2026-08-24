/**
 * AECI-628 — `VendorPortalStore`, the shared owner of vendor-portal state.
 *
 * The load-bearing behaviour, in the order it matters:
 *
 *   1. The scope → endpoint map, INCLUDING the four-to-one collapse onto
 *      `GET /api/vendor/me`. A `revalidate` that fired four requests for one
 *      payload would quadruple the cost of the poll loop (AECI-629).
 *   2. In-flight coalescing: two overlapping revalidations of the same endpoint
 *      are one request.
 *   3. The rule that is easy to get wrong — a dirty section's local state
 *      survives a revalidation and a clean sibling's does not.
 *   4. Optimistic `apply()` and its two settlements, including the case where
 *      rolling back to the snapshot would silently undo somebody else's write.
 *
 * A `.component.spec.ts` because the store is DI-resolved (it injects
 * `VendorApi`), and the plain Vitest lane excludes that suffix.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorMeResponse } from '@aeci/shared';

import { VendorApi } from './vendor-api';
import {
  VENDOR_INTEGRATIONS_FIXTURE,
  VENDOR_ME_FIXTURE,
  VENDOR_NOTIFICATIONS_FIXTURE,
  VENDOR_SEATS_FIXTURE,
} from './vendor-fixtures';
import { VendorPortalStore } from './vendor-portal-store';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

/** A distinguishable second payload: same shape, different company name. */
function renamed(name: string): VendorMeResponse {
  return { ...VENDOR_ME_FIXTURE, vendor: { ...VENDOR_ME_FIXTURE.vendor, company_name: name } };
}

let api: {
  getMe: ReturnType<typeof vi.fn>;
  getIntegrations: ReturnType<typeof vi.fn>;
  getNotifications: ReturnType<typeof vi.fn>;
  getSeats: ReturnType<typeof vi.fn>;
};

function makeStore(): VendorPortalStore {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
    ],
  });
  return TestBed.inject(VendorPortalStore);
}

beforeEach(() => {
  api = {
    getMe: vi.fn().mockResolvedValue(VENDOR_ME_FIXTURE),
    getIntegrations: vi.fn().mockResolvedValue(VENDOR_INTEGRATIONS_FIXTURE),
    getNotifications: vi.fn().mockResolvedValue({ notifications: VENDOR_NOTIFICATIONS_FIXTURE }),
    getSeats: vi.fn().mockResolvedValue({ seats: VENDOR_SEATS_FIXTURE }),
  };
});
afterEach(() => vi.restoreAllMocks());

describe('VendorPortalStore — seeding', () => {
  it('takes the resolver payload without a fetch', () => {
    const store = makeStore();
    store.seed(VENDOR_ME_FIXTURE);

    // The payload is already in the SSR HTML; re-reading it would be a wasted
    // round trip on every portal load.
    expect(api.getMe).not.toHaveBeenCalled();
    expect(store.me()).toBe(VENDOR_ME_FIXTURE);
    expect(store.meStatus()).toBe('loaded');
  });

  it('ignores a re-seed of the identical payload', () => {
    const store = makeStore();
    store.seed(VENDOR_ME_FIXTURE);
    store.markDirty('profile');
    store.seed(VENDOR_ME_FIXTURE); // the resolver re-emitting on hydration
    expect(store.isDirty('profile')).toBe(true);
  });

  it('starts every lazy resource pending, so a section paints its loading state', () => {
    const store = makeStore();
    expect(store.seatsLoading()).toBe(true);
    expect(store.integrationsLoading()).toBe(true);
    expect(store.notificationsLoading()).toBe(true);
    expect(store.seatsFailed()).toBe(false);
  });
});

describe('VendorPortalStore — the refetch map', () => {
  it('collapses profile / entitlement / products / requests onto one GET /api/vendor/me', async () => {
    const store = makeStore();
    store.seed(VENDOR_ME_FIXTURE);

    await store.revalidate(['profile', 'entitlement', 'products', 'requests']);

    expect(api.getMe).toHaveBeenCalledTimes(1);
    expect(api.getIntegrations).not.toHaveBeenCalled();
    expect(api.getNotifications).not.toHaveBeenCalled();
  });

  it('routes each remaining scope to its own endpoint', async () => {
    const store = makeStore();
    store.seed(VENDOR_ME_FIXTURE);

    await store.revalidate(['integrations', 'notifications']);

    expect(api.getIntegrations).toHaveBeenCalledTimes(1);
    expect(api.getNotifications).toHaveBeenCalledTimes(1);
    expect(api.getMe).not.toHaveBeenCalled();
    expect(store.integrations()).toEqual(VENDOR_INTEGRATIONS_FIXTURE.integrations);
    expect(store.notifications()).toEqual(VENDOR_NOTIFICATIONS_FIXTURE);
  });

  it('coalesces two overlapping revalidations of the same endpoint into one request', async () => {
    const store = makeStore();
    store.seed(VENDOR_ME_FIXTURE);

    // Not awaited between: this is exactly the poll-fires-while-a-write-refresh-
    // is-in-flight case that would otherwise double every request.
    const first = store.revalidate(['profile']);
    const second = store.revalidate(['products']);
    await Promise.all([first, second]);

    expect(api.getMe).toHaveBeenCalledTimes(1);
  });

  it('lets a later revalidation run once the in-flight one has settled', async () => {
    const store = makeStore();
    store.seed(VENDOR_ME_FIXTURE);

    await store.revalidate(['profile']);
    await store.revalidate(['profile']);

    expect(api.getMe).toHaveBeenCalledTimes(2);
  });

  it('ensure() loads once and is free on re-entry', async () => {
    const store = makeStore();

    await store.ensure('seats');
    await store.ensure('seats');

    // A tab switch destroys and recreates the section; it must not re-request.
    expect(api.getSeats).toHaveBeenCalledTimes(1);
    expect(store.seats()).toEqual(VENDOR_SEATS_FIXTURE);
    expect(store.seatsLoading()).toBe(false);
  });

  it('keeps the last good value when a refresh fails', async () => {
    const store = makeStore();
    await store.ensure('integrations');
    api.getIntegrations.mockRejectedValueOnce(new Error('offline'));

    await store.revalidate(['integrations']);

    // A poll that empties the screen on one bad response is worse than a poll
    // that misses a beat.
    expect(store.integrationsFailed()).toBe(true);
    expect(store.integrations()).toEqual(VENDOR_INTEGRATIONS_FIXTURE.integrations);
  });

  it('reports a failure without ever rejecting', async () => {
    const store = makeStore();
    api.getSeats.mockRejectedValue(new Error('offline'));

    await expect(store.ensure('seats')).resolves.toBeUndefined();
    expect(store.seatsFailed()).toBe(true);
  });
});

describe('VendorPortalStore — never clobber an in-flight edit', () => {
  it('holds a dirty section’s value and applies a clean sibling’s', async () => {
    const store = makeStore();
    store.seed(VENDOR_ME_FIXTURE);
    await store.ensure('integrations');

    // The profile form has unsaved edits; the integrations tab has none.
    store.markDirty('profile');

    api.getMe.mockResolvedValue(renamed('Renamed By Someone Else'));
    api.getIntegrations.mockResolvedValue({ integrations: [] });
    await store.revalidate(['profile', 'integrations']);

    // Dirty: the payload was fetched but NOT applied.
    expect(api.getMe).toHaveBeenCalledTimes(1);
    expect(store.me()).toBe(VENDOR_ME_FIXTURE);
    // Clean sibling: replaced as normal.
    expect(store.integrations()).toEqual([]);
  });

  it('reports the dirty section as stale, and nothing else', async () => {
    const store = makeStore();
    store.seed(VENDOR_ME_FIXTURE);
    store.markDirty('profile');
    api.getMe.mockResolvedValue(renamed('Renamed'));

    await store.revalidate(['profile']);

    expect(store.isStale('profile')).toBe(true);
    expect([...store.staleSections()]).toEqual(['profile']);
    // `products` reads the same deferred payload, but its editor has nothing
    // unsaved, so offering IT a reload prompt would be noise.
    expect(store.isStale('products')).toBe(false);
  });

  it('reload() takes the stashed payload without a second request', async () => {
    const store = makeStore();
    store.seed(VENDOR_ME_FIXTURE);
    store.markDirty('profile');
    const fresh = renamed('Renamed');
    api.getMe.mockResolvedValue(fresh);
    await store.revalidate(['profile']);
    expect(api.getMe).toHaveBeenCalledTimes(1);

    await store.reload('profile');

    // The stash IS the fresh state, so re-requesting it would only add latency
    // and a second chance to fail.
    expect(api.getMe).toHaveBeenCalledTimes(1);
    expect(store.me()).toBe(fresh);
    expect(store.isDirty('profile')).toBe(false);
    expect(store.isStale('profile')).toBe(false);
  });

  it('reload() fetches when there is nothing stashed (the retry case)', async () => {
    const store = makeStore();
    api.getSeats.mockRejectedValueOnce(new Error('offline'));
    await store.ensure('seats');
    expect(store.seatsFailed()).toBe(true);

    await store.reload('seats');

    expect(api.getSeats).toHaveBeenCalledTimes(2);
    expect(store.seatsFailed()).toBe(false);
    expect(store.seats()).toEqual(VENDOR_SEATS_FIXTURE);
  });

  it('applies again as soon as the section stops being dirty', async () => {
    const store = makeStore();
    store.seed(VENDOR_ME_FIXTURE);
    store.markDirty('profile');
    api.getMe.mockResolvedValue(renamed('First'));
    await store.revalidate(['profile']);
    expect(store.me()).toBe(VENDOR_ME_FIXTURE);

    // The save landed, so the form withdraws its protection.
    store.clearDirty('profile');
    const second = renamed('Second');
    api.getMe.mockResolvedValue(second);
    await store.revalidate(['profile']);

    expect(store.me()).toBe(second);
    expect(store.isStale('profile')).toBe(false);
  });

  it('keeps one product form’s protection when a sibling clears its own', async () => {
    const store = makeStore();
    store.seed(VENDOR_ME_FIXTURE);
    store.markDirty('products', 'product-a');
    store.markDirty('products', 'product-b');

    // The clean sibling settles. A bare section-level flag would drop BOTH.
    store.clearDirty('products', 'product-b');
    api.getMe.mockResolvedValue(renamed('Renamed'));
    await store.revalidate(['products']);

    expect(store.me()).toBe(VENDOR_ME_FIXTURE);
    expect(store.isStale('products', 'product-a')).toBe(true);
    expect(store.isStale('products', 'product-b')).toBe(false);
  });
});

describe('VendorPortalStore — optimistic mutation', () => {
  it('applies a patch immediately and reconciles from the server echo', async () => {
    const store = makeStore();
    await store.ensure('integrations');
    const before = store.integrations();

    const mutation = store.apply('integrations', (list) => list.slice(1));
    expect(store.integrations()).toHaveLength(before.length - 1);

    mutation.reconcile(before);
    expect(store.integrations()).toBe(before);
  });

  it('rolls back to the exact prior value', async () => {
    const store = makeStore();
    await store.ensure('integrations');
    const before = store.integrations();

    const mutation = store.apply('integrations', () => []);
    expect(store.integrations()).toEqual([]);

    mutation.rollback();
    expect(store.integrations()).toBe(before);
  });

  it('settles once: a rollback after a reconcile is ignored', async () => {
    const store = makeStore();
    await store.ensure('integrations');
    const before = store.integrations();

    const mutation = store.apply('integrations', () => []);
    mutation.reconcile(before);
    mutation.rollback();

    expect(store.integrations()).toBe(before);
  });

  it('re-reads instead of unwinding when another write landed in between', async () => {
    const store = makeStore();
    await store.ensure('integrations');
    const first = store.apply('integrations', () => []);

    // A second write settles before the first one fails.
    store
      .apply('integrations', () => VENDOR_INTEGRATIONS_FIXTURE.integrations.slice(0, 1))
      .commit();

    first.rollback();
    await flush();

    // Restoring the snapshot here would silently undo the second write, so the
    // store asks the server instead of guessing.
    expect(api.getIntegrations).toHaveBeenCalledTimes(2);
  });

  it('commit() leaves the patch in place', async () => {
    const store = makeStore();
    await store.ensure('integrations');

    store.apply('integrations', () => []).commit();
    await flush();

    expect(store.integrations()).toEqual([]);
    expect(api.getIntegrations).toHaveBeenCalledTimes(1);
  });
});

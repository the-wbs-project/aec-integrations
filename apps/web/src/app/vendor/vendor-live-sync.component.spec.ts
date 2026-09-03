/**
 * AECI-629 — `VendorLiveSync`, the vendor portal's revalidation loop
 * (`docs/STAGE_2_REALTIME_SPEC.md` §4).
 *
 * What is actually load-bearing here, in the order it costs the most to get
 * wrong:
 *
 *   1. **The first response seeds the baseline and refetches nothing.** The page
 *      arrives with SSR-resolved data but no cursor, so a naive diff against an
 *      empty baseline would fire three refetches of on-screen data on every
 *      portal load, forever.
 *   2. **Only the scopes that moved are passed to `revalidate`** — and "moved"
 *      means `!==` in EITHER direction, so `null` → timestamp and timestamp →
 *      `null` both count. `null` is a steady state ("no rows of that kind"), not
 *      "unknown", and never means "unchanged".
 *   3. **A cursor is only "seen" once its refetch landed.** A moved scope whose
 *      refetch failed keeps its previous revision, so the next poll retries it.
 *      Advancing regardless would strand a section behind a retry button for as
 *      long as it takes that cursor to move again on its own — hours, on a
 *      surface whose whole promise is "you never have to reload". A section
 *      DEFERRED by unsaved edits is not a failure and must still advance.
 *   4. **Hidden is paused, with no timer at all.** A background tab left open
 *      overnight must cost nothing; a "slow" hidden interval would still be
 *      hundreds of requests nobody looks at.
 *   5. **Never two polls at once.** An event-triggered immediate poll while a
 *      request is outstanding must not start a second one, and must not lose the
 *      schedule either.
 *
 * The failure/deferral pair (3) is exercised against the REAL `VendorPortalStore`
 * as well as the stub, because it turns on that store's exact status semantics —
 * a stash is `loaded`, not `failed` — and a stub asserting my own reading of that
 * rule would prove nothing.
 *
 * A `.component.spec.ts` because the service is DI-resolved (`VendorApi`,
 * `VendorPortalStore`, `DOCUMENT`, `PLATFORM_ID`, `DestroyRef`) and the plain
 * Vitest lane excludes that suffix. `DOCUMENT` is a controllable stand-in rather
 * than the shared jsdom document, because visibility and focus are exactly what
 * this service switches on and both are awkward to drive on the real one.
 */
import { DOCUMENT } from '@angular/common';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorRevisions, VendorUpdatesResponse } from '@aeci/shared';

import { VendorApi } from './vendor-api';
import { VENDOR_ME_FIXTURE } from './vendor-fixtures';
import {
  VENDOR_SYNC_BACKOFF_CAP_MS,
  VENDOR_SYNC_FOCUSED_INTERVAL_MS,
  VENDOR_SYNC_UNFOCUSED_INTERVAL_MS,
  VendorLiveSync,
} from './vendor-live-sync';
import { VendorPortalStore, type VendorPortalResource } from './vendor-portal-store';

// ── Test doubles ───────────────────────────────────────────────────────────

type Listener = () => void;

/** Minimal `EventTarget` that lets a test fire an event and count what is still
 *  registered (which is how teardown is asserted). */
class FakeTarget {
  readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, cb: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(cb);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, cb: Listener): void {
    this.listeners.get(type)?.delete(cb);
  }

  fire(type: string): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
  }

  get registered(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

class FakeDocument extends FakeTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  focused = true;
  readonly defaultView = new FakeTarget();

  hasFocus(): boolean {
    return this.focused;
  }
}

const BASE_REVISIONS: VendorRevisions = {
  profile: '2026-08-19T06:11:02.000Z',
  entitlement: '2026-08-14T09:00:00.000Z',
  products: '2026-08-18T22:04:10.000Z',
  integrations: '2026-08-19T05:59:00.000Z',
  notifications: '2026-08-19T10:00:03.000Z',
  // A vendor with no requests: the steady-state `null` that must never read as
  // "changed" on its own.
  requests: null,
};

function updates(
  overrides: Partial<VendorRevisions> = {},
  serverTime = '2026-08-19T06:46:00.000Z',
): VendorUpdatesResponse {
  return { revisions: { ...BASE_REVISIONS, ...overrides }, server_time: serverTime };
}

let api: Record<
  'getUpdates' | 'getMe' | 'getIntegrations' | 'getNotifications' | 'getSeats',
  ReturnType<typeof vi.fn>
>;
let store: { revalidate: ReturnType<typeof vi.fn> };
/** Per-resource `failed` state the stub store reports back. */
let failed: Record<VendorPortalResource, boolean>;
let doc: FakeDocument;

function providers(platform: 'browser' | 'server' = 'browser') {
  return [
    { provide: PLATFORM_ID, useValue: platform },
    { provide: DOCUMENT, useValue: doc as unknown as Document },
    { provide: VendorApi, useValue: api as unknown as VendorApi },
  ];
}

function create(platform: 'browser' | 'server' = 'browser'): VendorLiveSync {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      ...providers(platform),
      { provide: VendorPortalStore, useValue: store as unknown as VendorPortalStore },
      VendorLiveSync,
    ],
  });
  return TestBed.inject(VendorLiveSync);
}

/** The same service over the REAL store, for the cases that turn on the store's
 *  own `failed`-vs-stashed semantics rather than on this spec's reading of them. */
function createWithRealStore(): { sync: VendorLiveSync; portal: VendorPortalStore } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [...providers(), VendorPortalStore, VendorLiveSync],
  });
  return { sync: TestBed.inject(VendorLiveSync), portal: TestBed.inject(VendorPortalStore) };
}

/** Advance fake time AND drain the microtask queue, so a resolved `getUpdates`
 *  runs its `then` before the assertion. `0` is "just settle the promises". */
const advance = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** Start and let the baseline-seeding poll settle. */
async function started(): Promise<VendorLiveSync> {
  const sync = create();
  sync.start();
  await advance();
  return sync;
}

beforeEach(() => {
  vi.useFakeTimers();
  doc = new FakeDocument();
  api = {
    getUpdates: vi.fn().mockResolvedValue(updates()),
    // Only reached through the real store; the stub store never fetches.
    getMe: vi.fn().mockResolvedValue(VENDOR_ME_FIXTURE),
    getIntegrations: vi.fn().mockResolvedValue({ integrations: [] }),
    getNotifications: vi.fn().mockResolvedValue({ notifications: [] }),
    getSeats: vi
      .fn()
      .mockResolvedValue({ seats: [], pending_invites: [], can_manage_seats: false }),
  };
  failed = { me: false, integrations: false, notifications: false, seats: false };
  store = {
    revalidate: vi.fn().mockResolvedValue(undefined),
    meFailed: () => failed.me,
    integrationsFailed: () => failed.integrations,
    notificationsFailed: () => failed.notifications,
    seatsFailed: () => failed.seats,
  } as unknown as { revalidate: ReturnType<typeof vi.fn> };
});

afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Baseline ───────────────────────────────────────────────────────────────

describe('VendorLiveSync — the baseline', () => {
  it('seeds the last-seen map on the first poll without revalidating anything', async () => {
    await started();

    // The page already renders the SSR-resolved payload; there is simply no
    // cursor in it. Diffing against an empty baseline would call every scope
    // "moved" and refetch the whole dashboard on every load.
    expect(api.getUpdates).toHaveBeenCalledTimes(1);
    expect(store.revalidate).not.toHaveBeenCalled();
  });

  it('records the SERVER clock, not the browser clock', async () => {
    const sync = create();
    sync.start();
    await advance();

    expect(sync.lastCheckedAt()).toBe('2026-08-19T06:46:00.000Z');
  });

  it('does not poll, listen, or schedule on the server', async () => {
    const sync = create('server');
    sync.start();
    await advance(10 * 60_000);

    expect(api.getUpdates).not.toHaveBeenCalled();
    expect(doc.registered).toBe(0);
    expect(doc.defaultView.registered).toBe(0);
  });

  it('is idempotent — a second start() does not double the loop', async () => {
    const sync = await started();
    sync.start();
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);

    // One tick, one request — not two loops racing on the same cadence.
    expect(api.getUpdates).toHaveBeenCalledTimes(2);
  });
});

// ── The diff ───────────────────────────────────────────────────────────────

describe('VendorLiveSync — the diff', () => {
  it('does not call revalidate when no scope moved', async () => {
    await started();
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);

    expect(api.getUpdates).toHaveBeenCalledTimes(2);
    expect(store.revalidate).not.toHaveBeenCalled();
  });

  it('passes only the scopes that moved', async () => {
    await started();
    api.getUpdates.mockResolvedValue(
      updates({ products: '2026-08-19T07:00:00.000Z', notifications: '2026-08-19T07:01:00.000Z' }),
    );
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);

    // The store dedupes `products` onto `GET /api/vendor/me`; what matters here
    // is that the four untouched scopes are not in the list at all.
    expect(store.revalidate).toHaveBeenCalledTimes(1);
    expect(store.revalidate).toHaveBeenCalledWith(['products', 'notifications']);
  });

  it('treats null → timestamp as moved', async () => {
    await started();
    api.getUpdates.mockResolvedValue(updates({ requests: '2026-08-19T07:00:00.000Z' }));
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);

    expect(store.revalidate).toHaveBeenCalledWith(['requests']);
  });

  it('treats timestamp → null as moved', async () => {
    await started();
    // The 90-day notification window rolling past the last row is exactly this:
    // a real cursor that goes back to `null`.
    api.getUpdates.mockResolvedValue(updates({ notifications: null }));
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);

    expect(store.revalidate).toHaveBeenCalledWith(['notifications']);
  });

  it('does not re-report a scope whose refetch landed', async () => {
    await started();
    api.getUpdates.mockResolvedValue(updates({ profile: '2026-08-19T07:00:00.000Z' }));
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(store.revalidate).toHaveBeenCalledTimes(1);

    // Same cursor on the next tick: the baseline advanced, so nothing moved.
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(store.revalidate).toHaveBeenCalledTimes(1);
  });
});

// ── Holding the cursor back for a refetch that did not land ────────────────

describe('VendorLiveSync — a cursor is seen only once its refetch landed', () => {
  it('re-reports a moved scope whose refetch failed, and stops once it lands', async () => {
    await started();
    api.getUpdates.mockResolvedValue(updates({ integrations: '2026-08-19T08:00:00.000Z' }));
    failed.integrations = true;

    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(store.revalidate).toHaveBeenNthCalledWith(1, ['integrations']);

    // The cursor read succeeded; the refetch did not. Recording the cursor as
    // seen would leave the tab stale behind a retry button until that cursor
    // moved again on its own — which can be hours.
    failed.integrations = false;
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(store.revalidate).toHaveBeenNthCalledWith(2, ['integrations']);

    // Now it landed, so the retry stops: no extra retry machinery, just the
    // baseline finally advancing.
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(store.revalidate).toHaveBeenCalledTimes(2);
  });

  it('advances the scope that landed and holds only the one that did not', async () => {
    await started();
    api.getUpdates.mockResolvedValue(
      updates({
        integrations: '2026-08-19T08:00:00.000Z',
        notifications: '2026-08-19T08:01:00.000Z',
      }),
    );
    failed.notifications = true;

    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(store.revalidate).toHaveBeenNthCalledWith(1, ['integrations', 'notifications']);

    // One failing endpoint must not pin the cursor of a healthy one.
    failed.notifications = false;
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(store.revalidate).toHaveBeenNthCalledWith(2, ['notifications']);
  });

  it('ignores a `failed` resource that this poll never asked to refresh', async () => {
    await started();
    // `me` has been failing since before this tick, but only `integrations`
    // moved — holding `profile`/`products` back here would re-report scopes
    // whose cursors never changed.
    failed.me = true;
    api.getUpdates.mockResolvedValue(updates({ integrations: '2026-08-19T08:00:00.000Z' }));

    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(store.revalidate).toHaveBeenCalledTimes(1);
  });

  it('retries against the REAL store when the refetch endpoint is down', async () => {
    const { sync, portal } = createWithRealStore();
    sync.start();
    await advance();

    api.getIntegrations.mockRejectedValueOnce(new Error('502'));
    api.getUpdates.mockResolvedValue(updates({ integrations: '2026-08-19T08:00:00.000Z' }));

    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(api.getIntegrations).toHaveBeenCalledTimes(1);
    expect(portal.integrationsFailed()).toBe(true);

    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(api.getIntegrations).toHaveBeenCalledTimes(2);
    expect(portal.integrationsFailed()).toBe(false);
  });

  it('does NOT hold the cursor back for a section deferred by unsaved edits', async () => {
    const { sync, portal } = createWithRealStore();
    sync.start();
    await advance();

    portal.markDirty('integrations');
    api.getUpdates.mockResolvedValue(updates({ integrations: '2026-08-19T08:00:00.000Z' }));
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);

    // The payload arrived and was STASHED on purpose, with a reload affordance:
    // `loaded`, not `failed`. Treating that as a failure would let a half-typed
    // form pin the cursor and refetch the same body every 20 s until it is saved.
    expect(api.getIntegrations).toHaveBeenCalledTimes(1);
    expect(portal.integrationsFailed()).toBe(false);
    expect(portal.isStale('integrations')).toBe(true);

    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(api.getIntegrations).toHaveBeenCalledTimes(1);
  });
});

// ── Cadence ────────────────────────────────────────────────────────────────

describe('VendorLiveSync — cadence', () => {
  it('polls every 20 s while visible and focused', async () => {
    await started();

    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS - 1);
    expect(api.getUpdates).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(api.getUpdates).toHaveBeenCalledTimes(2);
  });

  it('polls every 60 s while visible but unfocused', async () => {
    doc.focused = false;
    await started();

    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(api.getUpdates).toHaveBeenCalledTimes(1);

    await advance(VENDOR_SYNC_UNFOCUSED_INTERVAL_MS - VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(api.getUpdates).toHaveBeenCalledTimes(2);
  });

  it('re-derives the cadence when focus changes, without polling', async () => {
    doc.focused = false;
    await started();

    doc.focused = true;
    doc.defaultView.fire('focus');
    // Refocusing a tab that was visible all along has made nothing staler, so
    // it re-arms at 20 s rather than firing a request.
    expect(api.getUpdates).toHaveBeenCalledTimes(1);

    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(api.getUpdates).toHaveBeenCalledTimes(2);
  });

  it('leaves NO timer while hidden', async () => {
    await started();

    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');

    // Paused, not slowed: the assertion is the absence of a timer, because a
    // long interval would still cost hundreds of requests overnight.
    expect(vi.getTimerCount()).toBe(0);

    await advance(10 * 60_000);
    expect(api.getUpdates).toHaveBeenCalledTimes(1);
  });

  it('polls immediately when the tab becomes visible again', async () => {
    await started();
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');

    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    await advance();

    // One round trip makes the resumed tab correct, which is why hidden can be
    // paused outright rather than merely slowed.
    expect(api.getUpdates).toHaveBeenCalledTimes(2);
  });

  it('polls immediately when connectivity returns', async () => {
    await started();

    doc.defaultView.fire('online');
    await advance();

    expect(api.getUpdates).toHaveBeenCalledTimes(2);
  });

  it('ignores `online` while hidden', async () => {
    await started();
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');

    // A flapping connection fires `online` repeatedly; answering each one on a
    // hidden tab would be the overnight cost the pause exists to remove. The tab
    // polls immediately on becoming visible anyway.
    doc.defaultView.fire('online');
    await advance();

    expect(api.getUpdates).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── Backoff ────────────────────────────────────────────────────────────────

describe('VendorLiveSync — error backoff', () => {
  it('grows 20 → 40 → 80 → 160 s and caps', async () => {
    api.getUpdates.mockRejectedValue(new Error('offline'));
    await started();
    expect(api.getUpdates).toHaveBeenCalledTimes(1);

    for (const [step, delay] of [20_000, 40_000, 80_000, 160_000, 160_000].entries()) {
      await advance(delay - 1);
      expect(api.getUpdates).toHaveBeenCalledTimes(step + 1);
      await advance(1);
      expect(api.getUpdates).toHaveBeenCalledTimes(step + 2);
    }

    expect(VENDOR_SYNC_BACKOFF_CAP_MS).toBe(160_000);
  });

  it('keeps the baseline across a failure, so the next success still diffs', async () => {
    await started();

    api.getUpdates.mockRejectedValueOnce(new Error('502'));
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(store.revalidate).not.toHaveBeenCalled();

    // A failed cursor read says nothing about freshness; it must not be mistaken
    // for a fresh baseline, or the change it straddled would be lost.
    api.getUpdates.mockResolvedValue(updates({ integrations: '2026-08-19T08:00:00.000Z' }));
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(store.revalidate).toHaveBeenCalledWith(['integrations']);
  });

  it('resets to the base cadence on the first success', async () => {
    api.getUpdates.mockRejectedValue(new Error('offline'));
    await started();

    await advance(20_000); // failure 2
    await advance(40_000); // failure 3 — next delay would be 80 s
    expect(api.getUpdates).toHaveBeenCalledTimes(3);

    api.getUpdates.mockResolvedValue(updates());
    await advance(80_000);
    expect(api.getUpdates).toHaveBeenCalledTimes(4);

    // Back to 20 s, not still 160 s.
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(api.getUpdates).toHaveBeenCalledTimes(5);
  });
});

// ── Overlap + teardown ─────────────────────────────────────────────────────

describe('VendorLiveSync — overlap and teardown', () => {
  it('never runs two polls at once, and resumes the cadence after the first settles', async () => {
    let release!: (value: VendorUpdatesResponse) => void;
    api.getUpdates.mockReturnValue(
      new Promise<VendorUpdatesResponse>((resolve) => {
        release = resolve;
      }),
    );

    const sync = create();
    sync.start();
    await advance();
    expect(api.getUpdates).toHaveBeenCalledTimes(1);

    // Three immediate-poll triggers while the first request is still open.
    doc.defaultView.fire('online');
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    doc.defaultView.fire('online');
    await advance();
    expect(api.getUpdates).toHaveBeenCalledTimes(1);

    api.getUpdates.mockResolvedValue(updates());
    release(updates());
    await advance();
    expect(api.getUpdates).toHaveBeenCalledTimes(1);

    // The suppressed triggers must not have swallowed the schedule.
    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(api.getUpdates).toHaveBeenCalledTimes(2);
  });

  it('holds the no-overlap guarantee across the awaited revalidate', async () => {
    await started();

    let releaseRefetch!: () => void;
    store.revalidate.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseRefetch = () => resolve();
      }),
    );
    api.getUpdates.mockResolvedValue(updates({ products: '2026-08-19T08:00:00.000Z' }));

    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(api.getUpdates).toHaveBeenCalledTimes(2);

    // The cursor read is done but the refetch is still open, which is the window
    // the awaited `revalidate` added. Nothing may start a second poll in it, and
    // no timer may be armed inside it either.
    doc.defaultView.fire('online');
    doc.fire('visibilitychange');
    expect(vi.getTimerCount()).toBe(0);
    await advance(3 * VENDOR_SYNC_UNFOCUSED_INTERVAL_MS);
    expect(api.getUpdates).toHaveBeenCalledTimes(2);

    store.revalidate.mockResolvedValue(undefined);
    releaseRefetch();
    await advance();
    expect(api.getUpdates).toHaveBeenCalledTimes(2);

    await advance(VENDOR_SYNC_FOCUSED_INTERVAL_MS);
    expect(api.getUpdates).toHaveBeenCalledTimes(3);
  });

  it('stops polling and releases every listener on destroy', async () => {
    await started();
    expect(doc.registered).toBeGreaterThan(0);
    expect(doc.defaultView.registered).toBeGreaterThan(0);

    TestBed.resetTestingModule(); // destroys the injector → DestroyRef.onDestroy

    expect(doc.registered).toBe(0);
    expect(doc.defaultView.registered).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    await advance(10 * 60_000);
    expect(api.getUpdates).toHaveBeenCalledTimes(1);
  });

  it('stop() is idempotent and survives a late event', async () => {
    const sync = await started();
    sync.stop();
    sync.stop();

    doc.defaultView.fire('online');
    await advance(10 * 60_000);
    expect(api.getUpdates).toHaveBeenCalledTimes(1);
  });
});

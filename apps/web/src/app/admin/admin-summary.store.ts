import { Injectable, Signal, computed, signal } from '@angular/core';

/** The Operations queues the console badges, and the key each badge is wired to
 *  in `admin-nav.ts`. Named rather than indexed so a nav entry declares WHICH
 *  queue it counts instead of inheriting the one global number. */
export type AdminQueueKey = 'reviews' | 'requests' | 'claims' | 'contests' | 'reindex';

/** Every key, in nav order. Iterated by the group total, so a fifth queue is one
 *  entry here plus one in `admin-nav.ts`. */
export const ADMIN_QUEUE_KEYS: readonly AdminQueueKey[] = [
  'reviews',
  'requests',
  'claims',
  'contests',
  'reindex',
];

/** A seed payload. Keys are optional and `undefined` is IGNORED rather than
 *  treated as zero — see `seed()`. */
export type AdminQueueSeed = Partial<Record<AdminQueueKey, number | null | undefined>>;

/**
 * Shared, app-wide store for the admin console's queue counts (AECI-205 / Phase
 * 5.14; widened from one count to three by AECI-922). It exists so the **badges**
 * rendered by `AdminShell` (the layout) and by the header account menu, and the
 * **moderation actions** taken in the three queue screens (the child routes), all
 * agree on one live set of numbers:
 *
 *   - `AdminShell` seeds it from the `adminSummaryResolver` value on entry, and
 *     `AdminStatus` seeds it from the header's `GET /api/account` probe.
 *   - `ReviewQueue`, `RequestQueue` and `ClaimQueue` call `decrement(key)` after
 *     each successful action, so the badge ticks down immediately without a
 *     round-trip ("the pending-count badge updates after an action" — §22.1 /
 *     AECI-205 AC).
 *
 * ── THE TOTAL IS A SUM, AND THE SETS ARE DISJOINT ───────────────────────────
 * `operationsTotal()` adds every key, which is only honest because the server
 * counts corrections and claims separately over one table
 * (`apps/api/src/lib/admin-queue-counts.ts`). If `pending_requests` ever went
 * back to counting all `vendor_requests` kinds, this total would double every
 * open claim, and nothing here would notice. AECI-946's `reindex` is a fourth
 * key over a different table entirely (`gsc_recrawl_queue`), so it cannot
 * overlap the other three by construction. AECI-1008's `contests` is a fifth, on
 * `integration_field_challenges`, disjoint for the same reason.
 *
 * `providedIn: 'root'` → one instance, shared across the header, the layout and
 * its outlet. A fresh full navigation to `/admin` re-runs the resolver and
 * re-seeds from the server, so the counts self-heal if they ever drift.
 */
@Injectable({ providedIn: 'root' })
export class AdminSummaryStore {
  /** Null until seeded (e.g. a non-admin never reaches the seed). Null and 0 are
   *  different facts: null is "we do not know", 0 is "the queue is empty". */
  private readonly counts: Readonly<
    Record<AdminQueueKey, ReturnType<typeof signal<number | null>>>
  > = {
    reviews: signal<number | null>(null),
    requests: signal<number | null>(null),
    claims: signal<number | null>(null),
    contests: signal<number | null>(null),
    reindex: signal<number | null>(null),
  };

  /** Live pending-review count for the nav badge. */
  readonly pendingReviews = this.counts.reviews.asReadonly();
  /** Live open-correction-request count (claims are counted separately). */
  readonly pendingRequests = this.counts.requests.asReadonly();
  /** Live open-vendor-claim count. */
  readonly pendingClaims = this.counts.claims.asReadonly();
  /** Live count of open integration field contests routed to AECi (AECI-1008). */
  readonly pendingContests = this.counts.contests.asReadonly();
  /** Live count of URLs awaiting a manual Google Request Indexing (AECI-946).
   *  Needs no predicate: Done deletes the row, so every row is pending. */
  readonly pendingReindex = this.counts.reindex.asReadonly();

  /**
   * What the Operations category badges, and what the header account menu badges:
   * the whole operator backlog as one number. Nulls read as 0, so a partially
   * seeded store (an older API shape during a rolling deploy) shows the counts it
   * does know rather than nothing at all.
   */
  readonly operationsTotal = computed(() =>
    ADMIN_QUEUE_KEYS.reduce((sum, key) => sum + (this.counts[key]() ?? 0), 0),
  );

  /** One queue's live count, by key — how a nav entry reads the number it
   *  declared. */
  count(key: AdminQueueKey): Signal<number | null> {
    return this.counts[key].asReadonly();
  }

  /**
   * Seed (or re-seed) from the authoritative server counts.
   *
   * An ABSENT or `undefined` key is left alone rather than zeroed. The SSR and
   * API Workers deploy separately, so during a rolling deploy an older
   * `/api/account` shape can arrive carrying `pending_reviews` and nothing else —
   * zeroing the other two there would silently empty the badge. An explicit
   * `null` DOES clear, because that is the server saying "you are not an
   * operator".
   */
  seed(counts: AdminQueueSeed): void {
    for (const key of ADMIN_QUEUE_KEYS) {
      if (!(key in counts)) continue;
      const value = counts[key];
      if (value === undefined) continue;
      this.counts[key].set(value === null ? null : Math.max(0, value));
    }
  }

  /** Tick one queue down by one after a successful action (never below 0, and
   *  never turning an unseeded null into a number). */
  decrement(key: AdminQueueKey): void {
    this.counts[key].update((n) => (n === null ? n : Math.max(0, n - 1)));
  }
}

import { Injectable, signal } from '@angular/core';

/**
 * Shared, app-wide store for the admin pending-review count (AECI-205 / Phase
 * 5.14). It exists so the **badge** rendered by `AdminShell` (the layout) and
 * the **moderation actions** taken in `ReviewQueue` (the child route) agree on a
 * single live number:
 *
 *   - `AdminShell` seeds it from the `adminSummaryResolver` value on entry.
 *   - `ReviewQueue` calls `decrement()` after each successful approve/reject, so
 *     the badge ticks down immediately without a round-trip ("the pending-count
 *     badge updates after an action" — §22.1 / AECI-205 AC).
 *
 * `providedIn: 'root'` → one instance, shared across the layout and its outlet.
 * A fresh full navigation to `/admin` re-runs the resolver and re-seeds from the
 * server, so the count self-heals if it ever drifts.
 */
@Injectable({ providedIn: 'root' })
export class AdminSummaryStore {
  /** Null until seeded (e.g. a non-admin never reaches the seed). */
  private readonly _pendingReviews = signal<number | null>(null);

  /** Live pending-review count for the nav badge. */
  readonly pendingReviews = this._pendingReviews.asReadonly();

  /** Seed (or re-seed) from the authoritative server count. */
  seed(count: number): void {
    this._pendingReviews.set(Math.max(0, count));
  }

  /** Tick down by one after a successful moderation action (never below 0). */
  decrement(): void {
    this._pendingReviews.update((n) => (n === null ? n : Math.max(0, n - 1)));
  }
}

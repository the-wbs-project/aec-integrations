/**
 * `VendorLiveSync` (AECI-629 / RT-4) — the revalidation loop that makes the
 * vendor portal live, per `docs/STAGE_2_REALTIME_SPEC.md` §4.
 *
 * It polls `GET /api/vendor/updates` (AECI-627), diffs the six per-scope
 * revisions against the last-seen map, and calls
 * {@link VendorPortalStore.revalidate} with **only** the scopes that moved. That
 * is the whole of the transport: ADR 0023 chose scoped client revalidation over
 * a Durable-Object socket because no event that changes a vendor's portal state
 * is sub-second (two of the six producers are once-a-day crons), and the one
 * event with a real deadline — the concierge entitlement flip, where an admin is
 * often on the phone with the vendor — needs about a minute, not about a frame.
 *
 * ── THE DIFF RULE, WHICH IS EASY TO GET WRONG (§2.1) ────────────────────────
 * Every revision is an ISO-8601 string **or `null`**, and `null` is a legitimate
 * steady state — "this vendor has no rows of that kind at all" (a vendor with no
 * requests keeps `requests: null` forever). It is NOT "unknown" and must never be
 * read as "unchanged". A scope is stale when its value **differs** from last-seen
 * in either direction, `null` → timestamp and timestamp → `null` included.
 *
 * The comparison is `!==` on the raw strings, never `Date.parse`. SQLite's
 * `MAX()` over a TEXT column is lexicographic and every `*_at` column is an ISO
 * UTC string, so lexicographic and chronological order coincide; string equality
 * also means a value the server can produce but `Date.parse` mangles can never be
 * mistaken for "unchanged".
 *
 * ── CLOCKS ──────────────────────────────────────────────────────────────────
 * Nothing here does arithmetic between a server timestamp and `Date.now()`. The
 * two clocks are not the same clock and the skew is unbounded, which is exactly
 * why the response carries `server_time`: {@link lastCheckedAt} reports the
 * SERVER's instant of the last successful read, for logging and a "last checked"
 * affordance. Scheduling uses relative `setTimeout` delays only, so it never
 * needs a wall clock at all.
 *
 * ── WHY THE FIRST RESPONSE CANNOT REVALIDATE ────────────────────────────────
 * The page loads from the SSR-resolved `me` payload (`vendorMeResolver`), so the
 * store already holds data — but there is no cursor in that payload, and the
 * endpoint keeps no per-client state to derive one from. So the first poll
 * **seeds** the baseline: it records the revisions and refetches nothing. Diffing
 * against an empty baseline would treat all six scopes as moved and fire three
 * refetches of data that is already on screen, on every single portal load.
 *
 * ── A CURSOR IS "SEEN" ONLY ONCE ITS REFETCH LANDED ─────────────────────────
 * Advancing the baseline on the strength of the cursor read alone is the subtle
 * way this loop stops being live. `revalidate` never rejects — a failed refetch
 * marks that resource `failed` in the store and leaves the last good value on
 * screen — so a baseline that advanced regardless would mean the loop never
 * looks at that scope again. One transient 5xx on `GET /api/vendor/integrations`
 * would strand the integrations tab behind a retry button until that cursor
 * happens to move on its own, which can be hours. On a surface whose whole
 * promise is "you never have to reload", that is the failure this epic exists to
 * remove. A successful cursor read proves the CURSOR is fresh; it says nothing
 * about whether what it pointed at was successfully applied.
 *
 * So the baseline is settled **per scope, after the refetch**: a moved scope
 * whose backing resource came back `failed` keeps its PREVIOUS revision, so the
 * next poll re-detects it as moved and retries. The existing cadence and backoff
 * carry the retry rate — there is no second retry mechanism to keep in sync.
 * Scopes whose refetch landed advance normally, so one failing endpoint never
 * holds another one back.
 *
 * **A deferred scope is not a failed one.** When a section holds unsaved edits
 * the store STASHES the fresh payload deliberately, reports `loaded`, and offers
 * the vendor an explicit "reload this section". Treating that as a failure would
 * let a half-typed form pin the cursor and refetch the same payload forever.
 * Reading `failed` (not "did the value change") is what keeps the two apart.
 *
 * ── LIFECYCLE (§4.2) ────────────────────────────────────────────────────────
 * Browser only. {@link start} is called from `afterNextRender` in
 * `vendor-page.ts` on the success path only (never on the `me === null` / 404
 * branch), and teardown runs through `DestroyRef`. Nothing touches `window` or
 * `document` at construction — the DOM is reached through the `DOCUMENT` token,
 * and only from `start()` onward.
 *
 * Provided by `VendorPage` alongside {@link VendorPortalStore}, not
 * `providedIn: 'root'`: the store is surface-scoped (so the preview's
 * `PreviewVendorApi` shadow is honoured), so a root-provided sync could not
 * resolve it.
 */
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { DestroyRef, Injectable, PLATFORM_ID, inject, signal, type Signal } from '@angular/core';

import { VENDOR_PORTAL_SCOPES, type VendorPortalScope, type VendorRevisions } from '@aeci/shared';

import { VendorApi } from './vendor-api';
import { VendorPortalStore, type VendorPortalResource } from './vendor-portal-store';

/**
 * Scope → the store resource whose refetch answers it, which is what turns "this
 * resource is `failed`" into "these scopes must not advance".
 *
 * A deliberate mirror of the store's own `SCOPE_RESOURCE`, which is module-
 * private there — copying six entries is the cheaper of the two options against
 * widening the store's public surface while other work is in it. It is typed
 * against the store's EXPORTED {@link VendorPortalResource}, so renaming a
 * resource breaks this file at compile time rather than silently mapping a scope
 * onto a status nobody sets. The four-to-one collapse onto `me` is the same
 * dedupe `revalidate` applies (`STAGE_2_REALTIME_SPEC.md` §2.3).
 */
const SCOPE_RESOURCE: Readonly<Record<VendorPortalScope, VendorPortalResource>> = {
  profile: 'me',
  entitlement: 'me',
  products: 'me',
  requests: 'me',
  integrations: 'integrations',
  notifications: 'notifications',
};

/**
 * Poll interval while the tab is visible **and** focused — the vendor is looking
 * at the portal right now, so this is the number that decides how fast a change
 * someone else made shows up.
 *
 * A launch tunable (`docs/POST_LAUNCH_MONITORING.md` §3). The retune signal is
 * the `aeci.api.vendor.updates{changed:none}` ratio: a high `none` share means
 * the cadence outruns how often the portal actually changes, so **lengthen this
 * first**. A high `some` share is the opposite finding and is ADR 0023's third
 * re-open condition, not a reason to poll harder.
 */
export const VENDOR_SYNC_FOCUSED_INTERVAL_MS = 20_000;

/**
 * Poll interval while the tab is visible but the window is not focused (a second
 * monitor, a split screen). Still live, three times cheaper: the vendor can see
 * the surface but is demonstrably not driving it.
 *
 * A launch tunable (`docs/POST_LAUNCH_MONITORING.md` §3).
 */
export const VENDOR_SYNC_UNFOCUSED_INTERVAL_MS = 60_000;

/**
 * First delay after a failed poll, then doubled per consecutive failure up to
 * {@link VENDOR_SYNC_BACKOFF_CAP_MS} — 20 → 40 → 80 → 160 s. Reset to the base
 * cadence on the first success.
 *
 * A launch tunable (`docs/POST_LAUNCH_MONITORING.md` §3).
 */
export const VENDOR_SYNC_BACKOFF_BASE_MS = 20_000;

/**
 * Ceiling of the error backoff. Sized so a portal left open through an API
 * outage settles at roughly one request every three minutes instead of
 * compounding indefinitely, and still recovers on its own when the API returns
 * without the vendor reloading.
 *
 * A launch tunable (`docs/POST_LAUNCH_MONITORING.md` §3). Raise it only if an
 * outage's tail traffic is itself the problem; lowering it trades recovery
 * latency for load during exactly the window the API is already unwell.
 */
export const VENDOR_SYNC_BACKOFF_CAP_MS = 160_000;

// Intentionally NOT `providedIn: 'root'`: it injects the surface-scoped
// `VendorPortalStore`, which a root-provided service could not resolve. See the
// header.
// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- surface-scoped, alongside VendorPortalStore
@Injectable()
export class VendorLiveSync {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly checkedAt = signal<string | null>(null);

  /**
   * The `server_time` of the last successful poll — the SERVER's clock, never
   * the browser's. Advisory: for logging and a "last checked" affordance, never
   * an input to scheduling.
   */
  readonly lastCheckedAt: Signal<string | null> = this.checkedAt.asReadonly();

  /** The baseline. `null` until the first response lands, which is what makes
   *  that response a seed rather than a six-scope diff. */
  private lastSeen: VendorRevisions | null = null;

  /** Consecutive failures, driving the backoff. Reset to 0 on any success. */
  private failures = 0;

  private timer: ReturnType<typeof setTimeout> | null = null;

  /** One poll at a time, always. A timer that fires while a request is still
   *  outstanding must not start a second one. */
  private inFlight = false;

  private started = false;
  private stopped = false;

  /**
   * Begin polling. Idempotent, and a no-op on the server.
   *
   * Polls **immediately** so the baseline is established at portal load rather
   * than one interval later — that first response refetches nothing, so waiting
   * would only delay the first real revalidation by a whole interval.
   */
  start(): void {
    if (this.started || this.stopped || !this.isBrowser) return;
    this.started = true;

    const view = this.document.defaultView;
    this.document.addEventListener('visibilitychange', this.onVisibilityChange);
    view?.addEventListener('focus', this.onFocusChange);
    view?.addEventListener('blur', this.onFocusChange);
    view?.addEventListener('online', this.onOnline);

    this.destroyRef.onDestroy(() => this.stop());

    void this.poll();
  }

  /** Stop polling and release every listener. Idempotent; also wired to
   *  `DestroyRef` so a navigation away from `/vendor` cannot leave a timer or a
   *  listener behind. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimer();

    const view = this.document.defaultView;
    this.document.removeEventListener('visibilitychange', this.onVisibilityChange);
    view?.removeEventListener('focus', this.onFocusChange);
    view?.removeEventListener('blur', this.onFocusChange);
    view?.removeEventListener('online', this.onOnline);
  }

  // ── Events ───────────────────────────────────────────────────────────────

  /**
   * Hidden is **paused**, not slowed (§4.1): the timer is dropped entirely, so a
   * background tab left open overnight costs nothing at all. Becoming visible
   * polls immediately, which is what makes the resumed tab correct in one round
   * trip rather than needing a shorter hidden interval.
   */
  private readonly onVisibilityChange = (): void => {
    if (this.isHidden()) {
      this.clearTimer();
      return;
    }
    void this.poll();
  };

  /**
   * Focus and blur only change the cadence, so they reschedule rather than poll
   * — refocusing a window whose tab was visible the whole time has not made
   * anything staler than it already was.
   */
  private readonly onFocusChange = (): void => {
    if (!this.inFlight) this.schedule();
  };

  /**
   * Connectivity returning is the one moment the cursor is most likely to have
   * moved, so poll now instead of waiting out the backoff.
   *
   * Gated on visibility for the same reason `hidden` has no timer: a flapping
   * connection fires `online` repeatedly, and a hidden tab that answered every
   * one of them would be the overnight cost the pause exists to remove. The tab
   * polls immediately when it becomes visible anyway.
   */
  private readonly onOnline = (): void => {
    if (this.isHidden()) return;
    void this.poll();
  };

  // ── The loop ─────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    // Whatever was scheduled is superseded by this run; the `finally` below
    // schedules the next one. Doing it here (rather than only in `schedule`)
    // keeps an event-triggered immediate poll from leaving its old timer armed.
    this.clearTimer();

    try {
      const response = await this.api.getUpdates();
      this.checkedAt.set(response.server_time);
      this.failures = 0;

      const previous = this.lastSeen;
      // The first response has no baseline to differ from: seed it and refetch
      // nothing. See the header.
      if (previous === null) {
        this.lastSeen = response.revisions;
        return;
      }

      const moved = this.diff(previous, response.revisions);
      if (moved.length === 0) {
        this.lastSeen = response.revisions;
        return;
      }

      // `revalidate` dedupes the four `me` scopes into one call and never
      // rejects — a failed refetch marks that resource `failed` in the store and
      // leaves the last good value on screen. AWAITED, because which scopes may
      // be recorded as seen is not knowable until it settles.
      await this.store.revalidate(moved);
      this.lastSeen = this.settle(previous, response.revisions, moved);
    } catch {
      // A cursor read that fails tells us nothing about freshness, so the
      // baseline is left exactly as it was and the next success diffs against
      // it. Backing off is the whole response.
      this.failures += 1;
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }

  /** The scopes whose revision differs from the baseline. */
  private diff(previous: VendorRevisions, next: VendorRevisions): readonly VendorPortalScope[] {
    // `!==` in either direction, so `null` → timestamp and timestamp → `null`
    // both count. Compared as strings; never parsed as dates.
    return VENDOR_PORTAL_SCOPES.filter((scope) => next[scope] !== previous[scope]);
  }

  /**
   * The new baseline, holding back any moved scope whose refetch did not land.
   *
   * Only the scopes that actually moved are considered: a resource left `failed`
   * by some earlier, unrelated read must not pin a cursor that this poll never
   * asked it to refresh.
   */
  private settle(
    previous: VendorRevisions,
    next: VendorRevisions,
    moved: readonly VendorPortalScope[],
  ): VendorRevisions {
    const settled: VendorRevisions = { ...next };
    for (const scope of moved) {
      // `failed` only — a payload the store STASHED behind a dirty section is
      // `loaded`, and holding its cursor back would refetch it forever.
      if (this.hasFailed(SCOPE_RESOURCE[scope])) settled[scope] = previous[scope];
    }
    return settled;
  }

  /** Per-resource failure, read from the store's public status signals. */
  private hasFailed(resource: VendorPortalResource): boolean {
    switch (resource) {
      case 'me':
        return this.store.meFailed();
      case 'integrations':
        return this.store.integrationsFailed();
      case 'notifications':
        return this.store.notificationsFailed();
      case 'seats':
        // Not reachable from any scope (no cursor feeds the seat roster), but
        // the exhaustive switch is what makes a future scope→resource addition
        // a compile error instead of a silent `undefined`.
        return this.store.seatsFailed();
    }
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.started || this.stopped) return;
    // Paused, not slowed: no timer exists while the tab is hidden.
    if (this.isHidden()) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, this.nextDelayMs());
  }

  /**
   * The cadence for the next tick: the visibility/focus base, or the error
   * backoff while failing.
   *
   * `Math.max` because the backoff must never make an unfocused tab poll FASTER
   * than its own steady cadence — the first backoff step (20 s) is shorter than
   * the unfocused interval (60 s), and answering an outage with more requests
   * than the healthy path issues would be backwards.
   */
  private nextDelayMs(): number {
    const base = this.document.hasFocus()
      ? VENDOR_SYNC_FOCUSED_INTERVAL_MS
      : VENDOR_SYNC_UNFOCUSED_INTERVAL_MS;
    if (this.failures === 0) return base;

    const backoff = Math.min(
      VENDOR_SYNC_BACKOFF_BASE_MS * 2 ** (this.failures - 1),
      VENDOR_SYNC_BACKOFF_CAP_MS,
    );
    return Math.max(base, backoff);
  }

  private isHidden(): boolean {
    return this.document.visibilityState === 'hidden';
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

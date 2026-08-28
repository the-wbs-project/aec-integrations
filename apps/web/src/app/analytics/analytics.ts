/**
 * Client-side analytics (AECI-239 / §14.1, reworked for the two-mode consent
 * init in AECI-643 / `docs/POSTHOG_MIGRATION_SPEC.md` §3.3, decision D2) — the
 * typed PostHog event API the app calls, plus the boot of the SDK.
 *
 * Shape (the injectable-SDK-seam idiom used across the app):
 *   - The SDK is reached only through the injectable `POSTHOG_CLIENT_FACTORY`
 *     (default = the real dynamic
 *     `import('posthog-js/dist/module.full.no-external')` — the self-contained
 *     bundle; see the decision block in `posthog-client.ts`); tests swap a fake so
 *     event payloads are asserted without loading the SDK.
 *   - Every custom event is gated on `'granted'` and merges the `locale`+`theme`
 *     dimensions (§14.1). Pageviews get the same dimensions via the
 *     super-properties the factory registers in PostHog's `loaded` callback.
 *   - Fire-and-forget: `capture` never awaits in a way that can throw into the
 *     caller — analytics MUST NOT break navigation or a form submit.
 *
 * ## Two tiers (§3.3)
 *
 * **Tier 2 — operational, every visitor.** The client boots at app bootstrap
 * for EVERYONE, DNT/GPC browsers included, with memory-only persistence and no
 * identifier. It carries errors, web vitals, and the `app_started` liveness
 * beacon. This is the PostHog counterpart of the consent-independent Datadog
 * RUM that stays live through the dual-run window (§AW-final retires RUM, not
 * this).
 *
 * **Tier 3 — product analytics, banner-gated.** On `consent.state() ===
 * 'granted'` the SAME client is upgraded in place (`upgrade()`): persistence
 * moves to localStorage, `$pageview` starts, and the 8-event catalog unlocks.
 * Decline, DNT and GPC all stay at Tier 2 — see `consent.ts`.
 *
 * ## Identity (AECI-649 / §AW8 — contract: `docs/ANALYTICS.md` §8)
 *
 * Three calls, each with its own reason to exist, all Tier 3:
 *
 *   - `identify(userId)` — the Supabase user id and nothing else. Never the
 *     email (§2): `identify()` already links the person, and copying the email
 *     into a property makes it searchable by anyone with project read.
 *   - `groupVendor({id, name})` — the B2B half. One vendor with four seats is
 *     ONE activated vendor, which a per-person count cannot approximate.
 *   - `resetIdentity()` — on logout, so the next anonymous session on that
 *     browser is not attributed to the person who just left.
 *
 * `identify` and `groupVendor` are **stored, not sent**, until consent is
 * granted. Both facts arrive on their own schedule and in either order (a
 * returning visitor is consented before the session resolves; a first-time
 * visitor signs in and accepts the banner afterwards), so a single effect
 * watches BOTH and fires when the pair is complete. Writing an identifier for a
 * visitor who declined would break the "no identifier is ever written
 * pre-consent" property the privacy policy states in writing (D2), and that
 * property is the whole reason Tier 2 exists.
 */
import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

import { analyticsDimensions } from './analytics-dimensions';
import { ConsentService } from './consent';
import {
  POSTHOG_CLIENT_FACTORY,
  TIER_3_PRODUCT_ANALYTICS_CONFIG,
  type PostHogClient,
} from './posthog-client';

/** Where a `product_viewed` was reached from (§14.1). */
export type ProductViewSource = 'search' | 'browse' | 'direct';

/** Catalog index/listing surfaces — arriving from one means `source: 'browse'`. */
const BROWSE_ROOTS = new Set(['products', 'vendors', 'integrations', 'categories']);

/**
 * The Tier 2 liveness beacon (§3.3). Fired once per page load for every
 * visitor, so "did the browser plane reach PostHog at all?" is answerable
 * without waiting for an organic error. It had a Datadog RUM twin
 * (`aeci.app_started`) until AECI-651 removed the Datadog leg; this is now the
 * only browser-plane heartbeat.
 */
export const APP_STARTED_EVENT = 'app_started';

/**
 * PostHog's group type for a vendor account (`docs/ANALYTICS.md` §8). Exported
 * so the spec asserts the literal rather than restating it — a typo here would
 * mint a second, empty group type in the project that nothing ever reports on.
 */
export const VENDOR_GROUP_TYPE = 'vendor';

@Injectable({ providedIn: 'root' })
export class Analytics {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly consent = inject(ConsentService);
  private readonly factory = inject(POSTHOG_CLIENT_FACTORY);
  private readonly router = inject(Router);

  /** Memoized client boot — runs at most once, in the browser, for all visitors. */
  private bootPromise: Promise<PostHogClient | null> | null = null;

  /**
   * Memoized `upgrade()`. A promise rather than a boolean flag because the
   * identity writes must be able to AWAIT the upgrade: `identify()` has to land
   * on a Tier 3 client, not race the `set_config` that moves persistence to
   * localStorage. A boolean guard returns instantly on the second caller, which
   * is exactly the caller that needs to wait.
   */
  private upgradePromise: Promise<void> | null = null;

  /**
   * The two Tier 3 identity facts, held until consent completes the pair.
   * Signals, not plain fields, so the identity effect re-runs when either
   * arrives — that is what makes the ordering work in both directions.
   */
  private readonly pendingUserId = signal<string | null>(null);
  private readonly pendingVendor = signal<{ id: string; name: string } | null>(null);

  /** What has actually been written to PostHog, so a re-navigation to
   *  `/vendor` or a second session probe does not re-send. */
  private identifiedAs: string | null = null;
  private groupedAs: string | null = null;

  /** The route the visitor was on BEFORE the current one — drives `source`. */
  private previousUrl: string | null = null;
  private currentUrl: string | null = null;

  constructor() {
    if (!this.isBrowser) return;

    // Track the previous in-app route so `productViewed` can classify its
    // source. NavigationEnd lands before the detail component's afterNextRender,
    // so `previousUrl` already reflects the prior route when the event fires.
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        this.previousUrl = this.currentUrl;
        this.currentUrl = e.urlAfterRedirects;
      });

    // Tier 2 (§3.3): boot immediately, unconditionally, for every visitor —
    // no consent check, no DNT check. This is the operational slice.
    void this.boot()
      .then((client) => client?.capture(APP_STARTED_EVENT, { ...analyticsDimensions() }))
      .catch(() => undefined);

    // Tier 3 (§3.3): upgrade the SAME client the moment consent is granted (or
    // immediately, for a returning visitor whose decision is already stored).
    effect(() => {
      if (this.consent.state() === 'granted') void this.upgrade();
    });

    // Tier 3 identity (§AW8 / `docs/ANALYTICS.md` §8). ONE effect for both
    // halves, because both are the same shape of problem: a fact that is only
    // sendable once consent ALSO holds, and which can arrive before or after it.
    //
    //   consent → sign-in : the effect re-runs when `pendingUserId` is set.
    //   sign-in → consent : the effect re-runs when `consent.state()` flips.
    //
    // A signed-in visitor who declined the banner (or sends DNT/GPC) never
    // reaches the body, so no identifier is ever written for them — they stay
    // an anonymous Tier 2 visitor, which is D2's promise.
    effect(() => {
      if (this.consent.state() !== 'granted') return;
      const userId = this.pendingUserId();
      const vendor = this.pendingVendor();
      if (userId) void this.identifyNow(userId);
      if (vendor) void this.groupVendorNow(vendor);
    });
  }

  // ─── Custom events (§14.1) ─────────────────────────────────────────────────

  /**
   * §14.1's `search_performed`, carrying the three fields re-homed from the
   * retired `aeci.search.query` Datadog RUM action (§3.9). Accepted narrowing,
   * stated in §3.8: the RUM action saw EVERY search; this event sees the
   * consented slice only.
   */
  searchPerformed(input: {
    query: string;
    results_count: number;
    results_products: number;
    results_vendors: number;
    filters_applied: readonly string[];
    status: string;
    duration_ms: number;
    results_bucket: string;
  }): void {
    this.capture('search_performed', {
      query: input.query,
      results_count: input.results_count,
      results_products: input.results_products,
      results_vendors: input.results_vendors,
      filters_applied: [...input.filters_applied],
      status: input.status,
      duration_ms: input.duration_ms,
      results_bucket: input.results_bucket,
    });
  }

  productViewed(productId: string): void {
    this.capture('product_viewed', { product_id: productId, source: this.navigationSource() });
  }

  integrationViewed(integrationId: string): void {
    this.capture('integration_viewed', { integration_id: integrationId });
  }

  reviewSubmitted(productId: string): void {
    this.capture('review_submitted', { product_id: productId });
  }

  /** §14.1 names `vendor_id`, but the request form holds only `(target_type,
   *  slug)` and the response returns only `request_id` — so we record the
   *  honest client-available identifier (documented deviation, OBSERVABILITY.md). */
  claimRequested(input: { target_type: string; slug: string; request_id: string }): void {
    this.capture('claim_requested', { ...input });
  }

  correctionRequested(input: { target_type: string; slug: string; request_id: string }): void {
    this.capture('correction_requested', { ...input });
  }

  externalLinkClicked(input: { destination: string; source: string }): void {
    this.capture('external_link_clicked', { ...input });
  }

  /**
   * A successful mailing-list signup (`POST /api/subscribe` → `created`), fired
   * from the shared mailing-list signup band (AECI-326, extracted in AECI-327).
   * Consent-gated like every other event, so it records the *consented* funnel
   * only — the `mailing_list` D1 table and `aeci.email.send{template:landing-signup}`
   * remain the authoritative, consent-independent signup count. `source` identifies
   * the capture surface: `'home_closing_cta'` for the home band, `'mailing_list_band'`
   * for the directory + detail mounts.
   */
  mailingListSignup(input: { source: string }): void {
    this.capture('mailing_list_signup', { source: input.source });
  }

  // ─── Identity (§AW8 / `docs/ANALYTICS.md` §8) ──────────────────────────────

  /**
   * Link this browser to the signed-in person (`docs/ANALYTICS.md` §8).
   *
   * `userId` MUST be the Supabase `auth.users` UUID — the JWT `sub` — because
   * that is exactly what the Worker side records as `posthogDistinctId`
   * (`packages/shared/src/posthog.ts`), and the two only join if they are the
   * same value. Nothing else is sent: no email, no display name, no user
   * properties at all (§2).
   *
   * Records the fact and returns. The write happens when consent is ALSO
   * granted — see the identity effect in the constructor. Safe to call on every
   * page load: the SDK's `identify` is a no-op when the distinct id is
   * unchanged (verified in `posthog-js@1.393.0`: no `$identify` event unless
   * `new_distinct_id !== previous_distinct_id`), and this service short-circuits
   * before even that.
   */
  identify(userId: string): void {
    if (!this.isBrowser || !userId) return;
    this.pendingUserId.set(userId);
  }

  /**
   * Associate the visitor with the vendor account whose dashboard they just
   * entered (`docs/ANALYTICS.md` §8).
   *
   * This is the reason PostHog groups exist in this project at all: it makes
   * "how many VENDORS activated" answerable. One vendor with four seats is one
   * activated vendor, and no per-person count can approximate that.
   *
   * Same consent gate and same store-then-send shape as {@link identify}.
   */
  groupVendor(vendor: { id: string; name: string }): void {
    if (!this.isBrowser || !vendor.id) return;
    this.pendingVendor.set({ id: vendor.id, name: vendor.name });
  }

  /**
   * Drop the PostHog identity on logout (`docs/ANALYTICS.md` §8).
   *
   * ## What `reset()` actually does, and what the client is left running
   *
   * Read out of `posthog-js@1.393.0` rather than assumed
   * (`lib/src/posthog-core.js`, `PostHog.prototype.reset`):
   *
   *   1. `consent.reset()` — removes the SDK's own `__ph_opt_in_out_<token>`
   *      key. AECi never writes that key (consent lives in `consent.ts` and
   *      `respect_dnt` is `false`), so the status lands on `PENDING`, and
   *      `isRejected()` is `PENDING && opt_out_capturing_by_default`, which is
   *      `false` by default. **The client is NOT opted out** — this is the step
   *      that would otherwise leave us Tier 1-dead, with `$exception` and
   *      `$web_vitals` silently stopped for the rest of the page's life.
   *   2. `persistence.clear()` + `sessionPersistence.clear()` — wipes every
   *      stored property, **including the `locale`/`theme` super-properties**
   *      registered in the factory's `loaded` callback and the `$groups` entry
   *      written by `group()`. That is why this method re-registers the
   *      dimensions afterwards: `docs/ANALYTICS.md` §3 says they ride EVERY
   *      event, and after a bare `reset()` they would silently stop riding
   *      `$pageview`, `$exception` and `$web_vitals` (custom events survive
   *      either way — `capture()` merges them per call).
   *   3. A fresh `distinct_id` is minted; `$device_id` is preserved (we do not
   *      pass `reset_device_id`), and `USER_STATE` goes back to `anonymous`.
   *   4. `reloadFeatureFlags()` — flags re-evaluate for the new anonymous user,
   *      which `FeatureFlags` picks up through its existing `onFeatureFlags`
   *      subscription.
   *
   * So the post-logout client is: **still capturing, no identity, dimensions
   * intact** — the operational floor is never lost. It is NOT downgraded to
   * Tier 2 config, and that is correct rather than an oversight: signing out
   * does not withdraw consent, so a consented, signed-out visitor is exactly a
   * consented anonymous visitor, which is a Tier 3 state with a fresh
   * anonymous id. Downgrading here would stop `$pageview` for someone who is
   * still consented.
   *
   * Awaited by every caller because all three logout paths follow it with a
   * hard `location.assign('/')`. The persistence writes are synchronous
   * localStorage calls, but they sit behind the memoized boot promise, so a
   * fire-and-forget call would be racing the navigation for a microtask.
   */
  async resetIdentity(): Promise<void> {
    if (!this.isBrowser) return;
    this.pendingUserId.set(null);
    this.pendingVendor.set(null);
    this.identifiedAs = null;
    this.groupedAs = null;
    try {
      const client = await this.boot();
      if (!client) return;
      client.reset();
      // Step 2 above: re-arm the required dimensions the clear() just dropped.
      client.register({ ...analyticsDimensions() });
    } catch {
      // Analytics MUST NOT break a logout.
    }
  }

  // ─── Tier 2 operational API (NOT consent-gated) ────────────────────────────

  /**
   * Report an application error as a PostHog `$exception` (§3.3, Tier 2).
   *
   * Deliberately NOT consent-gated: this is operational telemetry, the direct
   * analogue of the consent-independent Datadog RUM error stream, and it is
   * disclosed as strictly-necessary in the privacy policy. It carries no
   * identifier — Tier 2 persistence is memory-only.
   *
   * Called by `PosthogErrorHandler`; fire-and-forget and failure-swallowing,
   * because an error reporter that throws turns one bug into two.
   */
  captureException(error: unknown): void {
    if (!this.isBrowser) return;
    void this.boot()
      .then((client) => client?.captureException(error))
      .catch(() => undefined);
  }

  /**
   * The memoized Tier 2 client boot, shared with `FeatureFlags` (AECI-650).
   *
   * `createPostHogClient()` calls `posthog.init()` on the SDK's module
   * singleton, so exactly one owner may boot it: a second `init` is refused
   * with a console error ("You have already initialized posthog!") and the
   * second caller silently gets the first caller's configuration. Rather than
   * let a second service call the factory, everything that needs the client
   * borrows this promise.
   *
   * Resolves `null` on the server and whenever PostHog is unconfigured, which
   * is what makes a keyless tier deterministic: the SDK is never imported and
   * nothing is fetched.
   */
  client(): Promise<PostHogClient | null> {
    if (!this.isBrowser) return Promise.resolve(null);
    return this.boot();
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Gate on browser + consent, merge the required dimensions, fire-and-forget. */
  private capture(event: string, properties: Record<string, unknown>): void {
    if (!this.isBrowser || this.consent.state() !== 'granted') return;
    const enriched = { ...properties, ...analyticsDimensions() };
    void this.boot()
      .then((client) => client?.capture(event, enriched))
      .catch(() => undefined);
  }

  private boot(): Promise<PostHogClient | null> {
    return (this.bootPromise ??= this.factory());
  }

  /**
   * Tier 2 → Tier 3 upgrade, IN PLACE on the already-running client (§3.3): no
   * re-init, so the anonymous id and super-properties survive the switch to
   * localStorage persistence.
   *
   * `set_config` alone is not enough for pageviews. Verified against
   * `posthog-js@1.393.0`: `HistoryAutocapture.startIfEnabled()` is only called
   * from `initialize()`, and `_captureInitialPageview()` only from `_loaded()`
   * / `opt_in_capturing()`. So the upgrade explicitly (a) starts the history
   * patch — idempotent, it checks `__posthog_wrapped__` — and (b) captures the
   * page the visitor consented on.
   *
   * Known minor edge: `HistoryAutocapture._lastPathname` was seeded at init, so
   * navigating BACK to the page the SDK booted on right after granting consent
   * is suppressed as a same-path change. Every other navigation is captured.
   *
   * Memoized rather than flag-guarded so the identity writes can await it (see
   * {@link upgradePromise}).
   */
  private upgrade(): Promise<void> {
    return (this.upgradePromise ??= this.runUpgrade());
  }

  private async runUpgrade(): Promise<void> {
    try {
      const client = await this.boot();
      if (!client) return;
      client.set_config({ ...TIER_3_PRODUCT_ANALYTICS_CONFIG });
      client.historyAutocapture?.startIfEnabled();
      client.capture('$pageview', { ...analyticsDimensions() });
    } catch {
      // Analytics MUST NOT break the app.
    }
  }

  /**
   * Write the identity. Both writers await {@link upgrade} first so the call
   * lands on a Tier 3 client — consent is already granted when they run (the
   * effect gates on it), and the upgrade promise is therefore already in flight.
   *
   * The "already written" marker is set BEFORE the await, not after: the effect
   * can re-run (a second `identify()` from another page-load probe) while the
   * first write is still resolving, and two overlapping `$identify` captures
   * would be worse than one lost retry on a failing client.
   */
  private async identifyNow(userId: string): Promise<void> {
    if (this.identifiedAs === userId) return;
    this.identifiedAs = userId;
    try {
      await this.upgrade();
      const client = await this.boot();
      // The Supabase user id, alone. Never the email (§2).
      client?.identify(userId);
    } catch {
      // Analytics MUST NOT break the app.
    }
  }

  private async groupVendorNow(vendor: { id: string; name: string }): Promise<void> {
    if (this.groupedAs === vendor.id) return;
    this.groupedAs = vendor.id;
    try {
      await this.upgrade();
      const client = await this.boot();
      client?.group(VENDOR_GROUP_TYPE, vendor.id, { name: vendor.name });
    } catch {
      // Analytics MUST NOT break the app.
    }
  }

  private navigationSource(): ProductViewSource {
    const prev = this.previousUrl;
    if (!prev) return 'direct';
    const path = prev.split(/[?#]/, 1)[0] || '/';
    if (path === '/search' || path.startsWith('/search/')) return 'search';
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) return 'browse'; // home
    if (segments.length === 1 && BROWSE_ROOTS.has(segments[0])) return 'browse';
    return 'direct';
  }
}

/**
 * The PostHog SDK boundary (AECI-239, reworked for the two-mode consent init in
 * AECI-643 / `docs/POSTHOG_MIGRATION_SPEC.md` §3.3, decision D2).
 *
 * `posthog-js` is a browser-only SDK whose module-level code touches `window`,
 * so it is reached ONLY through a dynamic `import()` inside a browser-gated
 * caller (`Analytics`) — the same discipline as `datadog.provider.ts` /
 * `search-rum.ts`, keeping the SDK out of the SSR bundle entirely.
 *
 * `createPostHogClient` is exposed behind the `POSTHOG_CLIENT_FACTORY`
 * injection token so unit tests swap a fake client (the `SearchQueryEmitter` /
 * `SEARCH_ENGINE_FACTORY` seam idiom): the `Analytics` service injects the
 * token, never imports the SDK directly, and tests assert `capture(...)` calls
 * on a `vi.fn()` without loading `posthog-js`.
 *
 * ## Two tiers, ONE client
 *
 * Spec §3.3 splits the browser plane in two, and both run on the SAME
 * `posthog` singleton — the client is initialised once in Tier 2 and *upgraded
 * in place* when consent is granted, so the anonymous id, super-properties and
 * queued state carry across instead of being thrown away and re-minted.
 *
 * - **Tier 2 — browser operational.** Boots for EVERY visitor at app bootstrap,
 *   `DNT`/`GPC` browsers included (see `TIER_2_OPERATIONAL_CONFIG`). Errors and
 *   web vitals only; nothing persistent is written; no identifier is ever set.
 * - **Tier 3 — product analytics.** Banner-gated; DNT/GPC are a hard deny
 *   (`consent.ts`). On grant, `Analytics` applies
 *   `TIER_3_PRODUCT_ANALYTICS_CONFIG` via `set_config` (see below).
 *
 * ## `respect_dnt` is deliberately `false` (was `true`)
 *
 * Verified against `posthog-js@1.393.0` source, not documentation:
 * `ConsentManager.consent` returns `DENIED` whenever `respect_dnt` is true and
 * the browser signals DNT/GPC; `isRejected()` → `isOptedOut()` → `capture()`
 * returns early via `is_capturing()`. That kills **every** event on the
 * instance — `$exception` and `$web_vitals` included — which is exactly the
 * outcome D2 says must NOT happen: the operational slice matches today's
 * consent-independent Datadog RUM and runs for DNT browsers too. DNT/GPC
 * gating therefore lives in the consent layer (`consent.ts`), where it denies
 * the PRODUCT slice only. Do not set this back to `true`.
 *
 * ## Init choices
 *
 *   - `persistence: 'memory'` — Tier 2 writes NOTHING to localStorage or a
 *     cookie. Each page load gets a fresh anonymous id, so error *occurrence*
 *     counts are trustworthy but affected-visitor counts are not. That is the
 *     accepted price of pre-consent anonymity (§3.3).
 *   - `autocapture: false` / `capture_pageview: false` / `capture_pageleave:
 *     false` — no blanket DOM capture, no pageviews before consent.
 *   - `disable_session_recording: true` — replay stays off at v0 (D5); enabling
 *     it is a separate privacy review, not part of this migration.
 *   - `capture_exceptions: true` + `capture_performance: { web_vitals: true }`
 *     — the two operational signals (see the caveat below).
 *   - `disable_external_dependency_loading: true` — the SDK never injects a
 *     remote `<script>`, so the CSP `script-src` (`server/seo-headers.ts`)
 *     stays untouched; only the two `connect-src` PostHog hosts are needed.
 *   - `loaded: (ph) => ph.register(analyticsDimensions())` — registers
 *     `locale`/`theme` as super-properties before anything is captured.
 *
 * ## Why the SELF-CONTAINED bundle (`module.full.no-external`)
 *
 * Verified against `posthog-js@1.393.0`: the default ESM entry
 * (`dist/module.js`) does NOT inline the web-vitals library or the exception
 * autocapture wrappers. `WebVitalsAutocapture` and `ExceptionObserver` both
 * call `__PosthogExtensions__.loadExternalDependency(...)`, which
 * `disable_external_dependency_loading: true` refuses outright — and the CSP
 * `script-src` (`server/seo-headers.ts`) does not list
 * `https://us-assets.i.posthog.com` either. With the default entry,
 * `$web_vitals` simply never fires, which fails the migration spec's §6(4)
 * check ("`$web_vitals` pre-consent").
 *
 * Two ways to close that, and we took the second:
 *
 *   1. Allow `https://us-assets.i.posthog.com` in `script-src` and drop
 *      `disable_external_dependency_loading`. **Rejected.** AECI-239 chose
 *      `disable_external_dependency_loading: true` precisely so `script-src`
 *      would stay closed, and overturning a documented security decision to
 *      save bytes is the wrong trade. It also adds a third-party origin to the
 *      critical path (fresh DNS + TLS) and makes an operational signal depend
 *      on a CDN we do not control.
 *   2. **Import `posthog-js/dist/module.full.no-external`.** Both dependencies
 *      are inlined and the external loader is gone entirely, so nothing is ever
 *      fetched from another origin.
 *
 * Measured cost of (2), on a real production build:
 *
 *     default entry     213,236 B raw   /   61,450 B brotli
 *     no-external       497,333 B raw   /  131,483 B brotli
 *     delta                            +70,033 B brotli
 *
 * Initial bundle total is UNCHANGED (996.70 kB raw / 234.44 kB brotli) — this
 * is a lazy chunk fetched after hydration, not part of the initial graph. But
 * be honest about who pays: since Tier 2 runs for every visitor (§3.3), every
 * visitor now downloads it, where before only the consented minority did. It
 * arrives on an already-open same-origin HTTP/2 connection, which is the main
 * reason the trade lands where it does.
 *
 * **Reversible in one line** — change the `import()` below back to
 * `'posthog-js'` and accept losing `$web_vitals` and window-level exception
 * autocapture (manual `captureException` is bundled in both entries and is
 * unaffected either way, so `PosthogErrorHandler` keeps working).
 *
 * **`.full.` is required, and that was checked rather than assumed.** The
 * package also ships `dist/module.no-external.js` at 239 kB raw, which looks
 * like a cheaper version of the same idea. It is not: only the `.full.` bundle
 * contains `largest-contentful-paint`, the PerformanceObserver entry type the
 * real web-vitals library subscribes to. The other two entries carry the
 * `onLCP`/`onCLS`/`onINP` *names* (the extension interface) without the
 * implementation, so they would refuse to load it externally and then have
 * nothing to fall back on.
 *
 *     module.js                    216 kB raw   (default; loads extensions remotely)
 *     module.no-external.js        239 kB raw   (no external loading, NO web-vitals impl)
 *     module.full.no-external.js   503 kB raw   (everything inlined)  ← ours
 *
 * Part of that gap buys nothing: `.full.` also inlines the session-replay
 * recorder and its web-worker, and replay is off (D5). That is unavoidable
 * collateral of the only entry point that carries web vitals offline, not a
 * separate decision — but it is the honest reason the number is 503 and not
 * something closer to 300.
 *
 * One consequence to know before it alarms someone: the inlined replay worker
 * is embedded as a template literal whose text ends in a `//# sourceMappingURL=
 * image-bitmap-data-url-worker-….js.map` line. A `grep sourceMappingURL
 * dist/browser` therefore returns exactly one hit, ~14% into the posthog chunk,
 * pointing at a map that is not shipped. It is string content, not a trailing
 * comment on our chunk, and the AECI-646 "zero sourceMappingURL comments in
 * served JS" check still holds.
 *
 * Caveat for whoever upgrades the SDK: `posthog-js` publishes **no `exports`
 * field**, so `dist/module.full.no-external` is stable by convention rather
 * than by contract. It ships its own `.d.ts` and has an `array.*` sibling for
 * the snippet, so it is clearly intended as the CSP-restricted entry — but
 * re-verify the path (and re-measure) on a major bump.
 */
import { InjectionToken } from '@angular/core';

import { analyticsDimensions } from './analytics-dimensions';
import { readPostHogConfig } from './posthog-config';

/**
 * The minimal structural surface `Analytics` uses. The real `posthog`
 * singleton satisfies it; test fakes implement just these members.
 *
 * `historyAutocapture` is optional because it is an SDK-internal extension
 * instance — see `TIER_3_PRODUCT_ANALYTICS_CONFIG` for why the upgrade has to
 * poke it.
 */
export interface PostHogClient {
  capture(event: string, properties?: Record<string, unknown>): unknown;
  register(properties: Record<string, unknown>): void;
  set_config(config: Record<string, unknown>): void;
  captureException(error: unknown, properties?: Record<string, unknown>): unknown;
  readonly historyAutocapture?: { startIfEnabled(): void };

  /**
   * Identity (AECI-649 / §AW8; the contract is `docs/ANALYTICS.md` §8).
   *
   * REQUIRED, deliberately — unlike the two flag members below, which are
   * optional so pre-flags test fakes still satisfy this interface. Identity is
   * load-bearing: `identify` is what turns a stream of anonymous events into a
   * person, `group` is the only way "how many VENDORS activated" is answerable,
   * and `reset` is what stops the next visitor on a shared browser being
   * attributed to the person who just left. An optional member that a fake
   * silently omits would make all three no-ops that no test can see — the exact
   * silent failure `docs/ANALYTICS.md` warns about. A fake that does not
   * implement them is a compile error, which is the point.
   *
   * `identify` takes the Supabase user id and NOTHING else: no user-property
   * bag, because §2 forbids duplicating the email into a property and there is
   * nothing else worth sending. `group` carries only the display name.
   */
  identify(distinctId: string, properties?: Record<string, unknown>): void;
  group(groupType: string, groupKey: string, properties?: Record<string, unknown>): void;
  reset(resetDeviceId?: boolean): void;

  /**
   * Feature flags (AECI-650). Both are OPTIONAL so the many existing test
   * fakes that predate flags still satisfy this interface; `FeatureFlags`
   * treats an absent member as "no flags available, defaults stand".
   *
   * `onFeatureFlags` fires when the `/flags` response first lands and again on
   * every change, which is what lets a flip in the PostHog UI reach a live
   * page. `isFeatureEnabled` returns `undefined` both before flags load and for
   * a key the project does not define; `feature-flags.ts` collapses that third
   * state into the committed default exactly once.
   */
  onFeatureFlags?(
    callback: (flags: string[], variants: Record<string, string | boolean>) => void,
  ): () => void;
  isFeatureEnabled?(key: string, options?: { send_event?: boolean }): boolean | undefined;
}

/** Resolves the initialized client, or `null` when analytics is unavailable. */
export type PostHogClientFactory = () => Promise<PostHogClient | null>;

/**
 * Tier 2 (§3.3): the operational slice that runs for every visitor, DNT/GPC
 * included. Exported so specs assert the exact posture rather than restating it.
 */
export const TIER_2_OPERATIONAL_CONFIG = {
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  disable_session_recording: true,
  capture_exceptions: true,
  capture_performance: { web_vitals: true },
  // See the file header: DNT/GPC must NOT suppress the operational slice.
  respect_dnt: false,
  // Nothing persistent pre-consent: no localStorage entry, no cookie.
  persistence: 'memory',
  disable_external_dependency_loading: true,
} as const;

/**
 * Tier 3 (§3.3): the delta applied by `set_config` when the banner is
 * accepted. The same client keeps running; only its posture changes.
 *
 * `persistence` is the load-bearing key. `PostHogPersistence.update_config`
 * detects the change, migrates the in-memory props into the new backend, and
 * re-saves — so the anonymous id minted in Tier 2 becomes the persisted one
 * rather than being replaced.
 *
 * `capture_pageview: 'history_change'` is the spec-named value, but on its own
 * it is inert after init: `set_config` never re-runs
 * `HistoryAutocapture.startIfEnabled()`, and `_captureInitialPageview()` only
 * fires from `_loaded()` / `opt_in_capturing()`. `Analytics.upgrade()`
 * therefore also calls `startIfEnabled()` (idempotent — the patch checks
 * `__posthog_wrapped__`) and captures the current page's `$pageview` by hand.
 */
export const TIER_3_PRODUCT_ANALYTICS_CONFIG = {
  persistence: 'localStorage+cookie',
  capture_pageview: 'history_change',
  capture_pageleave: 'if_capture_pageview',
} as const;

/**
 * Loads + initializes `posthog-js` in its Tier 2 posture, returning the client
 * (or `null` when config is absent or the SDK fails to load — analytics MUST
 * never break the app).
 */
export async function createPostHogClient(): Promise<PostHogClient | null> {
  const cfg = readPostHogConfig();
  if (!cfg) return null;
  try {
    const { default: posthog } = await import('posthog-js/dist/module.full.no-external');
    posthog.init(cfg.key, {
      api_host: cfg.host,
      ...TIER_2_OPERATIONAL_CONFIG,
      loaded: (ph) => ph.register(analyticsDimensions()),
    });
    return posthog;
  } catch (error: unknown) {
    // Analytics MUST NOT break the app — swallow load/init failures.
    console.warn('PostHog failed to initialise', error);
    return null;
  }
}

/**
 * Injectable seam for the client factory. Default = `createPostHogClient` (the
 * real SDK); specs override it with a fake so `capture`/`register` are asserted
 * without `posthog-js`.
 */
export const POSTHOG_CLIENT_FACTORY = new InjectionToken<PostHogClientFactory>(
  'POSTHOG_CLIENT_FACTORY',
  { providedIn: 'root', factory: () => createPostHogClient },
);

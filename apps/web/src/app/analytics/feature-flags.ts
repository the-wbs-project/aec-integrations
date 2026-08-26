/**
 * Browser feature flags (AECI-650 / §AW9 of `docs/POSTHOG_MIGRATION_SPEC.md`).
 * Conventions and the "adding a flag" checklist live in `docs/ANALYTICS.md` §10.
 *
 * Five rules. The fourth is AECi-specific, has no counterpart in the sibling
 * `earned-value` migration this spec is ported from, and is the one that will
 * bite hardest if it is forgotten.
 *
 * ── 1. THE CATALOGUE IS THE TYPE ────────────────────────────────────────────
 * {@link featureFlagDefaults} is the committed catalogue, and
 * {@link FeatureFlag} is derived from it — so `flags.flag('serch-v2')` is a
 * COMPILE ERROR, not a flag that quietly reads `false` forever. That inversion
 * is the whole point: an unknown flag key is indistinguishable at runtime from
 * a flag that is switched off, which is the single most common way flag
 * plumbing fails silently. Every key ships with the value the app must behave
 * correctly under when PostHog is unreachable; user-visible flags default to
 * `false`, so the unflagged path is the shipped path.
 *
 * ── 2. NO `undefined` THIRD STATE ───────────────────────────────────────────
 * `flag()` returns a `Signal<boolean>`, never `Signal<boolean | undefined>`.
 * The signal is CREATED at the committed default and is only ever replaced by a
 * real evaluation once PostHog's `/flags` response has landed. There is no
 * window in which a caller can observe `undefined`.
 *
 * This is a deliberate narrowing of the SDK, which does surface a third state:
 * `posthog.isFeatureEnabled(key)` returns `undefined` both before flags load
 * and for a key the project does not define. Exposing that would force every
 * call site to handle "not loaded yet" — and they would not; they would write
 * `if (flag())` and ship the wrong branch for the first few hundred
 * milliseconds of every page load. So the collapse happens once, here
 * ({@link FeatureFlags.adopt}'s `?? featureFlagDefaults[key]`), rather than
 * wrongly at each call site.
 *
 * ── 3. KEYLESS TIERS ARE DETERMINISTIC ──────────────────────────────────────
 * With no `window.__AECI_POSTHOG__` (bare local dev, an unprovisioned tier) the
 * shared client boot resolves `null`, no subscription is registered, and every
 * flag stands at its default. Nothing is fetched. Local dev therefore behaves
 * identically on every machine and never depends on the network, which is the
 * same "no project key means total no-op" invariant the Worker transport keeps
 * (spec §2, invariant 3).
 *
 * ── 4. FLAGS NEVER ALTER CACHEABLE SSR OUTPUT (the AECi rule) ───────────────
 * The Workers Cache is keyed by URL — path, query and Worker version, and
 * NOTHING about the visitor (`docs/CACHE_STRATEGY.md` §4a, `STAGE_1_SPEC.md`
 * §9.1a). If a flag reached an SSR render decision, the FIRST visitor's flag
 * evaluation would be baked into the cached HTML and served to everyone,
 * including every visitor in the other variant. It is exactly the theme-cookie
 * trap that produced `stripVisitorStateCookies`, with a worse failure mode: a
 * mis-set theme is visible, a mis-served variant is not.
 *
 * So flag-gated UI RECONCILES POST-HYDRATION, the pattern `ReviewCta` and
 * `ConsentBanner` already use: render the visitor-neutral default, then let the
 * browser move it. Here that costs nothing extra, because rule 2 already
 * guarantees the signal starts at the default — which is also what keeps
 * hydration matching, since the server render and the client's first render
 * read the identical value.
 *
 * The rule is enforced BY CONSTRUCTION rather than by discipline: this service
 * resolves no value on the server (the constructor returns early, and the SDK
 * is browser-only anyway), so an SSR pass can only ever see defaults. The one
 * way to break it is to call the Worker-side helper from SSR code, which is why
 * `isFeatureEnabled` in `packages/shared/src/posthog.ts` is for API-WORKER
 * BEHAVIOUR ONLY and never for a render decision. That helper also costs a
 * network round-trip per call: local evaluation would need a personal API key
 * inside the client, and that may never become a Worker secret, so the round
 * trip is genuinely unavailable rather than merely unimplemented.
 *
 * ── 5. FLAGS ARE SCAFFOLDING ────────────────────────────────────────────────
 * Check a flag at ROUTE or FEATURE level, never in a leaf component — one
 * check that picks a branch is reviewable; twenty checks sprinkled through a
 * component tree are a permanent second code path. Delete the flag (and its
 * catalogue row) within weeks of full rollout. A flag that outlives its
 * rollout has become architecture, and nobody ever deletes architecture.
 */
import { isPlatformBrowser } from '@angular/common';
import {
  Injectable,
  PLATFORM_ID,
  type Signal,
  type WritableSignal,
  inject,
  signal,
} from '@angular/core';

import { Analytics } from './analytics';
import type { PostHogClient } from './posthog-client';

/**
 * THE FLAG CATALOGUE. Every browser feature flag AECi knows about, mapped to
 * the value it takes when PostHog has not answered (or is not configured).
 *
 * Keys are `kebab-case` and feature-scoped — a different namespace from events
 * (`snake_case object_verb`) on purpose, so a flag key never reads like an
 * event name (`docs/ANALYTICS.md` §1). User-visible flags default to `false`.
 *
 * Adding a key here is half of shipping a flag; the other half is the row in
 * `docs/ANALYTICS.md` §10, in the SAME PR.
 *
 * `as const satisfies` rather than a plain annotation: `satisfies` alone would
 * be enough to check the values, but `as const` is what keeps the KEYS literal,
 * and the literal keys are what {@link FeatureFlag} is made of.
 */
export const featureFlagDefaults = {
  /**
   * PLACEHOLDER, and labelled as one. AECI-650 delivered the mechanism; at the
   * time it landed there was no shipped surface to gate — every candidate in
   * the tree was either already the chosen design (the tabbed vendor dashboard)
   * or unbuilt, and a rollout flag defaults to `false`, so there is nothing for
   * a `false` default to hide.
   *
   * It exists only so this map is non-empty. An empty map makes
   * {@link FeatureFlag} `never`, which makes every call site a compile error
   * and the whole service unusable. DELETE THIS ROW in the PR that adds the
   * first real flag.
   */
  'example-placeholder': false,
} as const satisfies Record<string, boolean>;

/**
 * The union of every committed flag key. Derived from the catalogue, never
 * hand-maintained beside it, so the two cannot drift.
 */
export type FeatureFlag = keyof typeof featureFlagDefaults;

/**
 * One flag's state: the writable source plus the stable readonly view handed
 * to callers. Both are kept because {@link FeatureFlags.flag} must return the
 * SAME signal instance on every call for a given key (see its doc), and only a
 * stored view guarantees that.
 */
interface FlagCell {
  readonly source: WritableSignal<boolean>;
  readonly view: Signal<boolean>;
}

/**
 * Signal-shaped access to PostHog's browser feature flags.
 *
 * Lazy by design: nothing subscribes until something injects this service, so
 * a page that reads no flags pays nothing. Unlike `Analytics` it is NOT forced
 * into existence by an app initializer.
 */
@Injectable({ providedIn: 'root' })
export class FeatureFlags {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /**
   * The client is borrowed from `Analytics`, never booted here.
   * `createPostHogClient()` calls `posthog.init()` on the SDK's singleton, and
   * a second `init` on that singleton is ignored with a console error
   * ("You have already initialized posthog!"), so the memoized Tier 2 boot in
   * `Analytics` is the ONE place initialization may happen.
   */
  private readonly analytics = inject(Analytics);

  private readonly cells = new Map<FeatureFlag, FlagCell>();

  /**
   * The client, but ONLY once `/flags` has actually answered. `null` covers
   * both "not configured" and "response still in flight", and both mean the
   * same thing to a reader: defaults stand.
   */
  private loaded: PostHogClient | null = null;

  constructor() {
    // Server: resolve nothing, ever. See rule 4 in the file header.
    if (!this.isBrowser) return;
    void this.subscribe();
  }

  /**
   * The signal for `key`, starting at its committed default.
   *
   * Two properties call sites depend on:
   *
   *   - **Stable identity.** Repeated calls for the same key return the SAME
   *     signal instance, so binding `flags.flag('x')()` in a template does not
   *     mint a new signal on every change-detection pass (which would make the
   *     binding churn and defeat `OnPush`).
   *   - **Late adoption.** A component that mounts AFTER the `/flags` response
   *     landed still gets the live value: the cell is seeded from the loaded
   *     client on creation rather than sitting at the default until the next
   *     flag change, which might never come.
   */
  flag(key: FeatureFlag): Signal<boolean> {
    const existing = this.cells.get(key);
    if (existing) return existing.view;

    const source = signal<boolean>(featureFlagDefaults[key]);
    const cell: FlagCell = { source, view: source.asReadonly() };
    this.cells.set(key, cell);
    // Late subscriber: adopt the current value now if flags are already in.
    this.adopt(key, cell);
    return cell.view;
  }

  /**
   * Subscribe to flag delivery. `onFeatureFlags` fires when `/flags` first
   * answers AND on every later change, which is what makes a flip in the
   * PostHog UI reach a live page without a redeploy.
   *
   * A missing client (no `__AECI_POSTHOG__`) or a missing `onFeatureFlags`
   * (a test fake, an SDK entry without the flags extension) is not an error:
   * it means defaults stand, so return quietly rather than warning on every
   * local boot.
   */
  private async subscribe(): Promise<void> {
    try {
      const client = await this.analytics.client();
      if (!client?.onFeatureFlags) return;
      client.onFeatureFlags(() => {
        this.loaded = client;
        for (const [key, cell] of this.cells) this.adopt(key, cell);
      });
    } catch {
      // Flags MUST NOT break the app. Defaults stand.
    }
  }

  /**
   * Collapse the SDK's `boolean | undefined` into a boolean, once, here.
   * `undefined` means "PostHog has no opinion about this key" (typically: the
   * flag does not exist in the project, or was deleted) and takes the default.
   *
   * `send_event: false` mirrors `sendFeatureFlagEvents: false` on the Worker
   * seam: a read must not emit a `$feature_flag_called` event. Reading a flag
   * would otherwise capture a product-analytics-shaped event in the Tier 2
   * pre-consent slice, and AECi runs no PostHog experiments, which are the only
   * thing that consumes those events.
   */
  private adopt(key: FeatureFlag, cell: FlagCell): void {
    const client = this.loaded;
    if (!client?.isFeatureEnabled) return;
    try {
      const value = client.isFeatureEnabled(key, { send_event: false });
      cell.source.set(value ?? featureFlagDefaults[key]);
    } catch {
      // Keep the default; an evaluation throw must not surface to the UI.
    }
  }
}

/**
 * Consent state for **product analytics** (AECI-239 / Phase 7.4; scope
 * clarified for the two-mode init in AECI-643 /
 * `docs/POSTHOG_MIGRATION_SPEC.md` §3.3, decision D2).
 *
 * ## What this service does and does NOT gate
 *
 * This signal governs **Tier 3 only** — the product-analytics slice: pageviews,
 * the §14.1 event catalog, persistent storage, and (later) `identify`/groups.
 * AECi takes an **opt-in** posture there: nothing in that slice is captured
 * until consent is `'granted'`.
 *
 * It does **NOT** gate **Tier 2**, the anonymous operational slice (error
 * reports + web vitals, memory-only persistence, no identifier, no persistent
 * storage). Tier 2 boots for EVERY visitor — including DNT/GPC browsers —
 * because it is the PostHog counterpart of the consent-independent Datadog RUM
 * it replaces, and because operational telemetry is opt-out-exempt in normal
 * practice. `posthog-js`'s own `respect_dnt` is therefore set to `false`
 * (`posthog-client.ts` explains why: `true` would silently kill `$exception`
 * and `$web_vitals` too). The posture is disclosed in the privacy policy.
 *
 * ## Storage + DNT/GPC
 *
 * The decision is stored in `localStorage` — NOT a cookie — so it never reaches
 * the SSR Worker and therefore can't pollute the URL-keyed edge cache (§9.1a).
 * The banner (`consent-banner.ts`) renders neutral/hidden in SSR and reconciles
 * from this service post-hydration, mirroring the theme/CTA reconciliation
 * pattern.
 *
 * Do-Not-Track and Global Privacy Control are honored as a hard `'denied'`:
 * when either is set we never show the banner and never enable product
 * analytics, regardless of stored state. They deny Tier 3; they do not deny
 * Tier 2.
 */
import { isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';

export type ConsentState = 'unknown' | 'granted' | 'denied';

/** localStorage key holding the persisted decision. */
export const CONSENT_STORAGE_KEY = 'aeci_analytics_consent';

/** True when the browser signals Do-Not-Track / Global Privacy Control. */
function isDoNotTrackEnabled(): boolean {
  const nav = globalThis.navigator as
    | (Navigator & { msDoNotTrack?: string; globalPrivacyControl?: boolean })
    | undefined;
  const win = globalThis.window as (Window & { doNotTrack?: string }) | undefined;
  if (!nav && !win) return false;
  const dnt = nav?.doNotTrack ?? win?.doNotTrack ?? nav?.msDoNotTrack;
  return dnt === '1' || dnt === 'yes' || nav?.globalPrivacyControl === true;
}

@Injectable({ providedIn: 'root' })
export class ConsentService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly _state = signal<ConsentState>(this.read());

  /** Current consent decision for the PRODUCT slice. `'unknown'` until the
   *  visitor chooses (or on the server). Consumed by `Analytics` (the Tier 2 →
   *  Tier 3 upgrade gate) and `ConsentBanner` (show). */
  readonly state = this._state.asReadonly();

  /** Record acceptance: persist + flip the signal. The already-running PostHog
   *  client upgrades to Tier 3 reactively (`Analytics.upgrade()`). */
  grant(): void {
    this.persist('granted');
  }

  /** Record refusal: persist + flip the signal. The client stays at Tier 2 —
   *  operational telemetry only, no pageviews, nothing persistent. */
  deny(): void {
    this.persist('denied');
  }

  private read(): ConsentState {
    if (!this.isBrowser) return 'unknown';
    // DNT/GPC win over any stored decision — never enable product analytics,
    // never re-prompt. (Tier 2 operational telemetry is unaffected; see header.)
    if (isDoNotTrackEnabled()) return 'denied';
    try {
      const stored = globalThis.localStorage?.getItem(CONSENT_STORAGE_KEY);
      return stored === 'granted' || stored === 'denied' ? stored : 'unknown';
    } catch {
      // Private-mode / storage-disabled browsers throw on access — degrade to
      // "no decision" so the banner shows and nothing is captured.
      return 'unknown';
    }
  }

  private persist(state: 'granted' | 'denied'): void {
    if (this.isBrowser) {
      try {
        globalThis.localStorage?.setItem(CONSENT_STORAGE_KEY, state);
      } catch {
        // Storage may be unavailable; the in-memory signal still gates capture
        // for this session.
      }
    }
    this._state.set(state);
  }
}

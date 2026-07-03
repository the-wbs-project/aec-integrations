/**
 * Analytics consent state (AECI-239 / Phase 7.4).
 *
 * AECi takes an **opt-in** posture: the PostHog client (`analytics.ts`) does not
 * load or capture anything until consent is `'granted'`. The decision is stored
 * in `localStorage` — NOT a cookie — so it never reaches the SSR Worker and
 * therefore can't pollute the URL-keyed edge cache (§9.1a). The banner
 * (`consent-banner.ts`) renders neutral/hidden in SSR and reconciles from this
 * service post-hydration, mirroring the theme/CTA reconciliation pattern.
 *
 * Do-Not-Track is honored as a hard `'denied'`: when DNT is set we never show
 * the banner and never load PostHog, regardless of stored state.
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

  /** Current consent decision. `'unknown'` until the visitor chooses (or on the
   *  server). Consumed by `Analytics` (boot gate) and `ConsentBanner` (show). */
  readonly state = this._state.asReadonly();

  /** Record acceptance: persist + flip the signal. PostHog boots reactively. */
  grant(): void {
    this.persist('granted');
  }

  /** Record refusal: persist + flip the signal. PostHog never loads. */
  deny(): void {
    this.persist('denied');
  }

  private read(): ConsentState {
    if (!this.isBrowser) return 'unknown';
    // DNT wins over any stored decision — never capture, never re-prompt.
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

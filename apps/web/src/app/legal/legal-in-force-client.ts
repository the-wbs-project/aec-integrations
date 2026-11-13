/**
 * The agreement and policy versions in force, for a browser form that names or checks
 * one (AECI-1689): the claim box's policy line (`vendor-terms-box.ts`) and the admin
 * grant form's signed-deal version (`grant-licenses-control.ts`). The API stamps the
 * version in force at request time (`apps/api/src/lib/legal-in-force.ts`), so the form
 * must name the same one, including after an effective moment and before bump day.
 *
 * `versions` starts at the build's versions, the pre-moment answer. `refresh()` asks
 * `GET /api/legal/published` and decides with the API's `now`, never the browser's
 * clock, through the shared rule (`legalVersionsInForce`). It reads nothing while no
 * upcoming entry exists (today), and nothing on the server: SSR renders the build's
 * versions and the browser corrects them after hydration. A failed read keeps them.
 *
 * One answer serves the page until a known upcoming moment has passed since it was given.
 * "Since" is measured from the API's `now` plus the time elapsed on the page's monotonic
 * clock (`performance.now()`), so a tab left open across a moment asks again, still
 * without trusting the browser's wall clock.
 *
 * It imports the shared maps only, never the web manifest, so the claim dialog's chunk
 * does not carry the version lists.
 */
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, InjectionToken, PLATFORM_ID, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
  LEGAL_IN_FORCE_MAPS,
  legalNextEffectiveMomentMs,
  legalPublishedLiteOf,
  legalVersionsInForce,
  type LegalInForceMaps,
  type LegalInForceVersions,
} from '@aeci/shared/api/legal-in-force';
import type { LegalPublishedResponse } from '@aeci/shared/api/legal-versions';

/** The maps the client decides with. A token so a spec can announce a fixture entry. */
export const LEGAL_IN_FORCE_CLIENT_MAPS = new InjectionToken<LegalInForceMaps>(
  'LEGAL_IN_FORCE_CLIENT_MAPS',
  { providedIn: 'root', factory: () => LEGAL_IN_FORCE_MAPS },
);

/** A monotonic clock in ms (`performance.now()`). A token so a spec can step it. */
export const LEGAL_MONOTONIC_MS = new InjectionToken<() => number>('LEGAL_MONOTONIC_MS', {
  providedIn: 'root',
  factory: () => () => performance.now(),
});

/** The build's versions: what the rule answers before any moment. */
export function buildLegalVersionsInForce(
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): LegalInForceVersions {
  return legalVersionsInForce([], Number.NEGATIVE_INFINITY, maps);
}

/** Whether any agreement or policy has an upcoming entry, so the answer can change. */
export function legalInForceCanChange(maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS): boolean {
  return (
    Object.values(maps.agreementUpcoming).some(Boolean) ||
    Object.values(maps.policyUpcoming).some(Boolean)
  );
}

@Injectable({ providedIn: 'root' })
export class LegalInForceClient {
  private readonly http = inject(HttpClient);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly maps = inject(LEGAL_IN_FORCE_CLIENT_MAPS);
  private readonly monotonic = inject(LEGAL_MONOTONIC_MS);
  private pending: Promise<void> | null = null;
  /** When the last answer expires: the next moment after it, on the monotonic clock. */
  private expiresAtMono = Number.POSITIVE_INFINITY;

  /** The versions in force, as far as this page knows. */
  readonly versions = signal<LegalInForceVersions>(buildLegalVersionsInForce(this.maps));

  /**
   * Ask the API, once per answer: again only after a known upcoming moment has passed
   * since the last one. Safe to call from every form that shows a version.
   */
  refresh(): Promise<void> {
    if (!this.browser || !legalInForceCanChange(this.maps)) return Promise.resolve();
    if (this.pending && this.monotonic() < this.expiresAtMono) return this.pending;
    const asked = this.monotonic();
    this.pending = firstValueFrom(this.http.get<LegalPublishedResponse>('/api/legal/published'))
      .then((res) => {
        const apiNow = Date.parse(res.now);
        this.versions.set(
          legalVersionsInForce(legalPublishedLiteOf(res.published), apiNow, this.maps),
        );
        const next = legalNextEffectiveMomentMs(apiNow, this.maps);
        this.expiresAtMono = next === null ? Number.POSITIVE_INFINITY : asked + (next - apiNow);
      })
      .catch(() => {
        // Keep what the page shows and ask again next time. For a claim or a listing
        // request the server stamps whatever is in force at submit, so a stale line here
        // can name an older policy version than the one recorded; a grant names the
        // version the server pins and is refused if it differs.
        this.pending = null;
      });
    return this.pending;
  }
}

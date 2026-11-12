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
 * It imports the shared maps only, never the web manifest, so the claim dialog's chunk
 * does not carry the version lists.
 */
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
  LEGAL_IN_FORCE_MAPS,
  legalPublishedLiteOf,
  legalVersionsInForce,
  type LegalInForceMaps,
  type LegalInForceVersions,
} from '@aeci/shared/api/legal-in-force';
import type { LegalPublishedResponse } from '@aeci/shared/api/legal-versions';

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
  private readonly maps = LEGAL_IN_FORCE_MAPS;
  private pending: Promise<void> | null = null;

  /** The versions in force, as far as this page knows. */
  readonly versions = signal<LegalInForceVersions>(buildLegalVersionsInForce(this.maps));

  /** Ask the API once per page load. Safe to call from every form that shows a version. */
  refresh(): Promise<void> {
    if (!this.browser || !legalInForceCanChange(this.maps)) return Promise.resolve();
    this.pending ??= firstValueFrom(this.http.get<LegalPublishedResponse>('/api/legal/published'))
      .then((res) => {
        this.versions.set(
          legalVersionsInForce(legalPublishedLiteOf(res.published), Date.parse(res.now), this.maps),
        );
      })
      .catch(() => {
        // Keep the build's versions: the server refuses a stale one with a clear error.
        this.pending = null;
      });
    return this.pending;
  }
}

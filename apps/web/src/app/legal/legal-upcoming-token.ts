/**
 * The upcoming manifest the legal pages read (`LEGAL_UPCOMING` by default, AECI-1610).
 * A token so a spec can announce or switch a fixture entry. `LegalPage` and the
 * in-force resolver (`legal-in-force.resolver.ts`, AECI-1689) both inject it, so they
 * always read the same entries.
 */
import { InjectionToken } from '@angular/core';

import { LEGAL_UPCOMING, type LegalUpcomingEntry } from './legal-manifest';

export const LEGAL_UPCOMING_ENTRIES = new InjectionToken<readonly LegalUpcomingEntry[]>(
  'LEGAL_UPCOMING_ENTRIES',
  { providedIn: 'root', factory: () => LEGAL_UPCOMING },
);

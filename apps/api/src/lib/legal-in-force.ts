/**
 * The version of each agreement and policy in force at request time, as the API Worker
 * reads it (AECI-1689). The rule is `legalVersionsInForce` in `@aeci/shared`; this module
 * only supplies its one D1 input, the `legal_versions` rows.
 *
 * Every path that stamps or shows "the current version" for a NEW acceptance asks here:
 * the claim and the listing request (`routes/requests.ts`, `routes/listing-requests.ts`),
 * the pending confirmation (`lib/request-confirmations.ts`), Stripe checkout
 * (`routes/vendor-billing-stripe.ts`), a new grant (`routes/admin-licenses.ts`), the
 * Billing tab's pending grant (`routes/vendor-billing.ts`), the 45-day renewal notice
 * (`lib/entitlement-expiry.ts`) and `/admin/legal`. `legal-current-readers.spec.ts`
 * (packages/shared) fails on any other reader of the build constants.
 *
 * ── NO READ UNLESS IT CAN MATTER ─────────────────────────────────────────────────
 * The rows can change the answer only once an upcoming agreement's effective moment has
 * come (`legalInForceNeedsPublished`). Before that, and always with today's empty
 * upcoming map, no query runs and the answer is the build's current versions. So every
 * path behaves exactly as before AECI-1689 until a published date passes.
 */

import {
  legalInForceNeedsPublished,
  legalVersionsInForce,
  LEGAL_IN_FORCE_MAPS,
  type LegalInForceMaps,
  type LegalInForceVersions,
  type LegalPublishedLite,
} from '@aeci/shared';

import type { Db } from '../db/client';
import { legalVersions } from '../db/schema';

/** The `legal_versions` rows the rule reads, or none when they cannot matter at `nowMs`. */
export async function loadLegalPublishedLite(
  db: Db,
  nowMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): Promise<LegalPublishedLite[]> {
  if (!legalInForceNeedsPublished(nowMs, maps)) return [];
  return db
    .select({
      document: legalVersions.document,
      version: legalVersions.version,
      effectiveAt: legalVersions.effectiveAt,
    })
    .from(legalVersions);
}

/** Every agreement and policy version in force at `now`. */
export async function loadLegalInForce(
  db: Db,
  now: Date,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): Promise<LegalInForceVersions> {
  const nowMs = now.getTime();
  return legalVersionsInForce(await loadLegalPublishedLite(db, nowMs, maps), nowMs, maps);
}

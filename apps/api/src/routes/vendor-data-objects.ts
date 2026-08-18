/**
 * The closed `data_object` vocabulary, for the §6 dashboard's picker
 * (`GET /api/vendor/data-objects`, AECI-606 / `STAGE_2_ATTESTATIONS_SPEC.md` §6).
 *
 * §5.2 requires `data_object` to be **find-only** — a vendor cannot mint a term,
 * and an unmatched one is a `400 VALIDATION_FAILED` naming the field. It then
 * says the fix belongs one layer up: "The UI (§6) should offer the closed list
 * rather than free text in the first place." Nothing served that list to a
 * browser — `GET /api/taxonomy` carries only the four product facets, and the
 * one surface exposing `taxonomy_data_objects` (`/api/admin/catalog/coverage`)
 * is admin-gated. This route is that list.
 *
 * ── WHY THIS IS NOT IN `vendor-attestations.ts` ─────────────────────────────
 * That module's first rule is "AUTHORITY IS DERIVED, NEVER SENT", and every
 * handler in it resolves `product_vendors` before reading anything. This handler
 * resolves nothing. Sitting it among four handlers that all prove ownership is
 * how a reviewer comes to assume a check that is not there — so it lives beside
 * them rather than inside them, the way `vendor-notifications.ts` does for its
 * own unusual property.
 *
 * ── WHY IT IS NOT VENDOR-SCOPED, AND WHY THAT IS SAFE ───────────────────────
 * Every other `/api/vendor/*` handler filters on `c.get('auth').vendorId`,
 * because with no RLS behind the guard (ADR 0016) that filter *is* the
 * authorization (`docs/AUTH_AND_RLS.md` §4.4, obligation 1). This is the sole
 * documented exception, and the distinction is that the filter here would be
 * **vacuous rather than omitted**: `taxonomy_data_objects` is an AECi-curated
 * vocabulary with no `vendor_id` column and no vendor-owned rows, so every
 * caller gets a byte-identical body by construction. A spec asserts exactly that
 * (two seats, deep-equal responses) so a later "add the missing scope filter"
 * edit fails loudly instead of looking like a fix.
 *
 * It is still mounted behind `requireVendor()`. Not for confidentiality — the
 * vocabulary is published in `docs/DATA_OBJECT_VOCABULARY.md` — but because the
 * surface is managed as a unit: one guard, one authz matrix, one place to reason
 * about who can reach `/api/vendor/*` at all.
 *
 * ── NOT VERIFIED-GATED ──────────────────────────────────────────────────────
 * Same posture as `GET /api/vendor/integrations` and `/notifications`:
 * `vendors.verified` gates **authoring** (§1), not reading. An unverified vendor
 * renders the tab read-only and is told what verification unlocks; 403-ing the
 * vocabulary would leave that read-only view unable to label its own data.
 * `assertVerifiedVendor` is deliberately not imported here — keeping its call
 * sites at one-per-authoring-handler is what makes the eventual
 * `requireCapability('attestation.author')` swap mechanical.
 */

import { ListDataObjectsResponseSchema, type ListDataObjectsResponse } from '@aeci/shared';

import { getDb } from '../db/client';
import { json } from '../http';
import { listDataObjectTerms } from '../lib/data-object-vocabulary';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { sessionVendorId, type VendorContext } from './vendor-shared';

export function createListDataObjectsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    // The response does not depend on it, but call it anyway: it is the fail-loud
    // assertion that `requireVendor()` is actually mounted. Dropping it would let
    // a mis-registration ship an unauthenticated endpoint that still looked fine.
    sessionVendorId(c);

    const { db } = dbFor(c.env);

    // An unseeded vocabulary is an empty list, never a 500 — a fresh local D1
    // without `seed/data-objects.sql` applied must degrade the "add a data flow"
    // affordance, not take the whole dashboard tab down with it.
    const body: ListDataObjectsResponse = { data_objects: await listDataObjectTerms(db) };
    validateResponseInDev(c.env, () => ListDataObjectsResponseSchema.parse(body));
    return json(body);
  };
}

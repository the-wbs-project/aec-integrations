/**
 * The create's duplicate warning, read before the create (AECI-1953 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.2) — Drizzle/D1.
 *
 *   GET /api/vendor/integrations/possible-duplicates?product_id=&counterpart_product_id=
 *
 * The portal's "Add an integration" form calls it when the vendor picks the other
 * product, so the vendor sees a likely duplicate while it can still claim or open
 * the existing row instead of adding a copy.
 *
 * ── ONE RULE, THE CREATE'S OWN ──────────────────────────────────────────────
 * The same endpoint checks as `POST /api/vendor/integrations` (the caller's
 * promoted product, a promoted counterpart, the same `404` for every miss, a `400`
 * for equal ids) and the same `findPossibleDuplicates` call. So this read and the
 * create's `201` can never disagree about what counts as a duplicate.
 *
 * ── A READ, AND NOTHING NEW EXPOSED ─────────────────────────────────────────
 * `requireVendor()` only. Reads are never rate-limited (`waf-rate-limits.md` §6).
 * No audit row, no purge, no cache tag: `json()` stamps `private, no-store`, as on
 * `GET /api/vendor/integrations`. Every match sits on the caller's own product, so
 * that list already shows the caller each row this one names.
 */

import { PossibleDuplicatesQuerySchema, PossibleDuplicatesResponseSchema } from '@aeci/shared';

import { getDb } from '../db/client';
import { notFoundError } from '../errors';
import { json } from '../http';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { findPossibleDuplicates, visibleProduct } from '../lib/integration-create';
import { sessionVendorId, type VendorContext } from './vendor-shared';

export function createPossibleDuplicatesHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);

    // 1. Shape: 400 for a missing or malformed id, an unknown key, equal ids.
    const query = PossibleDuplicatesQuerySchema.parse(c.req.query());
    const ownId = query.product_id;
    const otherId = query.counterpart_product_id;

    // 2. The create's endpoint check. Same 404 for "not yours", "not promoted" and
    //    "no such id", so a vendor cannot probe which products exist.
    const [ownVisible, otherVisible] = await Promise.all([
      visibleProduct(db, ownId, vendorId),
      visibleProduct(db, otherId),
    ]);
    if (!ownVisible) throw notFoundError('product', { id: ownId });
    if (!otherVisible) throw notFoundError('product', { id: otherId });

    // 3. The create's own strong-match query.
    const body = {
      possible_duplicates: await findPossibleDuplicates(db, vendorId, ownId, otherId),
    };
    validateResponseInDev(c.env, () => PossibleDuplicatesResponseSchema.parse(body));
    return json(body);
  };
}

/**
 * The connector seat's mapping edit (AECI-724 — `STAGE_2_SPEC.md` §8.9(1)–(2),
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2).
 *
 *   PATCH /api/vendor/connector-stub-mappings/:id — behind `requireVendor()` and
 *   `rateLimit('write')`.
 *
 * The same edit as `PATCH /api/admin/connector-stub-mappings/:id`, reached by the seat
 * holder of the vendor that owns the catalogue's connector product. Everything after the
 * ownership check is `lib/connector-mapping-edit.ts`, shared with the admin route.
 *
 * ── AUTHZ IS A SEAT PLUS OWNERSHIP, NOTHING ELSE ─────────────────────────────
 * §8.9(2): the connector seat is **not** a `vendor_entitlements` row. So there is no
 * `requireCapability`, no capability id and no entitlement read here. `requireVendor()`
 * establishes `profiles.role = 'vendor_admin'` + `profiles.vendor_id`, and the handler
 * proves that vendor holds the catalogue's connector product through `product_vendors`,
 * and that the product is `connector`-role. A zero-entitlement seat resolves to
 * `unclaimed` with zero capabilities and still passes, which is the point.
 *
 * ── ORDER ───────────────────────────────────────────────────────────────────
 * 404 first, in its own wave, for an unknown id AND for a mapping on a catalogue the
 * caller does not own (the AECI-520 non-disclosure rule: a vendor must not be able to
 * probe another vendor's catalogue). Only then 409 `CATALOG_REVIEW_MANAGED`, then the
 * body. An owner learning its own catalogue is not handed over yet discloses nothing.
 */

import {
  ConnectorStubMappingEditResponseSchema,
  UpdateConnectorStubMappingSchema,
  connectorVendorDecider,
} from '@aeci/shared';
import { and, eq } from 'drizzle-orm';

import { getDb } from '../db/client';
import { productVendors, products, vendors } from '../db/schema';
import { ApiError } from '../errors';
import { json } from '../http';
import { auditActorType } from '../lib/authz';
import {
  applyMappingEdit,
  assertVendorManaged,
  loadMappingForEdit,
  mappingNotFound,
} from '../lib/connector-mapping-edit';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  AUDIT_SOURCE,
  afterVendorWrite,
  parseJsonBody,
  sessionVendorId,
  type VendorContext,
} from './vendor-shared';

export function createVendorUpdateConnectorStubMappingHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing mapping id', { field: 'id' });
    }
    const { db } = writeDb(c, dbFor);

    // ── 1. Ownership, in its own wave: every miss is the same 404 ───────────
    const target = await loadMappingForEdit(db, id);
    if (!target) throw mappingNotFound(id);
    const [ownership, vendor] = await Promise.all([
      db
        .select({ productId: productVendors.productId })
        .from(productVendors)
        .innerJoin(products, eq(products.id, productVendors.productId))
        .where(
          and(
            eq(productVendors.productId, target.connectorProductId),
            eq(productVendors.vendorId, vendorId),
            eq(products.productRole, 'connector'),
          ),
        )
        .limit(1),
      db.query.vendors.findFirst({ columns: { slug: true }, where: eq(vendors.id, vendorId) }),
    ]);
    if (ownership.length === 0 || !vendor) throw mappingNotFound(id);

    // ── 2. The lane must be handed over ───────────────────────────────────────
    assertVendorManaged(target);

    // ── 3. The edit ─────────────────────────────────────────────────────────────
    const input = await parseJsonBody(c, UpdateConnectorStubMappingSchema);
    const result = await applyMappingEdit(db, target, input, {
      userId: session.userId,
      actorType: auditActorType(session),
      decidedBy: connectorVendorDecider(vendor.slug),
      auditSource: AUDIT_SOURCE,
      vendorId,
    });

    if (result.auditEntries.length > 0) {
      afterVendorWrite(c, result.purgeTags, result.auditEntries);
    }

    validateResponseInDev(c.env, () => {
      ConnectorStubMappingEditResponseSchema.parse(result.response);
    });
    return json(result.response);
  };
}

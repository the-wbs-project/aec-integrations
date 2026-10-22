/**
 * An owner adds a product to its company (AECI-1424; `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §4.8, `API_CONTRACTS.md` §6.14, ADR 0042 amendment 2026-10-22) — Drizzle/D1.
 *
 *   POST /api/vendor/products  → 201 `{ product, possible_duplicates }`
 *
 * Once a company owns its record, promote sends a new product for it only once, as a
 * proposal (ruling Q5). A declined proposal, one that cannot be accepted, or a product
 * AECi never found had no path to the catalog. This is that path (ruled 2026-10-20 on
 * AECI-1341, option A).
 *
 * ── GATES, IN ORDER ──────────────────────────────────────────────────────────
 * `requireVendor()` and `rateLimit('write')` at registration, the body (`.strict()`),
 * then `requireSeatOwner()`: adding a product is the owner's act, the proposal accept's
 * rule, so a member seat gets `403`. Then the vendor must own its record
 * (`409 VENDOR_NOT_OWNED`): an unowned company's products come through promote, and a
 * product made here must be owned from its first statement. No capability gate on the
 * act. The fields are Free fields only (ruled 2026-10-22), checked against
 * `PRODUCT_FIELD_CAPABILITIES` at the new product's tier as the edit route checks them.
 *
 * ── WHAT IT WRITES ──────────────────────────────────────────────────────────
 * One batch: the ownership sentinel (a "Return records to AECi" that commits between
 * the read and the batch aborts it), the product and its joins through
 * `planProductInsert` (shared with the proposal accept), and the `product.created` audit
 * row (`metadata.reason = 'vendor-create'`). The product is promoted and
 * vendor-maintained from birth, joined to the caller's vendor as primary, and so owned:
 * promote refuses it from then on (`BLOCKED_PRODUCT_REASON`). Taxonomy is find-only and
 * strict: an unknown category slug is a `400`, and nothing touches a `taxonomy_*` table.
 *
 * Same-name products of the company and its open proposals are returned in
 * `possible_duplicates` and recorded in the audit row. The create is never refused for
 * them (ruled 2026-10-22, the §4.7.2 rule).
 *
 * ── AFTER COMMIT ────────────────────────────────────────────────────────────
 * The promote purge set for a created product (`cacheTagsForPromote`), a by-id Algolia
 * sync of the product and the vendor behind promote's watchdog, and the audit forward.
 * No re-crawl buffer: a new product holds no license (AECI-1186), as on an accept. No
 * ownership message to the review app (ruled 2026-10-22): the product has no review-app
 * record until the mirror (AECI-1413), and the next whole-record sync from any other
 * trigger lists it anyway.
 *
 * ── LIVE REVALIDATION ───────────────────────────────────────────────────────
 * No new scope. The product joins the caller's vendor, so the `products` cursor moves
 * and every open portal refetches `/me`.
 */

import {
  CreateVendorProductResponseSchema,
  CreateVendorProductSchema,
  type CreateVendorProductResponse,
  type PromoteResponse,
  type VendorProductDuplicate,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { PRODUCT_FIELD_CAPABILITIES, type ProductEditableField } from '@aeci/shared/entitlements';
import { eq, sql } from 'drizzle-orm';

import { getDb } from '../db/client';
import {
  productProposals,
  products,
  productVendors,
  taxonomyCategories,
  vendors,
} from '../db/schema';
import { ApiError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType, productTier } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { isReleaseRaceError } from '../lib/license-release-requests';
import { openProposalsFor, proposalVendorOwnedSentinel } from '../lib/product-proposals';
import { dispatchOwnerWriteSearch, syncOwnerWriteSearch } from './integration-retire-write';
import { assertStoredLogo } from './logos';
import { generateSlug, isSlugUniqueViolation } from './promote';
import { cacheTagsForPromote } from './promote-cache-tags';
import { assertFieldsEntitled, resolveTerms } from './vendor';
import { planProductInsert } from './vendor-proposal-accept';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  parseJsonBody,
  requireSeatOwner,
  sessionVendorId,
  type VendorContext,
  vendorAuditEntry,
} from './vendor-shared';

const OWNER_ONLY = 'Only a vendor account owner can add a product';

/** `metadata.reason` on the create's `product.created` row. */
export const VENDOR_PRODUCT_CREATE_REASON = 'vendor-create';

const vendorNotOwned = () =>
  new ApiError(
    409,
    'VENDOR_NOT_OWNED',
    'Your company does not own its records, so a product cannot be added from here. Contact us to add it.',
  );

/** The duplicate key: trimmed, case folded. Never an ordering, so no collation applies. */
const nameKey = (name: string) => name.trim().toLocaleLowerCase('en-US');

/** `POST /api/vendor/products`. */
export function createCreateVendorProductHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const payload = await parseJsonBody(c, CreateVendorProductSchema);
    const { db } = writeDb(c, dbFor);
    await requireSeatOwner(db, session.userId, vendorId, OWNER_ONLY);

    const vendor = await db.query.vendors.findFirst({
      columns: { slug: true, ownedAt: true },
      where: eq(vendors.id, vendorId),
    });
    if (!vendor?.ownedAt) throw vendorNotOwned();

    const productId = crypto.randomUUID();
    // Defensive: the schema carries Free fields only. This keeps the create on the edit
    // route's rule if a field is ever added to the body.
    assertFieldsEntitled(
      payload,
      (field) => PRODUCT_FIELD_CAPABILITIES[field as ProductEditableField],
      productTier(session, productId),
    );

    const [categoryTerms, slugRows, sameVendorProducts, openProposals] = await Promise.all([
      resolveTerms(db, taxonomyCategories, payload.category_slugs ?? [], 'category_slugs'),
      // Promote's slug preload: the whole column, for collision-free generation. A
      // racing insert of the same slug is the `409 SLUG_CONFLICT` below.
      db.select({ slug: products.slug }).from(products),
      db
        .select({ id: products.id, slug: products.slug, name: products.name })
        .from(products)
        .innerJoin(productVendors, eq(productVendors.productId, products.id))
        .where(eq(productVendors.vendorId, vendorId)),
      db
        .select({
          id: productProposals.id,
          name: sql<string | null>`json_extract(${productProposals.payload}, '$.product.name')`,
        })
        .from(productProposals)
        .where(openProposalsFor(vendorId)),
    ]);
    if (payload.logo_url !== undefined) await assertStoredLogo(c.env, payload.logo_url);

    const key = nameKey(payload.name);
    const possibleDuplicates: VendorProductDuplicate[] = [
      ...sameVendorProducts
        .filter((p) => nameKey(p.name) === key)
        .map((p) => ({ kind: 'product' as const, id: p.id, name: p.name, slug: p.slug })),
      ...openProposals
        .filter((p) => p.name !== null && nameKey(p.name) === key)
        .map((p) => ({ kind: 'proposal' as const, id: p.id, name: p.name as string })),
    ];

    const slug = generateSlug(payload.name, new Set(slugRows.map((r) => r.slug)), vendor.slug);
    const now = new Date().toISOString();

    const audit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: 'product.created',
      entityType: 'product',
      entityId: productId,
      productId,
      afterState: {
        name: payload.name,
        slug,
        vendor_ids: [vendorId],
        maintained_by: 'vendor',
        last_reviewed_at: now,
        fields: Object.keys(payload).sort(),
        ...(payload.category_slugs ? { category_slugs: [...payload.category_slugs] } : {}),
      },
      metadata: {
        source: AUDIT_SOURCE,
        reason: VENDOR_PRODUCT_CREATE_REASON,
        vendorId,
        possibleDuplicateIds: possibleDuplicates.map((d) => d.id),
      },
    };

    const stmts: BatchStmt[] = [
      proposalVendorOwnedSentinel(db, vendorId),
      ...planProductInsert(db, {
        productId,
        slug,
        name: payload.name,
        now,
        columns: {
          ...(payload.description !== undefined ? { description: payload.description } : {}),
          ...(payload.website !== undefined ? { website: payload.website } : {}),
          ...(payload.logo_url !== undefined
            ? { logoUrl: payload.logo_url, logoSource: 'vendor' as const }
            : {}),
        },
        links: [{ vendorId, isPrimary: true }],
        terms: { categories: categoryTerms, audiences: [], phases: [], trades: [], hosts: [] },
      }),
      auditInsert(db, vendorAuditEntry(c, audit)),
    ];

    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (isSlugUniqueViolation(error)) {
        throw new ApiError(
          409,
          'SLUG_CONFLICT',
          'Another product took this name at the same moment. Try again.',
          { details: { target: ['slug'] } },
        );
      }
      // The only sentinel in the batch is the ownership one.
      if (isReleaseRaceError(error)) throw vendorNotOwned();
      throw error;
    }

    // The promote purge set for a created product, from the same deriver.
    const purgeShape: PromoteResponse = {
      vendors: [{ ref: vendorId, id: vendorId, slug: vendor.slug, operation: 'updated' }],
      product: { ref: productId, id: productId, slug, operation: 'created' },
      integrations: [],
      taxonomy: {
        categories: categoryTerms.map((t) => ({ ...t, operation: 'reused' as const })),
        audiences: [],
        phases: [],
        trades: [],
      },
      skipped: [],
      preserved: [],
      unresolvedLinks: [],
    };
    afterVendorWrite(c, cacheTagsForPromote(purgeShape), [audit]);
    dispatchOwnerWriteSearch(
      c,
      'vendor-product-create-algolia',
      syncOwnerWriteSearch(
        c,
        db,
        { products: [productId], vendors: [vendorId], integrations: [] },
        'aeci.api.vendor.product_create.algolia_sync_failed',
      ),
    );

    const body: CreateVendorProductResponse = {
      product: { id: productId, slug, name: payload.name },
      possible_duplicates: possibleDuplicates,
    };
    validateResponseInDev(c.env, () => CreateVendorProductResponseSchema.parse(body));
    return json(body, { status: 201 });
  };
}

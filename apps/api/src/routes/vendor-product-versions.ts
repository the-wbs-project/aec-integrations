/**
 * Product-version authoring (`/api/vendor/products/:id/versions`, AECI-607 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §8.3) — Drizzle/D1.
 *
 *   GET    /api/vendor/products/:id/versions             — the ordered list.
 *   POST   /api/vendor/products/:id/versions             — create one.
 *   PATCH  /api/vendor/products/:id/versions/:versionId  — edit one.
 *   DELETE /api/vendor/products/:id/versions/:versionId  — remove one (204).
 *
 * A `product_versions` row is what AECI-303's "source-version × target-version"
 * diff selects on; the attestation FKs (`introduced_version_id` /
 * `deprecated_version_id`) are written by §5/AECI-301, not here. Promote does not
 * ingest versions at launch (§8.3 / §11), so this surface is the only writer.
 *
 * ── TWO GATES, AND THE ORDER IS LOAD-BEARING ────────────────────────────────
 * 1. **Ownership → 404.** `requireOwnedProduct` (`./vendor-shared.ts`) runs FIRST,
 *    in its own wave, before the body is even looked at. A product the caller's
 *    vendor does not own is indistinguishable from one that does not exist — the
 *    AECI-520 non-disclosure rule.
 * 2. **Capability → 403 `ENTITLEMENT_REQUIRED`**, on the WRITES only:
 *    `requireCapability(c, 'attestation.author')` over the session's tier
 *    (AECI-623; `STAGE_2_PAID_TIERS_SPEC.md` §3.3(a)). Versions exist only to
 *    stamp attestations, so they share that capability. `GET` is not gated, so
 *    the §6 dashboard can render the tab read-only and explain why rather than
 *    403-ing a vendor out of its own data.
 *
 * Ownership is checked before the capability so a NON-owner without it still
 * gets a flat 404 and learns nothing about the product.
 *
 * ── ORDERING ────────────────────────────────────────────────────────────────
 * Never by `label` (`'2026.10' < '2026.9'` as strings) and never by the nullable
 * `released_at`. `sort_key` is the ordering, `@aeci/shared/version-sort` derives
 * it from the label on create, and the vendor can override it for labels the
 * derivation cannot read. The SQL `ORDER BY` is `VERSION_ORDER`
 * (`../lib/drizzle-helpers`) — shared with the product-PAIR read that feeds
 * AECI-303's selectors — and it must stay in lockstep with
 * `compareProductVersions`.
 *
 * ── WRITE MECHANICS ─────────────────────────────────────────────────────────
 * One `db.batch([...])` per write carrying the mutation and its `audit_log` row
 * (the §26.1 invariant — D1 has no interactive transactions). Post-commit, the
 * Cache-Tag purge and the §26.5 forward run in `waitUntil`, both best-effort.
 * Ids are generated up front, never read back from `db.batch()`.
 *
 * Since AECI-981 each batch carries a SECOND mutation and a second audit row: the
 * maintenance transfer onto the parent `products` row (§13.9). It is a separate
 * statement rather than a fold because this batch's own rows are
 * `product_versions`, a different entity, and its audit row must name the entity
 * it actually changed.
 *
 * It sets no `updated_at` of its own, but `updatedAt()` is `.$onUpdate(...)`, so
 * the column moves anyway and the product joins the next nightly Algolia sweep.
 * That upsert is redundant — the index carries neither maintenance column — and
 * it is still the right trade: suppressing it means writing the stale value back,
 * which would make the row's last-modified wrong for every other reader.
 */

import {
  CreateProductVersionSchema,
  ListProductVersionsResponseSchema,
  ProductVersionResponseSchema,
  UpdateProductVersionSchema,
  type ListProductVersionsResponse,
  type ProductVersion,
  type ProductVersionResponse,
} from '@aeci/shared';
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import { deriveVersionSortKey } from '@aeci/shared/version-sort';
import { and, eq } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { productVersions } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json, noContent } from '../http';
import { auditInsert, type BatchTuple } from '../lib/audit';
import { auditActorType, requireCapability } from '../lib/authz';
import { VERSION_ORDER } from '../lib/drizzle-helpers';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { readPairCounterpartSlugs } from '../lib/product-pair-slugs';
import { publicSiteBase } from '../lib/public-urls';
import { productVersionRecrawl } from './vendor-recrawl';
import {
  AUDIT_SOURCE,
  afterVendorWrite,
  parseJsonBody,
  recrawlEnabled,
  productMaintenanceTransfer,
  requireOwnedProduct,
  sessionVendorId,
  type VendorContext,
  type VendorRecrawl,
} from './vendor-shared';

type ProductVersionRow = typeof productVersions.$inferSelect;

function toProductVersion(row: ProductVersionRow): ProductVersion {
  return {
    id: row.id,
    product_id: row.productId,
    label: row.label,
    released_at: row.releasedAt,
    sunset_at: row.sunsetAt,
    sort_key: row.sortKey,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/**
 * The tag a version write invalidates.
 *
 * `product:{slug}` alone, and it is enough: the pair page embeds
 * `product:{slug}` for BOTH of its endpoints (`CACHE_STRATEGY.md` §2), so this
 * purge also drops every pair page the product appears on — which is where
 * AECI-303's version selectors will render. `index:products` is deliberately NOT
 * emitted: versions never appear on the catalog, so purging it would evict a
 * 300s-TTL page for nothing.
 */
function versionEditTags(productSlug: string): string[] {
  return [`product:${productSlug}`];
}

/**
 * The URLs a version write asks the search engines to re-fetch (AECI-944).
 *
 * The same pages `versionEditTags` purges, named explicitly rather than reached
 * through an embedded tag — a crawler has no tag graph. That means a D1 read for
 * the counterpart slugs, because a pair-page URL is built from two product slugs
 * and this handler holds one.
 *
 * **Resolved after the commit and never awaited inline.** The promise is handed
 * to `afterVendorWrite`, which settles it inside `waitUntil` alongside the
 * inserts it feeds, so a slow or failing read never delays the response. A
 * rejection resolves to "no pair pages", which is the safe direction: the write
 * is committed, the edge is purged, and the sitemap's `<lastmod>` is still the
 * passive discovery path (§20.5 step 5).
 *
 * Returns `undefined` off a public environment, so a gated tier pays nothing —
 * `recrawlEnabled` is checked BEFORE the read rather than inside the buffer,
 * matching the product-edit handler.
 */
function versionEditRecrawl(
  c: VendorContext,
  db: Db,
  productId: string,
  productSlug: string,
): Promise<VendorRecrawl> | undefined {
  const base = recrawlEnabled(c.env) ? publicSiteBase(c.env) : null;
  if (!base) return undefined;
  return readPairCounterpartSlugs(db, productId)
    .catch(() => [] as string[])
    .then((counterpartSlugs) => productVersionRecrawl(base, productSlug, counterpartSlugs));
}

/** The path's version id. Present by routing, but Hono types it optional. */
function versionIdParam(c: VendorContext): string {
  const versionId = c.req.param('versionId');
  if (!versionId) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Missing version id', { field: 'versionId' });
  }
  return versionId;
}

/** The path's product id. */
function productIdParam(c: VendorContext): string {
  const productId = c.req.param('id');
  if (!productId) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Missing product id', { field: 'id' });
  }
  return productId;
}

/**
 * Load a version, requiring it to belong to `productId`.
 *
 * The product-scoping is the security half: without it a vendor that owns ANY
 * product could edit any version by id. A mismatch answers exactly as a missing
 * row does, so the response cannot be used to test whether an id exists
 * elsewhere.
 */
async function loadOwnedVersion(
  db: Db,
  productId: string,
  versionId: string,
): Promise<ProductVersionRow> {
  const row = await db.query.productVersions.findFirst({
    where: and(eq(productVersions.id, versionId), eq(productVersions.productId, productId)),
  });
  if (!row) throw notFoundError('product_version', { id: versionId });
  return row;
}

/**
 * Reject a label already used on this product, BEFORE the batch opens.
 *
 * `product_versions_label_key` is the actual guarantee; this read exists so the
 * vendor gets a `400` naming the field instead of a constraint violation
 * surfacing as a 500. Same discipline as taxonomy-term resolution on
 * `PATCH /api/vendor/products/:id`: resolve everything that can fail before
 * anything is written, so nothing is half-applied.
 */
async function assertLabelFree(
  db: Db,
  productId: string,
  label: string,
  exceptVersionId?: string,
): Promise<void> {
  const clash = await db.query.productVersions.findFirst({
    columns: { id: true },
    where: and(eq(productVersions.productId, productId), eq(productVersions.label, label)),
  });
  if (clash && clash.id !== exceptVersionId) {
    throw new ApiError(400, 'VALIDATION_FAILED', `Version "${label}" already exists`, {
      field: 'label',
    });
  }
}

// ─── GET /api/vendor/products/:id/versions ───────────────────────────────────

export function createListProductVersionsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const productId = productIdParam(c);
    const { db } = dbFor(c.env);

    // Ownership only — reading your own product's versions is not the gated
    // capability, authoring is. An unverified vendor sees an accurate (probably
    // empty) list rather than a 403 it cannot act on.
    await requireOwnedProduct(db, vendorId, productId);

    const rows = await db.query.productVersions.findMany({
      where: eq(productVersions.productId, productId),
      orderBy: VERSION_ORDER,
    });

    const body: ListProductVersionsResponse = { versions: rows.map(toProductVersion) };
    validateResponseInDev(c.env, () => ListProductVersionsResponseSchema.parse(body));
    return json(body);
  };
}

// ─── POST /api/vendor/products/:id/versions ──────────────────────────────────

export function createProductVersionHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const productId = productIdParam(c);
    const { db } = writeDb(c, dbFor);

    // Ownership (404) settles before anything else, then the capability gate
    // (403 ENTITLEMENT_REQUIRED). Body parsing comes after both, so a malformed body from a
    // non-owning vendor still answers 404 rather than leaking a 400.
    const { product } = await requireOwnedProduct(db, vendorId, productId);
    requireCapability(c, 'attestation.author');

    const payload = await parseJsonBody(c, CreateProductVersionSchema);
    await assertLabelFree(db, productId, payload.label);

    const now = new Date().toISOString();
    const row: ProductVersionRow = {
      id: crypto.randomUUID(),
      productId,
      label: payload.label,
      releasedAt: payload.released_at ?? null,
      sunsetAt: payload.sunset_at ?? null,
      // Omitted → derived from the label. Explicit → the vendor's override, for
      // labels the derivation reads as 0 ("LTS", "Fall release").
      sortKey: payload.sort_key ?? deriveVersionSortKey(payload.label),
      createdAt: now,
      updatedAt: now,
    };

    const auditEntry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: 'product_version.created',
      entityType: 'product_version',
      entityId: row.id,
      afterState: toProductVersion(row),
      metadata: { source: AUDIT_SOURCE, vendorId, productId, fields: Object.keys(payload) },
    };

    // AECI-981: authoring a version is a vendor-authorized catalog write, so it
    // transfers maintenance of the PARENT product. It gets its own statement and
    // its own audit row because this batch has no `products` write to fold into —
    // the rows above are `product_versions`, a different entity. Same shape as
    // `vendorMaintainedFlip` in `vendor-attestations.ts`.
    const maintenance = productMaintenanceTransfer(
      db,
      session,
      auditActorType(session),
      product,
      now,
      { vendorId },
    );

    await db.batch([
      db.insert(productVersions).values(row),
      maintenance.stmt,
      auditInsert(db, auditEntry),
      auditInsert(db, maintenance.audit),
    ] as BatchTuple);

    afterVendorWrite(
      c,
      versionEditTags(product.slug),
      // BOTH rows, so the §26.5 forward carries the maintenance transfer too —
      // same shape as `vendor-attestations.ts` (AECI-981). `logBatchToPosthog`
      // sends the whole list in ONE request, so the second entry costs no extra
      // Worker connection (AECI-666).
      [auditEntry, maintenance.audit],
      versionEditRecrawl(c, db, productId, product.slug),
      db,
    );

    const body: ProductVersionResponse = { version: toProductVersion(row) };
    validateResponseInDev(c.env, () => ProductVersionResponseSchema.parse(body));
    return json(body, { status: 201 });
  };
}

// ─── PATCH /api/vendor/products/:id/versions/:versionId ──────────────────────

export function createUpdateProductVersionHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const productId = productIdParam(c);
    const versionId = versionIdParam(c);
    const { db } = writeDb(c, dbFor);

    const { product } = await requireOwnedProduct(db, vendorId, productId);
    requireCapability(c, 'attestation.author');

    const payload = await parseJsonBody(c, UpdateProductVersionSchema);
    const before = await loadOwnedVersion(db, productId, versionId);

    const label = payload.label ?? before.label;
    if (payload.label !== undefined && payload.label !== before.label) {
      await assertLabelFree(db, productId, payload.label, versionId);
    }

    // `sort_key` semantics, and the asymmetry is deliberate (see the schema
    // comment): ABSENT leaves the key exactly where it is — even when the label
    // moves — because re-deriving would silently discard an override the vendor
    // set on purpose. Explicit `null` is the "recompute from the (new) label"
    // instruction. A number sets it outright.
    const sortKey =
      payload.sort_key === undefined
        ? before.sortKey
        : (payload.sort_key ?? deriveVersionSortKey(label));

    const changes: Partial<ProductVersionRow> = { label, sortKey };
    if (payload.released_at !== undefined) changes.releasedAt = payload.released_at;
    if (payload.sunset_at !== undefined) changes.sunsetAt = payload.sunset_at;

    // Stamped explicitly rather than left to `$onUpdate` so the response can be
    // built from data already in hand, and kept out of the audit diff below —
    // the vendor did not edit a system column.
    const now = new Date().toISOString();
    const writeColumns = { ...changes, updatedAt: now };
    const after: ProductVersionRow = { ...before, ...writeColumns };

    const auditEntry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: 'product_version.updated',
      entityType: 'product_version',
      entityId: versionId,
      beforeState: toProductVersion(before),
      afterState: toProductVersion({ ...after, updatedAt: before.updatedAt }),
      // Zod strips unknown keys and omits absent optionals, so the payload's own
      // keys ARE the list of fields the vendor sent.
      metadata: { source: AUDIT_SOURCE, vendorId, productId, fields: Object.keys(payload) },
    };

    // AECI-981 — see the create handler.
    const maintenance = productMaintenanceTransfer(
      db,
      session,
      auditActorType(session),
      product,
      now,
      { vendorId },
    );

    await db.batch([
      db.update(productVersions).set(writeColumns).where(eq(productVersions.id, versionId)),
      maintenance.stmt,
      auditInsert(db, auditEntry),
      auditInsert(db, maintenance.audit),
    ] as BatchTuple);

    afterVendorWrite(
      c,
      versionEditTags(product.slug),
      // BOTH rows, so the §26.5 forward carries the maintenance transfer too —
      // same shape as `vendor-attestations.ts` (AECI-981). `logBatchToPosthog`
      // sends the whole list in ONE request, so the second entry costs no extra
      // Worker connection (AECI-666).
      [auditEntry, maintenance.audit],
      versionEditRecrawl(c, db, productId, product.slug),
      db,
    );

    const body: ProductVersionResponse = { version: toProductVersion(after) };
    validateResponseInDev(c.env, () => ProductVersionResponseSchema.parse(body));
    return json(body);
  };
}

// ─── DELETE /api/vendor/products/:id/versions/:versionId ─────────────────────

export function createDeleteProductVersionHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const productId = productIdParam(c);
    const versionId = versionIdParam(c);
    const { db } = writeDb(c, dbFor);

    const { product } = await requireOwnedProduct(db, vendorId, productId);
    requireCapability(c, 'attestation.author');

    const before = await loadOwnedVersion(db, productId, versionId);

    const auditEntry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: 'product_version.deleted',
      entityType: 'product_version',
      entityId: versionId,
      beforeState: toProductVersion(before),
      metadata: { source: AUDIT_SOURCE, vendorId, productId },
    };

    // Any attestation stamped with this version degrades to "no version data"
    // via `ON DELETE SET NULL` — the vendor's assertion survives and falls back
    // to the coarse `introduced_at` / `deprecated_at` dates (§8.2). Deleting a
    // version is not a way to erase an attestation.
    // AECI-981 — see the create handler. Retiring a version is as much an act of
    // maintenance as publishing one, so a delete transfers too.
    const maintenance = productMaintenanceTransfer(
      db,
      session,
      auditActorType(session),
      product,
      new Date().toISOString(),
      { vendorId },
    );

    await db.batch([
      db.delete(productVersions).where(eq(productVersions.id, versionId)),
      maintenance.stmt,
      auditInsert(db, auditEntry),
      auditInsert(db, maintenance.audit),
    ] as BatchTuple);

    afterVendorWrite(
      c,
      versionEditTags(product.slug),
      // BOTH rows, so the §26.5 forward carries the maintenance transfer too —
      // same shape as `vendor-attestations.ts` (AECI-981). `logBatchToPosthog`
      // sends the whole list in ONE request, so the second entry costs no extra
      // Worker connection (AECI-666).
      [auditEntry, maintenance.audit],
      versionEditRecrawl(c, db, productId, product.slug),
      db,
    );

    return noContent();
  };
}

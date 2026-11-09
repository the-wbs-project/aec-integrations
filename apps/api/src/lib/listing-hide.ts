/**
 * The listing hide's reads and batch builders (AECI-1238, ADR 0052,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.6). The routes are `routes/admin-listing-hide.ts`.
 *
 * ── THE RULES ────────────────────────────────────────────────────────────────
 *  1. **A column, never a delete.** A hide sets `hidden_at` and `hidden_hide_id` on
 *     the record and writes a `listing_hides` row. A restore clears the two columns
 *     and stamps `restored_*` on the row. Nothing else on the record moves, so a
 *     restore is lossless.
 *  2. **A company hide covers every joined product** (ruled 2026-11-09), shared with
 *     a live company or not. Each product not already hidden gets a CHILD row
 *     (`parent_id` = the company's row). A product already hidden by its own hide
 *     keeps it and gets no child row.
 *  3. **A company restore clears only its child rows.** A child product still joined
 *     to another hidden company is re-homed under that company's hide (a new child
 *     row), never shown, so no live product ever sits under a hidden company.
 *  4. **A product restore refuses** while its active hide is a child row, or while
 *     any joined company is hidden: `409 LISTING_HIDDEN_WITH_VENDOR`.
 *  5. **One batch.** The log rows, the guarded UPDATEs (each with a `changes() = 0`
 *     sentinel), the audit rows, the notices and the `integration_count` recomputes
 *     of every counterpart commit together.
 */

import {
  ApiErrorCode,
  REASON_VISIBILITY_VENDOR,
  vendorVisibleReasonMetadata,
  type AdminListingHide,
  type AdminListingHideBody,
  type ListingHideEntityType,
  type ListingHideKind,
  type VendorListingHidden,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  connectorEvidencedPairs,
  integrations,
  listingHides,
  productVendors,
  products,
  vendors,
} from '../db/schema';
import { ApiError } from '../errors';
import { aeciOverrideNotificationAudit } from './aeci-override-notifications';
import { auditInsert, type BatchStmt } from './audit';
import type { VendorAuditStamp } from './audit-vendor';
import { ONE_ROW } from './integration-claims';
import { integrationCountRecomputeStmts } from './recompute-counts';

/** Ids per `IN (…)` read. D1 caps bound parameters per query at 100. */
const ID_CHUNK = 80;

/** The race token every listing-hide sentinel raises. */
const LISTING_HIDE_RACE_TOKEN = 'listing-hide-race';

/** `metadata.source` on every audit row a hide or restore writes. */
export const LISTING_HIDE_AUDIT_SOURCE = 'admin-moderation';

export type ListingHideMode = 'hide' | 'restore';

type Actor = { actorId: string | null; actorType: AuditLogEntry['actorType'] };

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += ID_CHUNK) out.push(items.slice(i, i + ID_CHUNK));
  return out;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export function listingHiddenError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.LISTING_HIDDEN,
    'This listing is already hidden from the public site.',
  );
}

export function listingNotHiddenError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.LISTING_NOT_HIDDEN,
    'This listing is on the public site, so there is nothing to restore.',
  );
}

export function listingHiddenWithVendorError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.LISTING_HIDDEN_WITH_VENDOR,
    "This product is hidden with its company. Restore the company's listing instead.",
  );
}

export function listingChangedError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.LISTING_CHANGED_WHILE_SAVING,
    'This listing changed while you were saving. Reload and try again.',
  );
}

/** A batch statement that aborts the batch when the UPDATE before it changed no row. */
function raceSentinel(db: Db) {
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json(${LISTING_HIDE_RACE_TOKEN}) END` })
    .from(ONE_ROW);
}

/** True for the error {@link raceSentinel} raises, in D1 or SQLite. */
export function isListingHideRaceError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/malformed JSON/i.test(text) || text.includes(LISTING_HIDE_RACE_TOKEN)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export type ListingHideRow = typeof listingHides.$inferSelect;

/** One record as a hide or restore reads it. */
export interface ListingRecord {
  id: string;
  slug: string;
  name: string;
  hiddenAt: string | null;
  hiddenHideId: string | null;
  /** `vendors` only: the claimed test (`lib/claimed-vendors.ts`). */
  claimed?: boolean;
}

export async function loadVendorRecord(db: Db, id: string): Promise<ListingRecord | null> {
  const row = await db.query.vendors.findFirst({
    columns: {
      id: true,
      slug: true,
      companyName: true,
      hiddenAt: true,
      hiddenHideId: true,
      ownedAt: true,
      claimEndedAt: true,
    },
    where: eq(vendors.id, id),
  });
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.companyName,
    hiddenAt: row.hiddenAt,
    hiddenHideId: row.hiddenHideId,
    claimed: Boolean(row.ownedAt) && !row.claimEndedAt,
  };
}

export async function loadProductRecord(db: Db, id: string): Promise<ListingRecord | null> {
  const row = await db.query.products.findFirst({
    columns: { id: true, slug: true, name: true, hiddenAt: true, hiddenHideId: true },
    where: eq(products.id, id),
  });
  return row ?? null;
}

/** Every product joined to `vendorId` through `product_vendors`, sorted by id. */
export async function loadVendorProducts(db: Db, vendorId: string): Promise<ListingRecord[]> {
  return db
    .select({
      id: products.id,
      slug: products.slug,
      name: products.name,
      hiddenAt: products.hiddenAt,
      hiddenHideId: products.hiddenHideId,
    })
    .from(productVendors)
    .innerJoin(products, eq(products.id, productVendors.productId))
    .where(eq(productVendors.vendorId, vendorId))
    .orderBy(asc(products.id));
}

/** The claimed vendors joined to each product, other than `exceptVendorId`. Who a
 *  hide or restore of the product tells. */
export async function loadClaimedVendorsOf(
  db: Db,
  productIds: readonly string[],
  exceptVendorId: string | null,
): Promise<{ productId: string; vendorId: string }[]> {
  const out: { productId: string; vendorId: string }[] = [];
  for (const ids of chunks([...new Set(productIds)])) {
    const rows = await db
      .select({ productId: productVendors.productId, vendorId: productVendors.vendorId })
      .from(productVendors)
      .innerJoin(vendors, eq(vendors.id, productVendors.vendorId))
      .where(
        and(
          inArray(productVendors.productId, ids),
          exceptVendorId ? ne(productVendors.vendorId, exceptVendorId) : undefined,
          isNotNull(vendors.ownedAt),
          isNull(vendors.claimEndedAt),
        ),
      );
    out.push(...rows);
  }
  return out.sort((a, b) =>
    a.productId === b.productId
      ? a.vendorId < b.vendorId
        ? -1
        : 1
      : a.productId < b.productId
        ? -1
        : 1,
  );
}

/** For each product, the hidden companies joined to it other than `exceptVendorId`:
 *  `vendorId` and that company's active hide row. */
export async function loadOtherHiddenVendorsOf(
  db: Db,
  productIds: readonly string[],
  exceptVendorId: string | null,
): Promise<Map<string, { vendorId: string; hideId: string }>> {
  const out = new Map<string, { vendorId: string; hideId: string }>();
  for (const ids of chunks([...new Set(productIds)])) {
    const rows = await db
      .select({
        productId: productVendors.productId,
        vendorId: vendors.id,
        hideId: vendors.hiddenHideId,
      })
      .from(productVendors)
      .innerJoin(vendors, eq(vendors.id, productVendors.vendorId))
      .where(
        and(
          inArray(productVendors.productId, ids),
          exceptVendorId ? ne(productVendors.vendorId, exceptVendorId) : undefined,
          isNotNull(vendors.hiddenAt),
          isNotNull(vendors.hiddenHideId),
        ),
      )
      .orderBy(asc(vendors.id));
    for (const row of rows) {
      if (!out.has(row.productId) && row.hideId) {
        out.set(row.productId, { vendorId: row.vendorId, hideId: row.hideId });
      }
    }
  }
  return out;
}

/**
 * The integrations and evidenced pairs that touch any of `productIds` as source,
 * target or connector, and are not retired. Read BEFORE the batch, because after a
 * hide the live predicate drops them. What a hide changes besides the records: the
 * counts, the search records and the cached pages of every row here.
 */
export interface ListingFootprint {
  integrationIds: string[];
  /** Every endpoint and connector of a touching row: whose counts move. */
  productIds: string[];
  /** The slugs of those products, for their `product:` tags. */
  productSlugs: string[];
  /** Each touching row's endpoint pair, for the `pair:` tag and the re-crawl. */
  pairSlugs: [string, string][];
  /** The builders of the touching rows: their vendor records count them. */
  builderVendorIds: string[];
}

export async function loadListingFootprint(
  db: Db,
  productIds: readonly string[],
): Promise<ListingFootprint> {
  const integrationIds = new Set<string>();
  const touched = new Set<string>(productIds);
  const builders = new Set<string>();
  const pairs = new Map<string, [string, string]>();
  const ends: { a: string; b: string }[] = [];
  for (const ids of chunks([...new Set(productIds)])) {
    const [direct, evidenced] = await Promise.all([
      db
        .select({
          id: integrations.id,
          a: integrations.sourceProductId,
          b: integrations.targetProductId,
          via: integrations.poweredByProductId,
          builder: integrations.builtByVendorId,
        })
        .from(integrations)
        .where(
          and(
            isNull(integrations.retiredAt),
            or(
              inArray(integrations.sourceProductId, ids),
              inArray(integrations.targetProductId, ids),
              inArray(integrations.poweredByProductId, ids),
            ),
          ),
        ),
      db
        .select({
          id: connectorEvidencedPairs.id,
          a: connectorEvidencedPairs.productAId,
          b: connectorEvidencedPairs.productBId,
          via: connectorEvidencedPairs.connectorProductId,
          builder: connectorEvidencedPairs.builtByVendorId,
        })
        .from(connectorEvidencedPairs)
        .where(
          and(
            isNull(connectorEvidencedPairs.retiredAt),
            or(
              inArray(connectorEvidencedPairs.productAId, ids),
              inArray(connectorEvidencedPairs.productBId, ids),
              inArray(connectorEvidencedPairs.connectorProductId, ids),
            ),
          ),
        ),
    ]);
    for (const row of [...direct, ...evidenced]) {
      integrationIds.add(row.id);
      touched.add(row.a);
      touched.add(row.b);
      if (row.via) touched.add(row.via);
      if (row.builder) builders.add(row.builder);
      ends.push({ a: row.a, b: row.b });
    }
  }
  const slugById = new Map<string, string>();
  for (const ids of chunks([...touched])) {
    const rows = await db
      .select({ id: products.id, slug: products.slug })
      .from(products)
      .where(inArray(products.id, ids));
    for (const row of rows) slugById.set(row.id, row.slug);
  }
  for (const { a, b } of ends) {
    const sa = slugById.get(a);
    const sb = slugById.get(b);
    if (!sa || !sb) continue;
    const pair: [string, string] = sa <= sb ? [sa, sb] : [sb, sa];
    pairs.set(`${pair[0]}__${pair[1]}`, pair);
  }
  return {
    integrationIds: [...integrationIds].sort(),
    productIds: [...touched].sort(),
    productSlugs: [...new Set(slugById.values())].sort(),
    pairSlugs: [...pairs.values()],
    builderVendorIds: [...builders].sort(),
  };
}

/** The vendors joined to any of `productIds`, with their slugs: whose pages embed
 *  the products and whose records count them. */
export async function loadVendorsOfProducts(
  db: Db,
  productIds: readonly string[],
): Promise<{ id: string; slug: string }[]> {
  const out = new Map<string, string>();
  for (const ids of chunks([...new Set(productIds)])) {
    const rows = await db
      .selectDistinct({ id: vendors.id, slug: vendors.slug })
      .from(productVendors)
      .innerJoin(vendors, eq(vendors.id, productVendors.vendorId))
      .where(inArray(productVendors.productId, ids));
    for (const row of rows) out.set(row.id, row.slug);
  }
  return [...out].map(([id, slug]) => ({ id, slug }));
}

/** Vendor slugs by id, for the `vendor:` tags of the builders. */
export async function loadVendorSlugs(db: Db, ids: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const chunk of chunks([...new Set(ids)])) {
    const rows = await db
      .select({ slug: vendors.slug })
      .from(vendors)
      .where(inArray(vendors.id, chunk));
    out.push(...rows.map((row) => row.slug));
  }
  return out;
}

/** The active `listing_hides` row with this id, or `undefined`. */
export async function loadHideRow(db: Db, id: string | null): Promise<ListingHideRow | undefined> {
  if (!id) return undefined;
  return db.query.listingHides.findFirst({ where: eq(listingHides.id, id) });
}

/** The active child rows of a company hide, and the products they still hide. */
export async function loadChildHides(
  db: Db,
  parentId: string,
): Promise<{ hide: ListingHideRow; product: ListingRecord }[]> {
  const rows = await db
    .select({
      hide: listingHides,
      product: {
        id: products.id,
        slug: products.slug,
        name: products.name,
        hiddenAt: products.hiddenAt,
        hiddenHideId: products.hiddenHideId,
      },
    })
    .from(listingHides)
    .innerJoin(
      products,
      and(eq(products.id, listingHides.entityId), eq(products.hiddenHideId, listingHides.id)),
    )
    .where(
      and(
        eq(listingHides.parentId, parentId),
        eq(listingHides.entityType, 'product'),
        isNull(listingHides.restoredAt),
      ),
    )
    .orderBy(asc(products.id));
  return rows;
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

export function toAdminListingHide(row: ListingHideRow): AdminListingHide {
  return {
    id: row.id,
    entity_type: row.entityType === 'vendor' ? 'vendor' : 'product',
    entity_id: row.entityId,
    parent_id: row.parentId,
    kind: row.kind as ListingHideKind,
    reason: row.reason,
    internal_note: row.internalNote,
    received_at: row.receivedAt,
    source_url: row.sourceUrl,
    set_by: row.setBy,
    set_at: row.setAt,
    restored_by: row.restoredBy,
    restored_at: row.restoredAt,
    restore_reason: row.restoreReason,
  };
}

// ─── Batch builders ──────────────────────────────────────────────────────────

/** One record a batch hides or restores, with what the notice and the audit need. */
export interface ListingTarget {
  entityType: ListingHideEntityType;
  record: ListingRecord;
}

/** Who is told about one record: the recipient vendor ids. */
export type ListingRecipients = ReadonlyMap<string, readonly string[]>;

interface CommonInput {
  now: string;
  actor: Actor;
  /** The audit stamp of the record holder (the company, or the product's holder). */
  stamp: VendorAuditStamp;
  /** Recipients per record id. */
  recipients: ListingRecipients;
  /** Every product whose `integration_count` the write moves. */
  recountProductIds: readonly string[];
}

export interface HideBatchInput extends CommonInput {
  body: AdminListingHideBody;
  /** The record the admin named. */
  root: ListingTarget;
  /** A company hide: the joined products not already hidden. Empty for a product. */
  cascade: readonly ListingRecord[];
}

export interface ListingBatch {
  stmts: BatchStmt[];
  audits: AuditLogEntry[];
  /** The root record's hide row id (a hide), or the row it cleared (a restore). */
  rootHideId: string;
  /** The products the batch hid or re-showed, beside the root. */
  productIds: string[];
}

function recordSubject(target: ListingTarget) {
  return { type: target.entityType, slug: target.record.slug, name: target.record.name };
}

function noticesFor(
  mode: ListingHideMode,
  input: CommonInput,
  target: ListingTarget,
  hideId: string,
  reason: string,
  kind: ListingHideKind | undefined,
): AuditLogEntry[] {
  const notification =
    mode === 'hide' ? 'portal-listing-hidden-by-aeci' : 'portal-listing-restored-by-aeci';
  return (input.recipients.get(target.record.id) ?? []).map((vendorId) =>
    aeciOverrideNotificationAudit(notification, input.actor, {
      event: mode === 'hide' ? 'listing_hidden' : 'listing_restored',
      vendorId,
      reason,
      hideId,
      ...(mode === 'hide' && kind ? { hideKind: kind } : {}),
      entityType: target.entityType,
      entityId: target.record.id,
      recordSubject: recordSubject(target),
    }),
  );
}

function hideColumnsUpdate(
  db: Db,
  entityType: ListingHideEntityType,
  id: string,
  set: { hiddenAt: string | null; hiddenHideId: string | null; updatedAt: string },
  guardHideId: string | null,
) {
  const table = entityType === 'vendor' ? vendors : products;
  return db
    .update(table)
    .set(set)
    .where(
      and(
        eq(table.id, id),
        guardHideId === null ? isNull(table.hiddenAt) : eq(table.hiddenHideId, guardHideId),
      ),
    );
}

/**
 * The hide batch. The root's log row, its guarded UPDATE and sentinel, then each
 * cascaded product's child row, UPDATE and sentinel, then the audit rows and the
 * notices, then the counts.
 */
export function buildHideBatch(db: Db, input: HideBatchInput): ListingBatch {
  const { now, actor, body, root, stamp } = input;
  const rootHideId = crypto.randomUUID();
  const reason = vendorVisibleReasonMetadata(body);
  const sourceUrl = body.sourceUrl ?? null;
  const logRow = (
    id: string,
    entityType: ListingHideEntityType,
    entityId: string,
    parent: string | null,
  ) =>
    db.insert(listingHides).values({
      id,
      entityType,
      entityId,
      parentId: parent,
      kind: body.kind,
      reason: body.reason,
      internalNote: body.internalNote ?? null,
      receivedAt: body.receivedAt,
      sourceUrl,
      setBy: actor.actorId,
      setAt: now,
    });
  const metadata = (hideId: string, parent: string | null) => ({
    source: LISTING_HIDE_AUDIT_SOURCE,
    hideId,
    ...(parent ? { parentHideId: parent } : {}),
    kind: body.kind,
    receivedAt: body.receivedAt,
    sourceUrl,
    ...reason,
  });

  const stmts: BatchStmt[] = [
    logRow(rootHideId, root.entityType, root.record.id, null),
    hideColumnsUpdate(
      db,
      root.entityType,
      root.record.id,
      { hiddenAt: now, hiddenHideId: rootHideId, updatedAt: now },
      null,
    ),
    raceSentinel(db),
  ];
  const audits: AuditLogEntry[] = [
    {
      ...actor,
      action: `${root.entityType}.hidden`,
      entityType: root.entityType,
      entityId: root.record.id,
      ...stamp,
      ...(root.entityType === 'product' ? { productId: root.record.id } : {}),
      beforeState: { hidden_at: null, hidden_hide_id: null },
      afterState: { hidden_at: now, hidden_hide_id: rootHideId },
      metadata: {
        ...metadata(rootHideId, null),
        ...(root.entityType === 'vendor'
          ? { cascadedProductIds: input.cascade.map((p) => p.id) }
          : {}),
      },
    },
    ...noticesFor('hide', input, root, rootHideId, body.reason, body.kind),
  ];

  for (const product of input.cascade) {
    const childId = crypto.randomUUID();
    stmts.push(
      logRow(childId, 'product', product.id, rootHideId),
      hideColumnsUpdate(
        db,
        'product',
        product.id,
        { hiddenAt: now, hiddenHideId: childId, updatedAt: now },
        null,
      ),
      raceSentinel(db),
    );
    const target: ListingTarget = { entityType: 'product', record: product };
    audits.push(
      {
        ...actor,
        action: 'product.hidden',
        entityType: 'product',
        entityId: product.id,
        ...stamp,
        productId: product.id,
        beforeState: { hidden_at: null, hidden_hide_id: null },
        afterState: { hidden_at: now, hidden_hide_id: childId },
        metadata: metadata(childId, rootHideId),
      },
      ...noticesFor('hide', input, target, childId, body.reason, body.kind),
    );
  }

  stmts.push(...audits.map((entry) => auditInsert(db, entry)));
  stmts.push(...integrationCountRecomputeStmts(db, input.recountProductIds));
  return { stmts, audits, rootHideId, productIds: input.cascade.map((p) => p.id) };
}

export interface RestoreBatchInput extends CommonInput {
  reason: string;
  internalNote?: string;
  root: ListingTarget;
  /** The root's active hide row. */
  rootHide: ListingHideRow;
  /** A company restore: its child rows to clear, each with the product it hides. */
  children: readonly { hide: ListingHideRow; product: ListingRecord }[];
  /** Children still joined to another hidden company: re-homed under that hide. */
  rehome: ReadonlyMap<string, { vendorId: string; hideId: string; hide: ListingHideRow }>;
}

/**
 * The restore batch. Stamps `restored_*` on the root's row and each child row it
 * clears, clears the columns those rows set (guarded on `hidden_hide_id`, so a row
 * hidden again by something else is never shown), and writes the audit rows, the
 * notices and the counts. A child still joined to another hidden company is not
 * shown: its child row moves under that company's hide instead.
 */
export function buildRestoreBatch(db: Db, input: RestoreBatchInput): ListingBatch {
  const { now, actor, root, rootHide, stamp } = input;
  const visible = vendorVisibleReasonMetadata({
    reason: input.reason,
    internalNote: input.internalNote,
  });
  const markRestored = (id: string) =>
    db
      .update(listingHides)
      .set({ restoredAt: now, restoredBy: actor.actorId, restoreReason: input.reason })
      .where(and(eq(listingHides.id, id), isNull(listingHides.restoredAt)));
  const metadata = (hideId: string) => ({
    source: LISTING_HIDE_AUDIT_SOURCE,
    hideId,
    kind: rootHide.kind,
    ...visible,
  });

  const stmts: BatchStmt[] = [
    markRestored(rootHide.id),
    raceSentinel(db),
    hideColumnsUpdate(
      db,
      root.entityType,
      root.record.id,
      { hiddenAt: null, hiddenHideId: null, updatedAt: now },
      rootHide.id,
    ),
    raceSentinel(db),
  ];
  const audits: AuditLogEntry[] = [
    {
      ...actor,
      action: `${root.entityType}.restored`,
      entityType: root.entityType,
      entityId: root.record.id,
      ...stamp,
      ...(root.entityType === 'product' ? { productId: root.record.id } : {}),
      beforeState: { hidden_at: root.record.hiddenAt, hidden_hide_id: rootHide.id },
      afterState: { hidden_at: null, hidden_hide_id: null },
      metadata: {
        ...metadata(rootHide.id),
        ...(root.entityType === 'vendor'
          ? {
              restoredProductIds: input.children
                .filter((c) => !input.rehome.has(c.product.id))
                .map((c) => c.product.id),
              ...(input.rehome.size > 0 ? { rehomedProductIds: [...input.rehome.keys()] } : {}),
            }
          : {}),
      },
    },
    ...noticesFor('restore', input, root, rootHide.id, input.reason, undefined),
  ];

  const restored: string[] = [];
  for (const { hide, product } of input.children) {
    stmts.push(markRestored(hide.id), raceSentinel(db));
    const other = input.rehome.get(product.id);
    if (other) {
      // Still under another hidden company: stays hidden, under that company's hide.
      const childId = crypto.randomUUID();
      stmts.push(
        db.insert(listingHides).values({
          id: childId,
          entityType: 'product',
          entityId: product.id,
          parentId: other.hideId,
          kind: other.hide.kind,
          reason: other.hide.reason,
          internalNote: other.hide.internalNote,
          receivedAt: other.hide.receivedAt,
          sourceUrl: other.hide.sourceUrl,
          setBy: actor.actorId,
          setAt: now,
        }),
        hideColumnsUpdate(
          db,
          'product',
          product.id,
          { hiddenAt: product.hiddenAt ?? now, hiddenHideId: childId, updatedAt: now },
          hide.id,
        ),
        raceSentinel(db),
      );
      audits.push({
        ...actor,
        action: 'product.hidden',
        entityType: 'product',
        entityId: product.id,
        ...stamp,
        productId: product.id,
        beforeState: { hidden_at: product.hiddenAt, hidden_hide_id: hide.id },
        afterState: { hidden_at: product.hiddenAt ?? now, hidden_hide_id: childId },
        metadata: {
          source: LISTING_HIDE_AUDIT_SOURCE,
          hideId: childId,
          parentHideId: other.hideId,
          rehomedFromHideId: hide.id,
          kind: other.hide.kind,
          // The company hide it moved under carries the vendor-visible reason.
          reason: other.hide.reason,
          reasonVisibility: REASON_VISIBILITY_VENDOR,
        },
      });
      continue;
    }
    restored.push(product.id);
    stmts.push(
      hideColumnsUpdate(
        db,
        'product',
        product.id,
        { hiddenAt: null, hiddenHideId: null, updatedAt: now },
        hide.id,
      ),
      raceSentinel(db),
    );
    const target: ListingTarget = { entityType: 'product', record: product };
    audits.push(
      {
        ...actor,
        action: 'product.restored',
        entityType: 'product',
        entityId: product.id,
        ...stamp,
        productId: product.id,
        beforeState: { hidden_at: product.hiddenAt, hidden_hide_id: hide.id },
        afterState: { hidden_at: null, hidden_hide_id: null },
        metadata: { ...metadata(hide.id), parentHideId: rootHide.id },
      },
      ...noticesFor('restore', input, target, hide.id, input.reason, undefined),
    );
  }

  stmts.push(...audits.map((entry) => auditInsert(db, entry)));
  stmts.push(...integrationCountRecomputeStmts(db, input.recountProductIds));
  return { stmts, audits, rootHideId: rootHide.id, productIds: restored };
}

/**
 * A product a company's own seat creates in the portal (`POST /api/vendor/products`,
 * or a proposal accept). When the company is hidden, the product goes in hidden,
 * under the company's hide (a child row), so it never reaches the public site, and
 * a company restore re-shows it with the rest.
 *
 * Either way the batch carries {@link vendorHideStateSentinel}, so a hide or restore
 * of the company between the read and the batch aborts the create instead of
 * leaving a live product under a hidden company.
 */
export function hiddenProductInsertPlan(
  db: Db,
  input: {
    productId: string;
    vendorId: string;
    /** The company's active hide, or `null` when it is on the public site. */
    vendorHide: ListingHideRow | null;
    now: string;
    actor: Actor;
  },
): {
  /** Spread into the product INSERT's columns. */
  columns: { hiddenAt: string | null; hiddenHideId: string | null };
  /** Push after the product INSERT. */
  stmts: BatchStmt[];
  /** The `product.hidden` row, or `null` when the company is visible. */
  audit: AuditLogEntry | null;
} {
  const sentinel = vendorHideStateSentinel(db, input.vendorId, input.vendorHide?.id ?? null);
  const parent = input.vendorHide;
  if (!parent)
    return { columns: { hiddenAt: null, hiddenHideId: null }, stmts: [sentinel], audit: null };
  const hideId = crypto.randomUUID();
  const audit: AuditLogEntry = {
    ...input.actor,
    action: 'product.hidden',
    entityType: 'product',
    entityId: input.productId,
    productId: input.productId,
    vendorId: input.vendorId,
    beforeState: { hidden_at: null, hidden_hide_id: null },
    afterState: { hidden_at: input.now, hidden_hide_id: hideId },
    metadata: {
      source: LISTING_HIDE_AUDIT_SOURCE,
      hideId,
      parentHideId: parent.id,
      kind: parent.kind,
      createdHidden: true,
      reason: parent.reason,
      reasonVisibility: REASON_VISIBILITY_VENDOR,
    },
  };
  return {
    columns: { hiddenAt: input.now, hiddenHideId: hideId },
    stmts: [
      sentinel,
      db.insert(listingHides).values({
        id: hideId,
        entityType: 'product',
        entityId: input.productId,
        parentId: parent.id,
        kind: parent.kind,
        reason: parent.reason,
        internalNote: parent.internalNote,
        receivedAt: parent.receivedAt,
        sourceUrl: parent.sourceUrl,
        setBy: input.actor.actorId,
        setAt: input.now,
      }),
      auditInsert(db, audit),
    ],
    audit,
  };
}

/** Aborts the batch unless the company's `hidden_hide_id` is still `expected`
 *  (`IS`, so `null` compares as "still visible"). */
export function vendorHideStateSentinel(db: Db, vendorId: string, expected: string | null) {
  return db
    .select({
      guard: sql`CASE WHEN NOT EXISTS (SELECT 1 FROM ${vendors} WHERE ${vendors.id} = ${vendorId} AND ${vendors.hiddenHideId} IS ${expected}) THEN json(${LISTING_HIDE_RACE_TOKEN}) END`,
    })
    .from(ONE_ROW);
}

/** The `listing_hides` rows with these ids, by id. For the admin reads. */
export async function loadHideRows(
  db: Db,
  ids: readonly (string | null)[],
): Promise<Map<string, ListingHideRow>> {
  const out = new Map<string, ListingHideRow>();
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  for (const chunk of chunks(wanted)) {
    const rows = await db.query.listingHides.findMany({ where: inArray(listingHides.id, chunk) });
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

/**
 * The hide state each record's own vendor sees (`GET /api/vendor/me`,
 * `VendorProduct`): when, the kind and the vendor-visible reason. Never the
 * internal note. Reads nothing for a record on the public site.
 */
export async function vendorListingHiddenMap(
  db: Db,
  rows: readonly { id: string; hiddenAt: string | null; hiddenHideId: string | null }[],
): Promise<Map<string, VendorListingHidden>> {
  const hidden = rows.filter((row) => row.hiddenAt && row.hiddenHideId);
  const out = new Map<string, VendorListingHidden>();
  if (hidden.length === 0) return out;
  const hides = await loadHideRows(
    db,
    hidden.map((row) => row.hiddenHideId),
  );
  for (const row of hidden) {
    const hide = hides.get(row.hiddenHideId!);
    if (!hide) continue;
    out.set(row.id, { at: row.hiddenAt!, kind: hide.kind as ListingHideKind, reason: hide.reason });
  }
  return out;
}

/** What {@link prepareHiddenProductInsert} hands a create batch. */
export interface HiddenProductInsert {
  /** Spread into the product INSERT's columns. */
  columns: { hiddenAt: string | null; hiddenHideId: string | null };
  /** Push after the product INSERT and its `product_vendors` rows. */
  stmts: BatchStmt[];
  /** The `product.hidden` audit row, or `null` when no linked company is hidden. */
  audit: AuditLogEntry | null;
  /** True when a linked company's hide state moved since this read: the caller
   *  answers `409 LISTING_CHANGED_WHILE_SAVING` after a failed batch. */
  stateChanged: () => Promise<boolean>;
}

/**
 * A product created in the portal for these companies (the owner's create, or a
 * proposal accept): hidden under the first hidden company's hide, by id, when any
 * linked company is hidden. Every linked company's hide state is pinned by a
 * sentinel, so a hide or restore between this read and the batch aborts the create.
 */
export async function prepareHiddenProductInsert(
  db: Db,
  input: { productId: string; vendorIds: readonly string[]; now: string; actor: Actor },
): Promise<HiddenProductInsert> {
  const ids = [...new Set(input.vendorIds)].sort();
  const states: { id: string; hiddenHideId: string | null }[] = [];
  for (const chunk of chunks(ids)) {
    states.push(
      ...(await db
        .select({ id: vendors.id, hiddenHideId: vendors.hiddenHideId })
        .from(vendors)
        .where(inArray(vendors.id, chunk))),
    );
  }
  states.sort((a, b) => (a.id < b.id ? -1 : 1));
  const stateChanged = async () => {
    const current = new Map<string, string | null>();
    for (const chunk of chunks(ids)) {
      const rows = await db
        .select({ id: vendors.id, hiddenHideId: vendors.hiddenHideId })
        .from(vendors)
        .where(inArray(vendors.id, chunk));
      for (const row of rows) current.set(row.id, row.hiddenHideId);
    }
    return states.some((s) => current.has(s.id) && current.get(s.id) !== s.hiddenHideId);
  };
  const parentState = states.find((s) => s.hiddenHideId);
  const parent = parentState ? await loadHideRow(db, parentState.hiddenHideId) : undefined;
  const sentinels = states
    .filter((s) => s.id !== parentState?.id)
    .map((s) => vendorHideStateSentinel(db, s.id, s.hiddenHideId));
  if (!parentState || !parent) {
    return {
      columns: { hiddenAt: null, hiddenHideId: null },
      stmts: sentinels,
      audit: null,
      stateChanged,
    };
  }
  const plan = hiddenProductInsertPlan(db, {
    productId: input.productId,
    vendorId: parentState.id,
    vendorHide: parent,
    now: input.now,
    actor: input.actor,
  });
  return { ...plan, stmts: [...sentinels, ...plan.stmts], stateChanged };
}

/** The ids in `vendorIds` whose company is hidden. Promote's plan-time read. */
export async function loadHiddenVendorIds(
  db: Db,
  vendorIds: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const chunk of chunks([...new Set(vendorIds)])) {
    const rows = await db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(inArray(vendors.id, chunk), isNotNull(vendors.hiddenAt)));
    for (const row of rows) out.add(row.id);
  }
  return out;
}

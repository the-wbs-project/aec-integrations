/**
 * Mapping authoring on a vendor-managed connector catalogue (AECI-724 —
 * `docs/ADMIN_PANEL_SPEC.md` §5.9, `docs/STAGE_2_SPEC.md` §8.9(1)–(2)).
 *
 * The one module both writers compose:
 *
 *   PATCH /api/admin/connector-stub-mappings/:id  — `routes/admin-connector-stub-mappings.ts`
 *   PATCH /api/vendor/connector-stub-mappings/:id — `routes/vendor-connector-stub-mappings.ts`
 *
 * The two routes differ only in who may call them and what `decided_by` says. The
 * gate, the validation, the batch and the purge set live here, so an admin edit and a
 * vendor edit of the same row cannot behave differently.
 *
 * ── THE GATE IS THE EXACT COMPLEMENT OF THE PROMOTE REFUSAL ───────────────────
 * `planConnectorCatalogPage` refuses every page for a `vendor`-managed catalogue with
 * `CATALOG_VENDOR_MANAGED` (AECI-720). This refuses every edit on a `review`-managed one
 * with `CATALOG_REVIEW_MANAGED`. So at any moment exactly one lane may write a given
 * mapping row. That is why the sync needs no skip guard (a guard would make AECI-731's
 * "every row `unchanged`" criterion unachievable) and why an edit here is never the row
 * the next page clobbers.
 *
 * The gate is checked twice: once on the preload, for a clean 409, and again INSIDE the
 * batch by {@link catalogStillVendorManagedSentinel}, so an operator flipping the lane
 * back to `review` between the read and the write cannot leave an AECi-authored row on
 * a catalogue the sync is about to overwrite.
 *
 * ── WHAT IS WRITTEN ─────────────────────────────────────────────────────────
 * `product_id`, `status`, `confidence`, `evidence_url` from the body; `decided_by`,
 * `decided_at`, `checked_at` stamped here. Whoever edits the row stands behind it, so an
 * edited `mapped` row clears §9a.4's provenance gate and reaches the public reach line.
 * Hence the purge: `product:{slug}` for the product losing the row, the product gaining
 * it, and the connector itself — AECI-892's tag set, restricted to edits where the row
 * was or becomes publishable, because only then can a public page move.
 */

import {
  ApiErrorCode,
  CONNECTOR_DECISION_STATUSES,
  type AdminConnectorMapping,
  type AuditLogEntry,
  type ConnectorStubMappingEditResponse,
  type LinkRef,
  type UpdateConnectorStubMappingInput,
} from '@aeci/shared';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { connectorCatalogs, connectorStubMappings, products } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { isPublishable } from './admin-connectors';
import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import { ONE_ROW } from './integration-claims';

// ─── The row as the edit sees it ─────────────────────────────────────────────

export interface MappingEditTarget {
  id: string;
  stubId: string;
  catalogId: string;
  productId: string | null;
  status: string;
  confidence: string | null;
  evidenceUrl: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  checkedAt: string | null;
  notes: string | null;
  managedBy: string;
  connectorProductId: string;
}

/**
 * One read: the mapping plus the two catalogue facts every gate needs. `null` when the
 * id resolves to nothing — the caller answers 404.
 */
export async function loadMappingForEdit(db: Db, id: string): Promise<MappingEditTarget | null> {
  const rows = await db
    .select({
      id: connectorStubMappings.id,
      stubId: connectorStubMappings.stubId,
      catalogId: connectorStubMappings.catalogId,
      productId: connectorStubMappings.productId,
      status: connectorStubMappings.status,
      confidence: connectorStubMappings.confidence,
      evidenceUrl: connectorStubMappings.evidenceUrl,
      decidedBy: connectorStubMappings.decidedBy,
      decidedAt: connectorStubMappings.decidedAt,
      checkedAt: connectorStubMappings.checkedAt,
      notes: connectorStubMappings.notes,
      managedBy: connectorCatalogs.managedBy,
      connectorProductId: connectorCatalogs.connectorProductId,
    })
    .from(connectorStubMappings)
    .innerJoin(connectorCatalogs, eq(connectorCatalogs.id, connectorStubMappings.catalogId))
    .where(eq(connectorStubMappings.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** 404 for an unknown mapping id. Resource kind `connector_stub_mapping`. */
export function mappingNotFound(id: string): ApiError {
  return notFoundError('connector_stub_mapping', { id });
}

/**
 * The gate. Any catalogue that is not `vendor`-managed is refused, because the review
 * app still authors it and the next sync page would overwrite the edit.
 */
export function assertVendorManaged(target: Pick<MappingEditTarget, 'managedBy'>): void {
  if (target.managedBy !== 'vendor') {
    throw new ApiError(
      409,
      ApiErrorCode.CATALOG_REVIEW_MANAGED,
      'This catalogue is still maintained through the review app, so its mappings cannot be edited here. The next sync would overwrite the change.',
    );
  }
}

// ─── The edit ────────────────────────────────────────────────────────────────

/** Who is editing. Decides `decided_by`, the audit actor and the audit `source`. */
export interface MappingEditActor {
  userId: string;
  actorType: AuditLogEntry['actorType'];
  /** The `decided_by` value stamped on the row. */
  decidedBy: string;
  /** The audit `metadata.source` facet. */
  auditSource: string;
  /** Set on a vendor seat's edit, so the vendor audit viewer can reach the row. */
  vendorId?: string;
}

export interface MappingEditResult {
  response: ConnectorStubMappingEditResponse;
  /** Empty on a no-op. */
  auditEntries: AuditLogEntry[];
  /** `product:{slug}` tags to purge post-commit. Empty unless a public page can move. */
  purgeTags: string[];
}

const DECISION_STATUSES = CONNECTOR_DECISION_STATUSES as readonly string[];

type Merged = {
  status: string;
  productId: string | null;
  confidence: string | null;
  evidenceUrl: string | null;
};

function merge(target: MappingEditTarget, input: UpdateConnectorStubMappingInput): Merged {
  return {
    status: input.status ?? target.status,
    productId: input.productId !== undefined ? input.productId : target.productId,
    confidence: input.confidence !== undefined ? input.confidence : target.confidence,
    evidenceUrl: input.evidenceUrl !== undefined ? input.evidenceUrl : target.evidenceUrl,
  };
}

function validationFailed(field: string, message: string): ApiError {
  return new ApiError(422, ApiErrorCode.VALIDATION_FAILED, message, { field });
}

function mappingConflict(message: string): ApiError {
  return new ApiError(409, ApiErrorCode.MAPPING_CONFLICT, message);
}

/**
 * A batch statement that ABORTS the batch unless the catalogue is still
 * `vendor`-managed. Pushed FIRST, before the UPDATE and its audit row.
 *
 * The same `json()` abort `contestStillOpenSentinel` uses: SQLite has no `RAISE()`
 * outside triggers, so a deliberate malformed-JSON error is the only in-statement abort,
 * and it rolls the whole batch back. Selected FROM a one-row constant so it is evaluated
 * exactly once whether or not the catalogue row still exists.
 */
function catalogStillVendorManagedSentinel(db: Db, catalogId: string) {
  return db
    .select({
      guard: sql`CASE WHEN NOT EXISTS (SELECT 1 FROM ${connectorCatalogs}
        WHERE ${connectorCatalogs.id} = ${catalogId} AND ${connectorCatalogs.managedBy} = 'vendor')
        THEN json('catalog-not-vendor-managed') END`,
    })
    .from(ONE_ROW);
}

function isSentinelAbort(error: unknown): boolean {
  return /malformed JSON/i.test(causeChain(error));
}

function isUniqueViolation(error: unknown): boolean {
  return /UNIQUE constraint failed/i.test(causeChain(error));
}

function causeChain(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    parts.push(String((current as { message?: unknown }).message ?? current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

/**
 * Validate, then write the edit in ONE `db.batch`: the gate sentinel, the UPDATE and its
 * `audit_log` row (§26.1). A body that matches the stored row is a 200 no-op that writes
 * nothing — a trail of identical states is not a history (the AECI-739 rule).
 *
 * The caller has already answered 404 and the managed-by 409 in its own order (the
 * vendor route asks ownership first), so this starts from a row the caller may edit.
 */
export async function applyMappingEdit(
  db: Db,
  target: MappingEditTarget,
  input: UpdateConnectorStubMappingInput,
  actor: MappingEditActor,
): Promise<MappingEditResult> {
  const next = merge(target, input);

  // §9a.4's two-column invariant, on the MERGED row. The DB does not enforce it
  // (ON DELETE SET NULL would make a CHECK fail product deletes), so this is the check.
  const productBearing = !DECISION_STATUSES.includes(next.status);
  if (productBearing && next.productId === null) {
    throw validationFailed(
      'productId',
      `A ${next.status} mapping names a product. Choose one, or pick a status that names none.`,
    );
  }
  if (!productBearing && next.productId !== null) {
    throw validationFailed(
      'productId',
      `A ${next.status} decision names no product. Clear the product as well.`,
    );
  }

  // Every product the response or the purge needs, in one read.
  const productIds = [
    ...new Set(
      [target.productId, next.productId, target.connectorProductId].filter(
        (v): v is string => v !== null,
      ),
    ),
  ];
  const productRows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      promotionStatus: products.promotionStatus,
    })
    .from(products)
    .where(inArray(products.id, productIds));
  const productById = new Map(productRows.map((p) => [p.id, p]));

  // A newly named product must be promoted: the promote path skips a mapping to an
  // unpromoted product for the same reason, and a pointer to it would render nowhere.
  if (next.productId !== null && next.productId !== target.productId) {
    const named = productById.get(next.productId);
    if (!named || named.promotionStatus !== 'promoted') {
      throw validationFailed('productId', 'That product is not published on AECi.');
    }
  }

  const unchanged =
    next.status === target.status &&
    next.productId === target.productId &&
    next.confidence === target.confidence &&
    next.evidenceUrl === target.evidenceUrl;

  const toLink = (id: string | null): LinkRef | null => {
    if (id === null) return null;
    const p = productById.get(id);
    return p ? { id: p.id, name: p.name, slug: p.slug } : null;
  };

  if (unchanged) {
    return {
      response: {
        catalog_id: target.catalogId,
        stub_id: target.stubId,
        mapping: toWire(target, toLink(target.productId)),
        changed: false,
      },
      auditEntries: [],
      purgeTags: [],
    };
  }

  // The two unique indexes, answered with a named 409 rather than a constraint 500.
  // A race past these reads still lands on the index, and is mapped the same way below.
  if (productBearing && next.productId !== target.productId) {
    const clash = await db
      .select({ id: connectorStubMappings.id })
      .from(connectorStubMappings)
      .where(
        and(
          eq(connectorStubMappings.stubId, target.stubId),
          eq(connectorStubMappings.productId, next.productId as string),
          ne(connectorStubMappings.id, target.id),
        ),
      )
      .limit(1);
    if (clash.length > 0) {
      throw mappingConflict('This listing already has a mapping to that product.');
    }
  }
  if (!productBearing && DECISION_STATUSES.includes(target.status) === false) {
    const clash = await db
      .select({ id: connectorStubMappings.id })
      .from(connectorStubMappings)
      .where(
        and(
          eq(connectorStubMappings.stubId, target.stubId),
          inArray(connectorStubMappings.status, [...DECISION_STATUSES]),
          ne(connectorStubMappings.id, target.id),
        ),
      )
      .limit(1);
    if (clash.length > 0) {
      throw mappingConflict('This listing already carries a listing-level decision.');
    }
  }

  const now = new Date().toISOString();
  const written = {
    ...target,
    ...next,
    decidedBy: actor.decidedBy,
    decidedAt: now,
    checkedAt: now,
  };

  const publishableBefore = isPublishable(target);
  const publishableAfter = isPublishable(written);

  const auditEntry: AuditLogEntry = {
    actorId: actor.userId,
    actorType: actor.actorType,
    action: 'connector_mapping.updated',
    // Filed under the CATALOGUE, with the mapping id in metadata, so the catalogue's
    // audit tab (`GET /api/admin/connector-catalogs/:id/audit`, keyed on
    // `audit_log_entity_idx`) shows every edit beside the handover and the sync runs,
    // with no metadata probing. The sync's own run row files the same way.
    entityType: 'connector_catalog',
    entityId: target.catalogId,
    beforeState: auditState(target),
    afterState: auditState(written),
    metadata: {
      source: actor.auditSource,
      mapping_id: target.id,
      stub_id: target.stubId,
      connector_product_id: target.connectorProductId,
      ...(actor.vendorId ? { vendor_id: actor.vendorId } : {}),
      publishable_before: publishableBefore,
      publishable_after: publishableAfter,
    },
  };

  const stmts: BatchStmt[] = [
    catalogStillVendorManagedSentinel(db, target.catalogId),
    db
      .update(connectorStubMappings)
      .set({
        productId: next.productId,
        status: next.status,
        confidence: next.confidence,
        evidenceUrl: next.evidenceUrl,
        decidedBy: actor.decidedBy,
        decidedAt: now,
        checkedAt: now,
        updatedAt: now,
      })
      .where(eq(connectorStubMappings.id, target.id)),
    auditInsert(db, auditEntry),
  ];
  try {
    await db.batch(stmts as BatchTuple);
  } catch (error) {
    if (isSentinelAbort(error)) assertVendorManaged({ managedBy: 'review' });
    if (isUniqueViolation(error)) {
      throw mappingConflict('Another mapping on this listing changed while you were saving.');
    }
    throw error;
  }

  // Only a row that was or becomes publishable can move a public page (§13.7's reach
  // line reads the §9a.4 predicate and nothing else).
  const purgeTags: string[] = [];
  if (publishableBefore || publishableAfter) {
    const slugs = new Set<string>();
    for (const id of [target.productId, next.productId, target.connectorProductId]) {
      const slug = id ? productById.get(id)?.slug : undefined;
      if (slug) slugs.add(slug);
    }
    for (const slug of slugs) purgeTags.push(`product:${slug}`);
  }

  return {
    response: {
      catalog_id: target.catalogId,
      stub_id: target.stubId,
      mapping: toWire(written, toLink(next.productId)),
      changed: true,
    },
    auditEntries: [auditEntry],
    purgeTags,
  };
}

function auditState(row: Merged & { decidedBy: string | null }) {
  return {
    status: row.status,
    product_id: row.productId,
    confidence: row.confidence,
    evidence_url: row.evidenceUrl,
    decided_by: row.decidedBy,
  };
}

function toWire(
  row: Omit<MappingEditTarget, 'managedBy' | 'connectorProductId' | 'stubId' | 'catalogId'>,
  product: LinkRef | null,
): AdminConnectorMapping {
  return {
    id: row.id,
    status: row.status as AdminConnectorMapping['status'],
    product,
    confidence: row.confidence as AdminConnectorMapping['confidence'],
    evidence_url: row.evidenceUrl,
    decided_by: row.decidedBy,
    decided_at: row.decidedAt,
    checked_at: row.checkedAt,
    notes: row.notes,
    publishable: isPublishable(row),
  };
}

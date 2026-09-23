/**
 * The owner edits a `connector_evidenced_pairs` row (AECI-1090 / the AECI-1040
 * carve-out / `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.6) — Drizzle/D1.
 *
 * Reached through `PATCH /api/vendor/integrations/:id` when the id is not an
 * `integrations` row (`vendor-integration-edits.ts` asks that table first). It is
 * the AECI-1006 edit, rule for rule, on the second anchor table. What differs:
 *
 * ── 1. THE GATE ─────────────────────────────────────────────────────────────
 * `evidencedOwnerWriteRefusal`: the same order as on `integrations`, with the
 * pair's `product_a_id` / `product_b_id` as the two endpoints. Every row of this
 * table is connector-powered (ADR 0035 decision 9's predicate), so the entitlement
 * step always applies: an owner with no active entitlement gets `403
 * INTEGRATION_ENTITLEMENT_REQUIRED`. Then `409 INTEGRATION_NOT_CLAIMED`, then `409
 * INTEGRATION_RETIRED` (`retired_at`, which AECI-1091's retire writes).
 *
 * ── 2. TEN FIELDS ───────────────────────────────────────────────────────────
 * `CONNECTOR_POWERED_EDIT_FIELDS`: the eleven standard fields minus
 * `mechanism_kind`, which this table has no column for. A body that sends it is a
 * `422 INTEGRATION_INVALID_VALUE` naming it, never a silent drop. `owner` and
 * `notes` stay out through the shared `.strict()` schema, as on `integrations`.
 * The routing columns (`connector_product_id`, `product_a_id`, `product_b_id`) are
 * not editable at all.
 *
 * ── 3. DIRECTION IN THE CANONICAL FRAME ─────────────────────────────────────
 * The column is `a_to_b | b_to_a | both` against the id-sorted `product_a_id <
 * product_b_id` order (`DATABASE_SCHEMA.md` §9a.6). The wire is caller-relative,
 * framed against `context_product_id`, exactly as on `integrations` with A in the
 * source seat. Omitted means the caller's own endpoint (A first), and A when it
 * holds neither, which is the usual case: most owners here are third parties.
 *
 * ── 4. ONE BATCH, THE SAME ROWS ─────────────────────────────────────────────
 * The guarded `UPDATE … WHERE built_by_vendor_id = <caller> AND claimed_at IS NOT
 * NULL AND retired_at IS NULL` (changed columns, §13.9's maintenance transfer,
 * `updated_at`), `ownerWriteSentinel` right after it, the `integration.updated`
 * audit row (`reason: 'owner-edit'`, `entity_type` `connector_evidenced_pair`, as
 * promote and the AECI-1089 claim write it for this table), and one
 * `notification.sent` row (`kind: 'integration_update'`, `entity_type`
 * `integration`, like the claim's notification) per vendor of either endpoint other
 * than the owner. The `updated_at` bump moves the owner's owned-rows freshness
 * cursor (`routes/vendor-updates.ts`, AECI-1089).
 *
 * ── 5. AFTER COMMIT ─────────────────────────────────────────────────────────
 * A by-id Algolia sync of the record (the integrations index holds evidenced pairs
 * too, and the by-id path reads both tables), then purge `pair:{a}__{b}`, both
 * endpoint `product:` tags and the connector's `product:` tag, and queue the pair
 * re-crawl.
 */

import {
  ApiErrorCode,
  CONNECTOR_POWERED_EDIT_FIELDS,
  UpdateVendorIntegrationResponseSchema,
  UpdateVendorIntegrationSchema,
  claimDirectionFromContext,
  integrationEditValueProblem,
  type ContextDirection,
  type IntegrationEditField,
  type UpdateVendorIntegrationResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { eq, inArray, or } from 'drizzle-orm';

import type { Db } from '../db/client';
import { connectorEvidencedPairs, productVendors, products, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev } from '../lib/handler-utils';
import {
  evidencedOwnerWriteRefusal,
  evidencedOwnerWriteWhere,
  isOwnerWriteRaceError,
  ownedEndpointIds,
  ownerWriteSentinel,
  updateNotificationAudit,
  type EvidencedPairRow,
} from '../lib/integration-owner-writes';
import { publicSiteBase } from '../lib/public-urls';
import { dispatchOwnerWriteSearch, syncOwnerWriteSearch } from './integration-retire-write';
import { pairCacheTag } from './promote-pair';
import { attestationEditRecrawl } from './vendor-recrawl';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  isMaintenanceTransfer,
  maintenanceTransferColumns,
  parseJsonBody,
  recrawlEnabled,
  sessionVendorId,
  type VendorContext,
} from './vendor-shared';

/** `audit_log.action` for an owner edit, shared with `vendor-integration-edits.ts`
 *  (restated here rather than imported, to keep the two modules acyclic). */
const INTEGRATION_UPDATED_ACTION = 'integration.updated';

type EvidencedEditField = Exclude<IntegrationEditField, 'mechanism_kind'>;

/** Wire field → `connector_evidenced_pairs` column. The table has every standard
 *  column `integrations` has except `mechanism_kind` (`schema.ts`). */
export const EVIDENCED_EDIT_COLUMNS = {
  name: 'name',
  mechanism_name: 'mechanismName',
  direction: 'direction',
  description: 'description',
  listing_url: 'listingUrl',
  docs_url: 'docsUrl',
  website: 'website',
  mechanism_url: 'mechanismUrl',
  pricing_model: 'pricingModel',
  maturity: 'maturity',
} as const satisfies Record<EvidencedEditField, keyof EvidencedPairRow>;

const EDIT_FIELDS = CONNECTOR_POWERED_EDIT_FIELDS as readonly EvidencedEditField[];

function storedValue(pair: EvidencedPairRow, field: EvidencedEditField): string | null {
  return pair[EVIDENCED_EDIT_COLUMNS[field]] ?? null;
}

/** Run the owner edit on one evidenced pair. The caller has already read the row. */
export async function editEvidencedPair(
  c: VendorContext,
  db: Db,
  pair: EvidencedPairRow,
): Promise<Response> {
  const session = c.get('auth');
  const vendorId = sessionVendorId(c);
  const pairId = pair.id;

  // 1. Ownership, the entitlement, claimed, live. Before the body.
  const refusal = await evidencedOwnerWriteRefusal(db, vendorId, pair, session);
  if (refusal) throw refusal;

  // 2. Shape: the same strict schema as the `integrations` edit.
  const payload = await parseJsonBody(c, UpdateVendorIntegrationSchema);

  // 3. The field this table does not have. Refused, never dropped, so a client
  //    that believes it set a type is told it did not.
  if (payload.mechanism_kind !== undefined) {
    throw new ApiError(
      422,
      ApiErrorCode.INTEGRATION_INVALID_VALUE,
      'An integration delivered through a connector product has no integration type to change',
      { field: 'mechanism_kind' },
    );
  }

  // 4. The direction frame, with A in the source seat (the canonical order).
  const endpoints = { sourceProductId: pair.productAId, targetProductId: pair.productBId };
  const owned = await ownedEndpointIds(db, vendorId, endpoints);
  if (
    payload.context_product_id &&
    payload.context_product_id !== pair.productAId &&
    payload.context_product_id !== pair.productBId
  ) {
    throw new ApiError(
      400,
      'VALIDATION_FAILED',
      'context_product_id must be one of this integration’s two products',
      { field: 'context_product_id' },
    );
  }
  const contextIsA = payload.context_product_id
    ? payload.context_product_id === pair.productAId
    : owned.includes(pair.productAId) || !owned.includes(pair.productBId);

  // 5. Values.
  const changes: Partial<Record<EvidencedEditField, string | null>> = {};
  for (const field of EDIT_FIELDS) {
    const wire = payload[field];
    if (wire === undefined) continue;
    const problem = integrationEditValueProblem(field, wire);
    if (problem) {
      throw new ApiError(422, ApiErrorCode.INTEGRATION_INVALID_VALUE, problem, { field });
    }
    const stored =
      field === 'direction' && wire !== null
        ? claimDirectionFromContext(wire as ContextDirection, contextIsA)
        : wire;
    if (stored !== storedValue(pair, field)) changes[field] = stored;
  }

  const changed = EDIT_FIELDS.filter((field) => field in changes);
  if (changed.length === 0) {
    const body: UpdateVendorIntegrationResponse = {
      integration: {
        id: pairId,
        changed: [],
        maintained_by: pair.maintainedBy === 'vendor' ? 'vendor' : 'aeci',
        last_reviewed_at: pair.lastReviewedAt ?? null,
        updated_at: pair.updatedAt,
      },
    };
    validateResponseInDev(c.env, () => UpdateVendorIntegrationResponseSchema.parse(body));
    return json(body);
  }

  // One wave: the owner's name, the endpoint vendors and the three slugs.
  const productIds = [pair.productAId, pair.productBId, pair.connectorProductId];
  const [owner, endpointVendors, productRows] = await Promise.all([
    db.query.vendors.findFirst({
      columns: { id: true, companyName: true },
      where: eq(vendors.id, vendorId),
    }),
    db
      .select({ vendorId: productVendors.vendorId })
      .from(productVendors)
      .where(
        or(
          eq(productVendors.productId, pair.productAId),
          eq(productVendors.productId, pair.productBId),
        ),
      ),
    db
      .select({ id: products.id, slug: products.slug })
      .from(products)
      .where(inArray(products.id, productIds)),
  ]);
  if (!owner) throw notFoundError('vendor', { id: vendorId });

  const slugOf = new Map(productRows.map((p) => [p.id, p.slug]));
  const slugA = slugOf.get(pair.productAId);
  const slugB = slugOf.get(pair.productBId);
  const pairSlugs: readonly [string, string] | null = slugA && slugB ? [slugA, slugB] : null;
  const connectorSlug = slugOf.get(pair.connectorProductId) ?? null;

  // Every vendor of either endpoint, except the owner. Sorted by id: an id
  // ordering stays BINARY (`API_CONTRACTS.md` §3.2).
  const recipients = [...new Set(endpointVendors.map((r) => r.vendorId))]
    .filter((id) => id !== vendorId)
    .sort();

  const now = new Date().toISOString();
  const actor = { actorId: session.userId, actorType: auditActorType(session) };
  const beforeState: Record<string, unknown> = {};
  const afterState: Record<string, unknown> = {};
  const columns: Record<string, string | null> = {};
  for (const field of changed) {
    beforeState[field] = storedValue(pair, field);
    afterState[field] = changes[field] ?? null;
    columns[EVIDENCED_EDIT_COLUMNS[field]] = changes[field] ?? null;
  }
  beforeState.maintained_by = pair.maintainedBy;
  beforeState.last_reviewed_at = pair.lastReviewedAt;
  afterState.maintained_by = 'vendor';
  afterState.last_reviewed_at = now;

  const audits: AuditLogEntry[] = [
    {
      ...actor,
      action: INTEGRATION_UPDATED_ACTION,
      // The entity vocabulary promote and the AECI-1089 claim write for this table.
      entityType: 'connector_evidenced_pair',
      entityId: pairId,
      beforeState,
      afterState,
      metadata: {
        source: AUDIT_SOURCE,
        vendorId,
        reason: 'owner-edit',
        fields: changed,
        ...(isMaintenanceTransfer(pair) ? { maintenanceTransfer: true } : {}),
      },
    },
    ...recipients.map((recipient) =>
      updateNotificationAudit(actor, {
        vendorId: recipient,
        integrationId: pairId,
        integrationName: (changes.name as string | undefined) ?? pair.name,
        ownerVendorId: vendorId,
        ownerName: owner.companyName,
        fields: changed,
        pairSlugs,
      }),
    ),
  ];

  const stmts: BatchStmt[] = [
    db
      .update(connectorEvidencedPairs)
      .set({ ...columns, ...maintenanceTransferColumns(now), updatedAt: now })
      .where(evidencedOwnerWriteWhere(pairId, vendorId)),
    ownerWriteSentinel(db),
    ...audits.map((entry) => auditInsert(db, entry)),
  ];
  try {
    await db.batch(stmts as BatchTuple);
  } catch (error) {
    if (!isOwnerWriteRaceError(error)) throw error;
    const current = await db.query.connectorEvidencedPairs.findFirst({
      where: eq(connectorEvidencedPairs.id, pairId),
    });
    if (!current) throw notFoundError('integration', { id: pairId });
    throw (
      (await evidencedOwnerWriteRefusal(db, vendorId, current, session)) ??
      new ApiError(
        409,
        ApiErrorCode.INTEGRATION_CHANGED_WHILE_SAVING,
        'This integration changed while it was being saved. Reload and try again.',
      )
    );
  }

  dispatchOwnerWriteSearch(
    c,
    'vendor-edit-algolia',
    syncOwnerWriteSearch(
      c,
      db,
      { integrations: [pairId], products: [], vendors: [] },
      'aeci.api.vendor.edit_algolia_sync_failed',
    ),
  );

  const tags = [
    ...(pairSlugs
      ? [
          pairCacheTag(pairSlugs[0], pairSlugs[1]),
          `product:${pairSlugs[0]}`,
          `product:${pairSlugs[1]}`,
        ]
      : []),
    ...(connectorSlug ? [`product:${connectorSlug}`] : []),
  ];
  const base = publicSiteBase(c.env);
  const recrawl =
    pairSlugs && recrawlEnabled(c.env) && base
      ? attestationEditRecrawl(base, pairSlugs[0], pairSlugs[1])
      : undefined;
  afterVendorWrite(c, tags, audits, recrawl, db);

  const body: UpdateVendorIntegrationResponse = {
    integration: {
      id: pairId,
      changed,
      maintained_by: 'vendor',
      last_reviewed_at: now,
      updated_at: now,
    },
  };
  validateResponseInDev(c.env, () => UpdateVendorIntegrationResponseSchema.parse(body));
  return json(body);
}

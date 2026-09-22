/**
 * A vendor creates an integration (AECI-1011 / ADR 0035 decision 7 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7) — Drizzle/D1.
 *
 *   POST /api/vendor/integrations — the caller's vendor lists a new integration (201).
 *
 * `routes/vendor.ts` holds the narrative of this surface's invariants. Six rules of
 * this module's own:
 *
 * ── 1. A SEAT IS THE WHOLE GATE ─────────────────────────────────────────────
 * `requireVendor()` then `rateLimit('write')`, then the endpoint checks in the
 * handler, and no `requireCapability` and no Verified check (AECI-1003 decision 15).
 *
 * ── 2. ONE ENDPOINT IS THE CALLER'S, THE OTHER IS PUBLIC ────────────────────
 * `product_id` must be a promoted product the caller's vendor holds through
 * `product_vendors`; `counterpart_product_id` must be a promoted product. Either
 * miss is the same `404`, so a vendor cannot probe which products exist. The
 * schema refuses equal ids. The caller's product becomes the row's SOURCE, the
 * way upstream orients a row by its owner, and `direction` is framed against it.
 *
 * ── 3. THE CALLER OWNS IT FROM THE FIRST STATEMENT ──────────────────────────
 * `origin = 'vendor'`, `built_by_vendor_id` = caller, `claimed_at` = now, and
 * §13.9's maintenance transfer (`maintained_by = 'vendor'`, `last_reviewed_at` =
 * now). `claimed_at` is what puts the row behind the AECI-1005 promote fence, and
 * `origin` is what every orphan detector reads to leave it alone (§4.5.5).
 *
 * ── 4. NEVER CONNECTOR-POWERED ──────────────────────────────────────────────
 * No `powered_by` field exists on the body, and `iPaaS` / `integrator` are
 * refused, so `isConnectorPoweredEdge` is false for every row this route writes.
 * Decision 9 would otherwise freeze the new row against its own owner.
 *
 * ── 5. DUPLICATES WARN, NEVER REFUSE ────────────────────────────────────────
 * One strong-match query (`lib/integration-twins.ts`), both orientations. The
 * matches go back in `possible_duplicates` and their ids into the audit row's
 * `metadata.possibleDuplicateIds` (AECI-1012 ruling). Decision 10 holds.
 *
 * ── 6. ONE BATCH, THEN THE SAME TAIL AS A RETIRE ────────────────────────────
 * The INSERT, the `integration.created` audit row (the action the catalog
 * "additions" series counts, with the vendor actor), one `notification.sent` row
 * (`kind: 'integration_create'`) per other endpoint vendor, and both endpoints'
 * `integration_count` recomputed in the batch. After commit: by-id Algolia sync of
 * the integration, both products and the vendor behind `dispatchHook`; purge
 * `pair:`, both `product:`, `vendor:`, `index:products`, `taxonomy`, `sitemap`;
 * queue the pair and both product URLs for re-crawl through the IndexNow buffer.
 *
 * Nothing about a create can race a guard: the row is new, so there is no prior
 * state to lose. A concurrent create of the same pair is a duplicate, which is
 * allowed.
 */

import {
  ApiErrorCode,
  CreateVendorIntegrationResponseSchema,
  CreateVendorIntegrationSchema,
  INTEGRATION_EDIT_FIELDS,
  claimDirectionFromContext,
  integrationEditValueProblem,
  type ContextDirection,
  type CreateVendorIntegrationResponse,
  type IntegrationEditField,
  type PossibleDuplicateIntegration,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, inArray } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { integrations, products, productVendors, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { isConnectorPoweredEdge } from '../lib/connector-powered';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { claimColumns } from '../lib/integration-claims';
import { CONTEST_FIELD_COLUMNS } from '../lib/integration-contests';
import { createNotificationAudit, INTEGRATION_CREATED_ACTION } from '../lib/integration-create';
import { endpointSlugs } from '../lib/integration-owner-writes';
import { findStrongMatches, type StrongMatchRow } from '../lib/integration-twins';
import { publicSiteBase } from '../lib/public-urls';
import { integrationCountRecomputeStmt } from '../lib/recompute-counts';
import { pairCacheTag } from './promote-pair';
import { dispatchOwnerWriteSearch, syncOwnerWriteSearch } from './integration-retire-write';
import { attestationEditRecrawl } from './vendor-recrawl';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  parseJsonBody,
  recrawlEnabled,
  sessionVendorId,
  type VendorContext,
} from './vendor-shared';

/** Is this a promoted product, and (when `vendorId` is given) one that vendor
 *  holds? `false` for both misses, which the handler answers with the same 404. */
async function visibleProduct(db: Db, productId: string, vendorId?: string): Promise<boolean> {
  if (vendorId) {
    const hit = await db
      .select({ id: products.id })
      .from(products)
      .innerJoin(
        productVendors,
        and(eq(productVendors.productId, products.id), eq(productVendors.vendorId, vendorId)),
      )
      .where(and(eq(products.id, productId), eq(products.promotionStatus, 'promoted')))
      .limit(1);
    return hit.length > 0;
  }
  const hit = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.promotionStatus, 'promoted')))
    .limit(1);
  return hit.length > 0;
}

function toPossibleDuplicate(
  row: StrongMatchRow,
  ownProductId: string,
): PossibleDuplicateIntegration {
  return {
    id: row.id,
    name: row.name,
    mechanism_kind: row.mechanismKind as PossibleDuplicateIntegration['mechanism_kind'],
    mechanism_name: row.mechanismName,
    orientation: row.sourceProductId === ownProductId ? 'same' : 'reversed',
    owner:
      row.builtByVendorId && row.ownerName
        ? { id: row.builtByVendorId, name: row.ownerName }
        : null,
    claimed: row.claimedAt !== null,
    retired: row.retiredAt !== null,
  };
}

export function createCreateVendorIntegrationHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);

    // 1. Shape: 400 for an unknown key, a missing required field, equal ids.
    const payload = await parseJsonBody(c, CreateVendorIntegrationSchema);
    const sourceId = payload.product_id;
    const targetId = payload.counterpart_product_id;

    // 2. The endpoints. Same 404 for "not yours", "not promoted" and "no such id".
    const [ownVisible, otherVisible] = await Promise.all([
      visibleProduct(db, sourceId, vendorId),
      visibleProduct(db, targetId),
    ]);
    if (!ownVisible) throw notFoundError('product', { id: sourceId });
    if (!otherVisible) throw notFoundError('product', { id: targetId });

    // 3. Values — a business rule per field, so 422 rather than 400. The same rule
    //    the owner edit applies, so "what an owner may write" is one definition.
    const values: Partial<Record<IntegrationEditField, string>> = {};
    for (const field of INTEGRATION_EDIT_FIELDS) {
      const wire = payload[field];
      if (wire === undefined || wire === null) continue;
      const problem = integrationEditValueProblem(field, wire);
      if (problem) {
        throw new ApiError(422, ApiErrorCode.INTEGRATION_INVALID_VALUE, problem, { field });
      }
      values[field] =
        field === 'direction' ? claimDirectionFromContext(wire as ContextDirection, true) : wire;
    }
    // Decision 9, belt and braces: the real predicate, over the row as it will be.
    if (
      isConnectorPoweredEdge({
        poweredByProductId: null,
        mechanismKind: values.mechanism_kind ?? null,
      })
    ) {
      throw new ApiError(
        422,
        ApiErrorCode.INTEGRATION_INVALID_VALUE,
        'A connector-delivered integration type cannot be set here',
        { field: 'mechanism_kind' },
      );
    }

    // 4. Everything the batch and the tail need, in one wave. The duplicate query
    //    is the one strong-match SELECT; it never refuses anything.
    const [owner, duplicates, pairSlugs, endpointVendors] = await Promise.all([
      db.query.vendors.findFirst({
        columns: { id: true, slug: true, companyName: true },
        where: eq(vendors.id, vendorId),
      }),
      findStrongMatches(db, {
        productIds: [sourceId, targetId],
        poweredByProductId: null,
        ownerVendorId: vendorId,
      }),
      endpointSlugs(db, sourceId, targetId),
      db
        .select({ vendorId: productVendors.vendorId })
        .from(productVendors)
        .where(inArray(productVendors.productId, [sourceId, targetId])),
    ]);
    if (!owner) throw notFoundError('vendor', { id: vendorId });

    // Every vendor of either endpoint except the creator.
    const recipients = [...new Set(endpointVendors.map((row) => row.vendorId))]
      .filter((id) => id !== vendorId)
      .sort();
    const possibleDuplicates = duplicates.map((row) => toPossibleDuplicate(row, sourceId));

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const columns: Record<string, string> = {};
    for (const [field, value] of Object.entries(values) as [IntegrationEditField, string][]) {
      columns[CONTEST_FIELD_COLUMNS[field]] = value;
    }
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: INTEGRATION_CREATED_ACTION,
        entityType: 'integration',
        entityId: id,
        afterState: {
          ...values,
          source_product_id: sourceId,
          target_product_id: targetId,
          built_by_vendor_id: vendorId,
          origin: 'vendor',
          claimed_at: now,
          maintained_by: 'vendor',
          last_reviewed_at: now,
        },
        metadata: {
          source: AUDIT_SOURCE,
          vendorId,
          reason: 'vendor-create',
          possibleDuplicateIds: possibleDuplicates.map((dup) => dup.id),
        },
      },
      ...recipients.map((recipient) =>
        createNotificationAudit(actor, {
          vendorId: recipient,
          integrationId: id,
          integrationName: values.name ?? null,
          ownerVendorId: vendorId,
          ownerName: owner.companyName,
          pairSlugs,
        }),
      ),
    ];

    const stmts: BatchStmt[] = [
      db.insert(integrations).values({
        id,
        ...columns,
        sourceProductId: sourceId,
        targetProductId: targetId,
        builtByVendorId: vendorId,
        poweredByProductId: null,
        origin: 'vendor',
        ...claimColumns(now),
        createdAt: now,
        updatedAt: now,
      }),
      ...audits.map((entry) => auditInsert(db, entry)),
      // Last: both endpoints' counts over the row as this batch leaves it, so the
      // purge below can never race a stale count (the AECI-1010 pattern).
      integrationCountRecomputeStmt(db, sourceId),
      integrationCountRecomputeStmt(db, targetId),
    ];
    await db.batch(stmts as BatchTuple);

    dispatchOwnerWriteSearch(
      c,
      'vendor-create-algolia',
      syncOwnerWriteSearch(
        c,
        db,
        { integrations: [id], products: [sourceId, targetId], vendors: [vendorId] },
        'aeci.api.vendor.create_algolia_sync_failed',
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
      `vendor:${owner.slug}`,
      'index:products',
      'taxonomy',
      'sitemap',
    ];
    const base = publicSiteBase(c.env);
    const recrawl =
      pairSlugs && recrawlEnabled(c.env) && base
        ? attestationEditRecrawl(base, pairSlugs[0], pairSlugs[1])
        : undefined;
    afterVendorWrite(c, tags, audits, recrawl, db);

    const body: CreateVendorIntegrationResponse = {
      integration: {
        id,
        source_product_id: sourceId,
        target_product_id: targetId,
        origin: 'vendor',
        owner_vendor_id: vendorId,
        claimed_at: now,
        maintained_by: 'vendor',
        last_reviewed_at: now,
        created_at: now,
        updated_at: now,
      },
      possible_duplicates: possibleDuplicates,
    };
    validateResponseInDev(c.env, () => CreateVendorIntegrationResponseSchema.parse(body));
    return json(body, { status: 201 });
  };
}

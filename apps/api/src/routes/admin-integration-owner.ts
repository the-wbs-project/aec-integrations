/**
 * The owner of a connector-delivered pair, in the admin console (AECI-2045,
 * `ADMIN_PANEL_SPEC.md` §5.7 "Delivered pairs").
 *
 *   GET /api/admin/products/:id/delivered-pairs — every pair the connector product
 *     delivers, in both tables, live and retired, with owner and claimed state. No
 *     catalogue row is needed (`/admin/connectors` needs one), so a Sync Service
 *     with no catalogue is listed. A read: no rate limit, no audit row.
 *   PUT /api/admin/integrations/:id/owner — set or change `built_by_vendor_id` on a
 *     connector-delivered row, in either table, with a required reason. The fortieth
 *     §2 exception, a MODERATION write.
 *
 * ── ONE WRITER ──────────────────────────────────────────────────────────────
 * The write is the `owner-reassigned` case of an AECi `owner` contest accept
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.6), through the same `planOwnerReassign`: the
 * owner changes, `claimed_at` and the edit caption clear (the new owner has not
 * acted), and every open owner-routed contest on the row moves to AECi. The batch
 * opens with the accept's state sentinel, so a claim, a re-point or a promote move
 * landing between the read and the batch writes nothing and answers
 * `409 INTEGRATION_CHANGED_WHILE_SAVING`.
 *
 * An unclaimed row is written the same way. Promote still writes an unclaimed row,
 * so the next promote of the edge can set a different owner; the runbook says to
 * record the owner upstream too. A retired row is not refused: no rule bars it, and
 * the owner is who may restore it.
 *
 * After commit: the pair, endpoint and connector purge (`anchorPurgeTags`), the by-id
 * Algolia sync, the ownership record re-sent for the old AND the new owner, and one
 * batched PostHog forward.
 */

import {
  AdminDeliveredPairsResponseSchema,
  AdminSetIntegrationOwnerResponseSchema,
  AdminSetIntegrationOwnerSchema,
  ApiErrorCode,
  type AdminDeliveredPair,
  type AdminDeliveredPairsResponse,
  type ContestVendorRef,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { compareText } from '@aeci/shared/text-sort';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import { aeciOverrideNotificationAudit } from '../lib/aeci-override-notifications';
import { productVendors, products, vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import {
  vendorsForEvidencedPairSlots,
  vendorsForIntegrationSlots,
} from '../lib/attestation-authority';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { vendorAuditStamp } from '../lib/audit-vendor';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import {
  linkOrStub,
  loadDeliveredPairs,
  vendorNamesById,
  type DeliveredPairRow,
} from '../lib/delivered-pairs';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  anchorMetadata,
  anchorPurgeTags,
  anchorWriteMarkers,
  contestIntegrationStateSentinel,
  isContestRaceError,
  loadContestTarget,
  locateContestAnchor,
  type ContestTarget,
} from '../lib/integration-contests';
import { dispatchMirrorSync, mirrorVendorEntries } from '../lib/ownership-sync';
import { forwardModerationBatch, planOwnerReassign, readJson } from './admin-contests';
import { endpointSlugs } from './vendor-contests';
import { dispatchOwnerWriteSearch, syncOwnerWriteSearch } from './integration-retire-write';
import { pairCacheTag } from './promote-pair';
import { purgeTags } from './vendor-shared';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** A safety cap. One connector's pairs number in the tens. */
const MAX_PAIRS = 500;

function idParam(c: AdminContext): string {
  const id = c.req.param('id');
  if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
  return id;
}

/** The endpoint vendors of each row, named, A to Z. */
async function endpointVendorsByRow(
  db: Db,
  rows: readonly Pick<DeliveredPairRow, 'id' | 'anchor'>[],
): Promise<Map<string, string[]>> {
  const [pairSlots, rowSlots] = await Promise.all([
    vendorsForEvidencedPairSlots(
      db,
      rows.filter((r) => r.anchor === 'evidenced_pair').map((r) => r.id),
    ),
    vendorsForIntegrationSlots(
      db,
      rows.filter((r) => r.anchor === 'integration').map((r) => r.id),
    ),
  ]);
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const slots = (r.anchor === 'evidenced_pair' ? pairSlots : rowSlots).get(r.id)?.slots;
    out.set(r.id, [...new Set([...(slots?.vendor_a ?? []), ...(slots?.vendor_b ?? [])])]);
  }
  return out;
}

function named(ids: readonly string[], names: Map<string, string>): ContestVendorRef[] {
  return ids
    .map((id) => ({ id, name: names.get(id) ?? id }))
    .sort((a, b) => compareText(a.name, b.name) || (a.id < b.id ? -1 : 1));
}

async function shapePairs(
  db: Db,
  rows: readonly DeliveredPairRow[],
  links: Parameters<typeof linkOrStub>[0],
) {
  const endpointVendors = await endpointVendorsByRow(db, rows);
  const names = await vendorNamesById(db, [
    ...rows.map((r) => r.builtByVendorId),
    ...[...endpointVendors.values()].flat(),
  ]);
  return {
    names,
    pairs: rows.map(
      (r): AdminDeliveredPair => ({
        id: r.id,
        anchor: r.anchor,
        name: r.name,
        product_a: linkOrStub(links, r.productAId),
        product_b: linkOrStub(links, r.productBId),
        owner: r.builtByVendorId
          ? { id: r.builtByVendorId, name: names.get(r.builtByVendorId) ?? r.builtByVendorId }
          : null,
        claimed_at: r.claimedAt,
        retired_at: r.retiredAt,
        retired_by: r.retiredBy,
        endpoint_vendors: named(endpointVendors.get(r.id) ?? [], names),
      }),
    ),
  };
}

// ─── GET /api/admin/products/:id/delivered-pairs ─────────────────────────────

export function createAdminDeliveredPairsHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const id = idParam(c);
    const { db } = dbFor(c.env);
    const product = await db.query.products.findFirst({
      columns: { id: true, name: true, slug: true, productRole: true, connectorKind: true },
      where: eq(products.id, id),
    });
    if (!product) throw notFoundError('product', { id });
    if (product.productRole !== 'connector' && product.productRole !== 'hybrid') {
      throw new ApiError(
        409,
        ApiErrorCode.CONNECTOR_KIND_NOT_CONNECTOR,
        'Only a connector product delivers pairs.',
      );
    }
    const [{ rows, links }, connectorVendorRows] = await Promise.all([
      loadDeliveredPairs(db, id, MAX_PAIRS),
      db
        .select({ id: vendors.id, name: vendors.companyName })
        .from(productVendors)
        .innerJoin(vendors, eq(vendors.id, productVendors.vendorId))
        .where(eq(productVendors.productId, id)),
    ]);
    const { pairs } = await shapePairs(db, rows, links);
    const body: AdminDeliveredPairsResponse = {
      connector: {
        id: product.id,
        name: product.name,
        slug: product.slug,
        connector_kind:
          product.connectorKind === 'integration_platform' ||
          product.connectorKind === 'sync_service'
            ? product.connectorKind
            : null,
      },
      connector_vendors: named(
        connectorVendorRows.map((v) => v.id),
        new Map(connectorVendorRows.map((v) => [v.id, v.name])),
      ),
      pairs,
    };
    validateResponseInDev(c.env, () => AdminDeliveredPairsResponseSchema.parse(body));
    return json(body);
  };
}

// ─── PUT /api/admin/integrations/:id/owner ───────────────────────────────────

/** The admin row for one delivered pair, read through the list's own loader so the
 *  two shapes cannot differ. */
async function pairOf(db: Db, target: ContestTarget): Promise<AdminDeliveredPair> {
  const { rows, links } = await loadDeliveredPairs(db, target.poweredByProductId!, 2, target.id);
  const row = rows.find((r) => r.id === target.id && r.anchor === target.anchor.kind);
  if (!row) throw notFoundError('integration', { id: target.id });
  const { pairs } = await shapePairs(db, [row], links);
  return pairs[0]!;
}

export function createAdminSetIntegrationOwnerHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = idParam(c);
    const payload = await AdminSetIntegrationOwnerSchema.parseAsync(await readJson(c));
    const { db } = writeDb(c, dbFor);

    const anchor = await locateContestAnchor(db, id);
    const target = await loadContestTarget(db, anchor);
    if (!target) throw notFoundError('integration', { id });
    // Only a row a connector delivers. A direct integration's owner is the vendor that
    // built it, decided upstream and by an `owner` contest, never here.
    // A Convention-A self-reference names its connector as one of its own endpoints: a
    // direct integration of that product, which the delivered list leaves out too.
    if (
      !target.connectorPowered ||
      !target.poweredByProductId ||
      target.poweredByProductId === target.sourceProductId ||
      target.poweredByProductId === target.targetProductId
    ) {
      throw new ApiError(
        409,
        ApiErrorCode.INTEGRATION_NOT_CONNECTOR_DELIVERED,
        'Only an integration delivered through a connector product can have its owner set here.',
      );
    }
    const newOwner = payload.owner_vendor_id;
    if (newOwner !== null) {
      const vendor = await db.query.vendors.findFirst({
        columns: { id: true },
        where: eq(vendors.id, newOwner),
      });
      if (!vendor) {
        throw new ApiError(422, 'VALIDATION_FAILED', 'No company has that id.', {
          field: 'owner_vendor_id',
        });
      }
    }
    if (target.builtByVendorId === newOwner) {
      const body = { changed: false, pair: await pairOf(db, target) };
      validateResponseInDev(c.env, () => AdminSetIntegrationOwnerResponseSchema.parse(body));
      return json(body);
    }

    const now = new Date().toISOString();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const reassign = await planOwnerReassign(db, {
      anchor,
      integration: target,
      newOwnerVendorId: newOwner,
      decidingContestId: null,
      actor,
      now,
      metadata: {
        source: 'admin-owner-write',
        ...anchorMetadata(anchor),
        ...anchorWriteMarkers(target),
        // The audit row's `reason` stays 'owner-reassigned' (the accept's value). The
        // admin's text is here, and in the displaced owner's notice below.
        adminReason: payload.reason,
      },
    });
    // The write is about the row the old owner held: stamp it with that vendor, as the
    // accept stamps its catalog write (AECI-1192). A row with no owner stays unstamped.
    const stamp = await vendorAuditStamp(db, target.builtByVendorId);
    const audits: AuditLogEntry[] = reassign.audits.map((entry) =>
      entry.vendorId ? entry : { ...entry, ...stamp },
    );
    // The displaced owner of a claimed row is told, with the reason, in the same batch:
    // the notice the `owner` contest accept sends when it takes a claim (AECI-1159).
    if (target.claimedAt !== null && target.builtByVendorId !== null) {
      audits.push(
        aeciOverrideNotificationAudit('portal-field-overridden-by-aeci', actor, {
          event: 'field_overridden',
          vendorId: target.builtByVendorId,
          reason: payload.reason,
          integrationId: target.id,
          integrationName: target.name,
          field: 'owner',
          pairSlugs: await endpointSlugs(db, target.sourceProductId, target.targetProductId),
          entityType: anchor.kind === 'evidenced_pair' ? 'connector_evidenced_pair' : 'integration',
        }),
      );
    }
    const stmts: BatchStmt[] = [
      contestIntegrationStateSentinel(db, anchor, {
        claimed: target.claimedAt !== null,
        ownerVendorId: target.builtByVendorId,
      }),
      ...reassign.stmts,
      ...audits.map((entry) => auditInsert(db, entry)),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isContestRaceError(error)) throw error;
      throw new ApiError(
        409,
        ApiErrorCode.INTEGRATION_CHANGED_WHILE_SAVING,
        'This integration changed while you were saving: it was claimed, moved or given another owner. Nothing was saved. Reload and try again.',
      );
    }

    forwardModerationBatch(c, audits, []);
    const tags = (await anchorPurgeTags(db, target, pairCacheTag)).tags;
    if (tags.length) c.executionCtx.waitUntil(purgeTags(c, tags, 'moderation'));
    dispatchOwnerWriteSearch(
      c,
      'admin-owner-write-algolia',
      syncOwnerWriteSearch(
        c,
        db,
        { integrations: [anchor.id], products: [], vendors: [] },
        'aeci.api.admin.owner_write_algolia_sync_failed',
      ),
    );
    // The ownership record of BOTH owners changes: the row leaves the old owner's
    // `deliveredPairs[]` and joins the new one's. The edge targets resolve only the
    // owner on file after commit, so both are named explicitly.
    dispatchMirrorSync(
      c,
      [...audits, ...mirrorVendorEntries([target.builtByVendorId, newOwner])],
      'admin',
      db,
    );

    const after = await loadContestTarget(db, anchor);
    const body = { changed: true, pair: await pairOf(db, after ?? target) };
    validateResponseInDev(c.env, () => AdminSetIntegrationOwnerResponseSchema.parse(body));
    return json(body);
  };
}

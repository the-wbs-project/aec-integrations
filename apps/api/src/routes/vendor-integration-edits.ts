/**
 * Owner edits of an integration's standard fields (AECI-1006 / ADR 0035 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.6) — Drizzle/D1.
 *
 *   PATCH /api/vendor/integrations/:id — the claimed owner edits its row (200).
 *
 * `routes/vendor.ts` holds the narrative of this surface's invariants. Five rules
 * of this module's own:
 *
 * ── 1. A SEAT IS THE WHOLE GATE ─────────────────────────────────────────────
 * `requireVendor()` then `rateLimit('write')`, then the ownership gate in the
 * handler, and no `requireCapability` and no Verified check (AECI-1003 decision
 * 15). The same named exception to §6.14 that contests and the claim took.
 *
 * ── 2. ONLY THE CLAIMED OWNER, IN THE CLAIM'S REFUSAL ORDER ─────────────────
 * `ownerWriteRefusal` (`lib/integration-owner-writes.ts`): unknown or invisible
 * row 404, endpoint non-owner 403 / 409, connector-powered 403, unclaimed 409
 * `INTEGRATION_NOT_CLAIMED`, retired 409 `INTEGRATION_RETIRED` (AECI-1010, through
 * `assertIntegrationLive`). An unclaimed row is still promote's to write, so an
 * edit there would be overwritten by the next promote of the edge; claiming first
 * is what makes the edit stick.
 *
 * ── 3. THE ELEVEN CONTESTABLE CONTENT FIELDS, AND NOTHING ELSE ──────────────
 * The field set is AECI-1008's contest set minus `owner`, mapped through the same
 * `CONTEST_FIELD_COLUMNS`, so "what a non-owner may contest" and "what the owner
 * may edit" cannot drift apart. `notes` is AECi's curation column and is not
 * editable. No value may make the row connector-powered (decision 9).
 *
 * ── 4. ONE BATCH ────────────────────────────────────────────────────────────
 * The guarded `UPDATE … WHERE built_by_vendor_id = <caller> AND claimed_at IS NOT
 * NULL AND retired_at IS NULL` (the changed columns, §13.9's maintenance transfer and `updated_at`), then
 * `ownerWriteSentinel` immediately after it, then the `integration.updated` audit
 * row with before/after and one `notification.sent` row (`kind:
 * 'integration_update'`) per other endpoint vendor. A lost race writes nothing and
 * answers what the pre-check would now answer. A body that changes nothing writes
 * nothing, not even an audit row.
 *
 * ── 5. OPEN CONTESTS ARE NOT TOUCHED ────────────────────────────────────────
 * An edit never closes, accepts or re-routes a contest. A contest is a request to
 * its decider, and only the decider closes it, with a decision the submitter is
 * told about (§11b.5). If the owner's edit already made the change a contest asked
 * for, the owner accepts or declines it in Messages as usual. See §4.5.6.
 *
 * After commit: a by-id Algolia sync of the integration record, behind promote's
 * `dispatchHook` watchdog, the same `syncOwnerWriteSearch` tail retire and create
 * use. That is how a changed mechanism, direction or description reaches search
 * without waiting for the nightly `updated_at` watermark sweep. Only the
 * integration record is synced, because an edit changes no count on either product
 * or the vendor. Then purge `pair:{a}__{b}` and both `product:` tags, queue the pair
 * re-crawl, and forward the audit rows. The `updated_at` bump still puts the row in
 * the watermark sweep as a backstop, and moves the `integrations` freshness cursor
 * for both endpoint vendors.
 */

import {
  ApiErrorCode,
  INTEGRATION_EDIT_FIELDS,
  UpdateVendorIntegrationResponseSchema,
  UpdateVendorIntegrationSchema,
  claimDirectionFromContext,
  integrationEditValueProblem,
  type ContextDirection,
  type IntegrationEditField,
  type UpdateVendorIntegrationResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { eq } from 'drizzle-orm';

import { getDb } from '../db/client';
import { integrations, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { vendorsForIntegrationSlots } from '../lib/attestation-authority';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { isConnectorPoweredEdge } from '../lib/connector-powered';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { CONTEST_FIELD_COLUMNS, storedFieldValue } from '../lib/integration-contests';
import {
  endpointSlugs,
  isOwnerWriteRaceError,
  ownedEndpointIds,
  ownerWriteRefusal,
  ownerWriteSentinel,
  ownerWriteWhere,
  updateNotificationAudit,
} from '../lib/integration-owner-writes';
import { publicSiteBase } from '../lib/public-urls';
import { pairCacheTag } from './promote-pair';
import { dispatchOwnerWriteSearch, syncOwnerWriteSearch } from './integration-retire-write';
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

/** `audit_log.action` for an owner edit. The same action an owner contest accept
 *  and an AECi accept on a claimed row write, told apart by `metadata.reason`. */
export const INTEGRATION_UPDATED_ACTION = 'integration.updated';

export function createUpdateVendorIntegrationHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const integrationId = c.req.param('id');
    if (!integrationId) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    }
    const { db } = writeDb(c, dbFor);

    // 1. The row, alone in its wave. An unknown id and an invisible one are both 404.
    const row = await db.query.integrations.findFirst({
      where: eq(integrations.id, integrationId),
    });
    if (!row) throw notFoundError('integration', { id: integrationId });

    // 2. Ownership, connector-powered, claimed, live. Before the body, so a non-owner
    //    cannot probe the row's rules with crafted bodies.
    const refusal = await ownerWriteRefusal(db, vendorId, row);
    if (refusal) throw refusal;

    // 3. Shape: a 400 for an unknown key, a bad length or an empty body.
    const payload = await parseJsonBody(c, UpdateVendorIntegrationSchema);

    // 4. The direction frame. The owner may frame against either endpoint (it
    //    owns the row, not necessarily a product on it). Omitted means its own
    //    endpoint, source first, and the source when it owns neither.
    const owned = await ownedEndpointIds(db, vendorId, row);
    const endpoints = [row.sourceProductId, row.targetProductId];
    if (payload.context_product_id && !endpoints.includes(payload.context_product_id)) {
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        'context_product_id must be one of this integration’s two products',
        { field: 'context_product_id' },
      );
    }
    const contextIsSource = payload.context_product_id
      ? payload.context_product_id === row.sourceProductId
      : owned.includes(row.sourceProductId) || !owned.includes(row.targetProductId);

    // 5. Values — a business rule per field, so 422 rather than 400.
    const changes: Partial<Record<IntegrationEditField, string | null>> = {};
    for (const field of INTEGRATION_EDIT_FIELDS) {
      const wire = payload[field];
      if (wire === undefined) continue;
      const problem = integrationEditValueProblem(field, wire);
      if (problem) {
        throw new ApiError(422, ApiErrorCode.INTEGRATION_INVALID_VALUE, problem, { field });
      }
      const stored =
        field === 'direction' && wire !== null
          ? claimDirectionFromContext(wire as ContextDirection, contextIsSource)
          : wire;
      if (stored !== storedFieldValue(row, field)) changes[field] = stored;
    }
    // Decision 9, belt and braces: the shared rule refuses the connector kinds by
    // name, and this asks the real predicate about the row as it would be.
    const nextKind = changes.mechanism_kind ?? row.mechanismKind;
    if (
      isConnectorPoweredEdge({
        poweredByProductId: row.poweredByProductId,
        mechanismKind: nextKind,
      })
    ) {
      throw new ApiError(
        422,
        ApiErrorCode.INTEGRATION_INVALID_VALUE,
        'A connector-delivered integration type cannot be set here',
        { field: 'mechanism_kind' },
      );
    }

    const changed = INTEGRATION_EDIT_FIELDS.filter((field) => field in changes);
    if (changed.length === 0) {
      // Every sent value equals the one on record: nothing to write, audit or tell.
      const body: UpdateVendorIntegrationResponse = {
        integration: {
          id: integrationId,
          changed: [],
          maintained_by: row.maintainedBy === 'vendor' ? 'vendor' : 'aeci',
          last_reviewed_at: row.lastReviewedAt ?? null,
          updated_at: row.updatedAt,
        },
      };
      validateResponseInDev(c.env, () => UpdateVendorIntegrationResponseSchema.parse(body));
      return json(body);
    }

    const [owner, slotVendors, pairSlugs] = await Promise.all([
      db.query.vendors.findFirst({
        columns: { id: true, companyName: true },
        where: eq(vendors.id, vendorId),
      }),
      vendorsForIntegrationSlots(db, [integrationId]),
      endpointSlugs(db, row.sourceProductId, row.targetProductId),
    ]);
    if (!owner) throw notFoundError('vendor', { id: vendorId });

    // Every vendor of either endpoint, except the owner itself.
    const slots = slotVendors.get(integrationId)?.slots;
    const recipients = [...new Set([...(slots?.vendor_a ?? []), ...(slots?.vendor_b ?? [])])]
      .filter((id) => id !== vendorId)
      .sort();

    const now = new Date().toISOString();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const beforeState: Record<string, unknown> = {};
    const afterState: Record<string, unknown> = {};
    const columns: Record<string, string | null> = {};
    for (const field of changed) {
      beforeState[field] = storedFieldValue(row, field);
      afterState[field] = changes[field] ?? null;
      columns[CONTEST_FIELD_COLUMNS[field]] = changes[field] ?? null;
    }
    beforeState.maintained_by = row.maintainedBy;
    beforeState.last_reviewed_at = row.lastReviewedAt;
    afterState.maintained_by = 'vendor';
    afterState.last_reviewed_at = now;

    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: INTEGRATION_UPDATED_ACTION,
        entityType: 'integration',
        entityId: integrationId,
        beforeState,
        afterState,
        metadata: {
          source: AUDIT_SOURCE,
          vendorId,
          reason: 'owner-edit',
          fields: changed,
          // Present only on the hand-changing write, never as `false` (§13.9).
          ...(isMaintenanceTransfer(row) ? { maintenanceTransfer: true } : {}),
        },
      },
      ...recipients.map((recipient) =>
        updateNotificationAudit(actor, {
          vendorId: recipient,
          integrationId,
          integrationName: (changes.name as string | undefined) ?? row.name,
          ownerVendorId: vendorId,
          ownerName: owner.companyName,
          fields: changed,
          pairSlugs,
        }),
      ),
    ];

    const stmts: BatchStmt[] = [
      db
        .update(integrations)
        .set({ ...columns, ...maintenanceTransferColumns(now), updatedAt: now })
        // Still the caller's, still claimed: an AECi `owner` accept that landed
        // after the read above reassigned the row and cleared `claimed_at`.
        .where(ownerWriteWhere(integrationId, vendorId)),
      // Immediately after the guarded UPDATE: a lost race aborts the batch here.
      ownerWriteSentinel(db),
      ...audits.map((entry) => auditInsert(db, entry)),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isOwnerWriteRaceError(error)) throw error;
      const current = await db.query.integrations.findFirst({
        where: eq(integrations.id, integrationId),
      });
      if (!current) throw notFoundError('integration', { id: integrationId });
      throw (
        (await ownerWriteRefusal(db, vendorId, current)) ??
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
        { integrations: [integrationId], products: [], vendors: [] },
        'aeci.api.vendor.edit_algolia_sync_failed',
      ),
    );

    const tags = pairSlugs
      ? [
          pairCacheTag(pairSlugs[0], pairSlugs[1]),
          `product:${pairSlugs[0]}`,
          `product:${pairSlugs[1]}`,
        ]
      : [];
    const base = publicSiteBase(c.env);
    const recrawl =
      pairSlugs && recrawlEnabled(c.env) && base
        ? attestationEditRecrawl(base, pairSlugs[0], pairSlugs[1])
        : undefined;
    afterVendorWrite(c, tags, audits, recrawl, db);

    const body: UpdateVendorIntegrationResponse = {
      integration: {
        id: integrationId,
        changed,
        maintained_by: 'vendor',
        last_reviewed_at: now,
        updated_at: now,
      },
    };
    validateResponseInDev(c.env, () => UpdateVendorIntegrationResponseSchema.parse(body));
    return json(body);
  };
}

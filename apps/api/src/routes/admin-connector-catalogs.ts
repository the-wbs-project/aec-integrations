/**
 * The per-iPaaS management cutoff (AECI-720 — `docs/DATABASE_SCHEMA.md` §9a.1).
 *
 *   PATCH /api/admin/connector-catalogs/:id — behind `requireAdmin()`.
 *
 * Flips `connector_catalogs.managed_by`. Moving a catalogue to `vendor` freezes the
 * review lane for that iPaaS and no other: from then on `planConnectorCatalogPage`
 * refuses every page for it with `CATALOG_VENDOR_MANAGED`, before it builds a single
 * statement. The flag is held AND enforced on this side because the review app is the
 * component being decommissioned, so the surviving system owns who-controls-what — which
 * is also why `managedBy` is not on the promote wire at all.
 *
 * ── THE EIGHT MOVES ─────────────────────────────────────────────────────────────
 * Cloned from `createBanReviewerHandler` (`admin-reviewers.ts`), the canonical
 * reversible-flag admin handler: write-path db → preload gate (404) → 422 idempotency
 * gate → derive from/to → build the audit entry → ONE `db.batch` with the guarded UPDATE
 * → metric → post-commit `waitUntil` forward → `validateResponseInDev`.
 *
 * Eight, not the template's nine, and both absences are argued rather than dropped:
 *
 *   - **No `workflow_transitions` row.** `createBanReviewerHandler` writes one, but
 *     `workflow_instances_type_check` is a CLOSED check — `('vendor_claim',
 *     'review_moderation', 'correction_request', 'reviewer_ban')` — and opening it on
 *     SQLite is a full table rebuild. `audit_log` IS the ledger here, exactly as
 *     `admin-entitlements.ts` settles for entitlements: `audit_log_entity_idx` is
 *     `(entity_type, entity_id, created_at)`, so `entity_type='connector_catalog',
 *     entity_id=<catalogue>` yields the whole handover trail with no new index and no
 *     new read path.
 *   - **No cache purge.** A positive statement, not an omission: nothing reads
 *     `connector_catalogs` — no SSR route, no Algolia record, no `Cache-Tag`. The only
 *     other reference in the codebase is the promote planner. Don't enqueue a purge with
 *     no tag to purge. When AECI-715 / 716 / 722 render this data, whoever builds the
 *     first read surface owns the tag set.
 *
 * ── AUDIT GRANULARITY ───────────────────────────────────────────────────────────
 * Per row, in the same batch. ADR 0022 and `STAGE_1_SPEC.md` §26.1 both name this flip
 * by name as the decision-bearing write that audits per row *"like any other domain-state
 * write"* — explicitly distinguishing it from the run-granularity carve-out that governs
 * the connector-catalogue sync on the very same tables.
 *
 * ── NO SEAT IS GRANTED HERE ─────────────────────────────────────────────────────
 * `vendorId` records who the catalogue was handed to and grants nothing.
 * `STAGE_2_SPEC.md` §8.9(2) fences the connector seat off from `vendor_entitlements`
 * entirely, and §8.9(3) leaves provisioning — no route writes `profiles.role =
 * 'vendor_admin'` today — to AECI-722 / AECI-724.
 */

import {
  ApiErrorCode,
  ConnectorCatalogManagementResponseSchema,
  SetConnectorCatalogManagementSchema,
  type ConnectorCatalogManagementResponse,
  type ConnectorManagedBy,
} from '@aeci/shared';
import {
  forwardAuditLog,
  type AuditLogEntry,
  type AuditLogForwarder,
} from '@aeci/shared/audit-log';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { connectorCatalogs, vendors } from '../db/schema';
import { logToPosthog, submitCount } from '../posthog';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';

type CatalogContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** The audit `source` facet, matching the forwarder tag. */
const AUDIT_SOURCE = 'admin-connector-catalog';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Telemetry forwarder for the audit write; no-ops without the PostHog key. */
function makeForwarder(c: CatalogContext): AuditLogForwarder | undefined {
  if (!c.env.POSTHOG_PROJECT_KEY) return undefined;
  return (entry) => {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: AUDIT_SOURCE,
    });
  };
}

/**
 * `aeci.connector_catalog.management` — one count per attempt, tagged by destination
 * state and outcome. Emitted on EVERY branch including the rejections, so the series
 * answers "how often does an operator try to flip something that has already moved?"
 * as well as "when did this lane freeze?".
 */
function emitManagementAction(
  c: CatalogContext,
  to: ConnectorManagedBy,
  outcome: 'ok' | 'invalid_state' | 'not_found',
): void {
  submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.connector_catalog.management', 1, [
    `to:${to}`,
    `outcome:${outcome}`,
  ]);
}

async function parseJsonBody(c: CatalogContext) {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
  }
  return SetConnectorCatalogManagementSchema.parse(raw);
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export function createSetConnectorCatalogManagementHandler(
  dbFor: DbFactory = getDb,
): (c: CatalogContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');

    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing catalogue id', {
        field: 'id',
      });
    }

    const payload = await parseJsonBody(c);
    const to = payload.managedBy;
    const { db } = writeDb(c, dbFor);

    // ── 1. Preload gate ──────────────────────────────────────────────────────
    const existing = await db.query.connectorCatalogs.findFirst({
      columns: { id: true, connectorProductId: true, managedBy: true },
      where: eq(connectorCatalogs.id, id),
    });
    if (!existing) {
      emitManagementAction(c, to, 'not_found');
      throw notFoundError('connector_catalog', { id });
    }

    // Validate the named vendor rather than trusting it. A typo would otherwise park a
    // dangling id in the audit metadata for AECI-722's screen to render — and this is
    // the only record of who the catalogue was handed to, so it has to be a real id.
    if (payload.vendorId) {
      const vendor = await db.query.vendors.findFirst({
        columns: { id: true },
        where: eq(vendors.id, payload.vendorId),
      });
      if (!vendor) {
        emitManagementAction(c, to, 'not_found');
        throw notFoundError('vendor', { id: payload.vendorId });
      }
    }

    // ── 2. Idempotency gate ──────────────────────────────────────────────────
    // A request naming the current state is a 422, not a silent no-op: an operator who
    // believes they just froze a lane that was already frozen has a different mental
    // model of who controls it, and that is worth surfacing.
    const from = existing.managedBy as ConnectorManagedBy;
    if (from === to) {
      emitManagementAction(c, to, 'invalid_state');
      throw new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        to === 'vendor'
          ? 'Catalogue is already vendor-managed; the review lane is already frozen for it.'
          : 'Catalogue is already review-managed; the review lane is already open for it.',
      );
    }

    const now = new Date().toISOString();

    // ── 3. The audit entry ───────────────────────────────────────────────────
    const auditEntry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action:
        to === 'vendor'
          ? 'connector_catalog.managed_by_vendor'
          : 'connector_catalog.managed_by_review',
      entityType: 'connector_catalog',
      entityId: id,
      beforeState: { managed_by: from },
      afterState: { managed_by: to },
      metadata: {
        source: AUDIT_SOURCE,
        connector_product_id: existing.connectorProductId,
        ...(payload.vendorId ? { vendor_id: payload.vendorId } : {}),
        ...(payload.reason ? { reason: payload.reason } : {}),
        // Explicit in the trail rather than inferred from `managed_by`, the same way
        // `lib/vendor-entitlement.ts` says `seats_untouched` out loud: a reader of this
        // row should not have to know that `vendor` implies the promote lane is shut.
        review_lane_frozen: to === 'vendor',
        // Equally explicit: this hands over authorship, not a portal seat. No
        // `vendor_entitlements` row is opened and no `vendor_admin` role is written
        // (§8.9(2)/(3)) — provisioning is AECI-722 / AECI-724's.
        seat_not_granted: true,
      },
    };

    // ── 4. ONE batch ─────────────────────────────────────────────────────────
    // The guarded `WHERE … AND managed_by = :from` makes the flip safe under a
    // concurrent action, and the audit row commits or rolls back with it (§26.1). D1 has
    // no interactive transactions; `db.batch` is the only atomic unit there is.
    const stmts: BatchStmt[] = [
      db
        .update(connectorCatalogs)
        .set({ managedBy: to, updatedAt: now })
        .where(and(eq(connectorCatalogs.id, id), eq(connectorCatalogs.managedBy, from))),
      auditInsert(db, auditEntry),
    ];
    await db.batch(stmts as BatchTuple);

    // ── 5. Metric, then post-commit forward ──────────────────────────────────
    emitManagementAction(c, to, 'ok');
    c.executionCtx.waitUntil(forwardAuditLog(auditEntry, makeForwarder(c)));

    // ── 6. Response ──────────────────────────────────────────────────────────
    // Derived from the action, not re-read: the guarded UPDATE either applied or the
    // batch threw, so the post-state is known exactly and cannot disagree with the batch
    // that just ran (the same argument `admin-entitlements.ts` makes for the mirror).
    const body: ConnectorCatalogManagementResponse = {
      id,
      connector_product_id: existing.connectorProductId,
      managed_by: to,
      managed_by_vendor_id: payload.vendorId ?? null,
      updated_at: now,
    };
    validateResponseInDev(c.env, () => {
      ConnectorCatalogManagementResponseSchema.parse(body);
    });
    return json(body);
  };
}

/**
 * Integration field contests, vendor side (`/api/vendor/*`, AECI-1008 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b) — Drizzle/D1.
 *
 *   POST /api/vendor/integrations/:id/contests   — submit a contest (201).
 *                                                  The id may name a connector-evidenced
 *                                                  pair (AECI-1092, §11b.13).
 *   GET  /api/vendor/contests                    — `{ submitted, received }`.
 *   POST /api/vendor/contests/:id/withdraw       — the submitter withdraws.
 *   POST /api/vendor/contests/:id/decision       — the owner accepts or declines.
 *
 * `routes/vendor.ts` holds the narrative of this surface's invariants. Five rules
 * of this module's own:
 *
 * ── 1. A SEAT IS THE WHOLE GATE ─────────────────────────────────────────────
 * `requireVendor()` only. No `requireCapability`, no Verified check. One exception
 * (AECI-1092, AECI-1040 ruling 2): the OWNER's decision on a connector-powered row
 * needs an active entitlement (`requireActiveEntitlement`), because it is an owner
 * write on such a row. Submitting and withdrawing never do. This is a
 * named exception to §6.14's "writes are entitlement-gated": a contest asks AECi
 * or the owner to fix a fact on a public page, and gating that behind a paid tier
 * would make accuracy something a vendor buys. It writes nothing public itself.
 *
 * ── 2. AUTHORITY IS DERIVED, AND A MISS IS A 404 ────────────────────────────
 * Who may contest is "owns an endpoint in `product_vendors`", resolved through
 * `resolveAttestationSlots` (the one implementation of that rule). A contest the
 * caller neither filed nor decides is a 404 indistinguishable from one that does
 * not exist. The owner of an integration gets a 403 instead, because by then it
 * has proven it owns an endpoint and the integration's existence is disclosed.
 *
 * ── 3. ORDER: AUTHORITY → OWNER → SHAPE → VALUE → DUPLICATE ─────────────────
 * The integration id is a path param, so ownership is proven before the body is
 * read (`vendor-product-versions.ts`'s order, not `vendor-attestations.ts`'s). A
 * `400` from the body therefore never answers a request that should have been a
 * flat `404`.
 *
 * ── 4. EVERY TRANSITION IS ONE BATCH ────────────────────────────────────────
 * The contest write, its `workflow_transitions` row (on a `correction_request`
 * instance), its `audit_log` row, and the `notification.sent` row for the other
 * side all commit together (§26.1). The decision handlers guard their UPDATE on
 * `status = 'open'` and follow it IMMEDIATELY with `contestStillOpenSentinel`,
 * which aborts the batch when that UPDATE matched nothing. So the loser of a race
 * writes nothing at all — no audit row, no transition, no catalog change, and
 * above all no notification telling the other side the wrong outcome — and
 * answers `409 CONTEST_NOT_OPEN`. Every other statement goes after the sentinel.
 *
 * ── 5. ONLY AN OWNER ACCEPT WRITES THE CATALOG ──────────────────────────────
 * It applies the value, transfers maintenance to the vendor (§13.9, the sixth
 * vendor-authorized catalog write site), and purges the pair page plus both
 * product pages. Nothing else here purges: a contest row is on no public page.
 */

import {
  addContestDays,
  ApiErrorCode,
  CONTEST_PROTEST_FILING_DAYS,
  contestFieldsFor,
  contestValueProblem,
  DecideContestSchema,
  ListVendorContestsResponseSchema,
  SubmitIntegrationContestSchema,
  VENDOR_CONTEST_LIST_CAP,
  VendorContestResponseSchema,
  type ContestAnchorKind,
  type ContestNotificationEvent,
  type IntegrationContestField,
  type ListVendorContestsResponse,
  type VendorContest,
  type VendorContestResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import {
  integrationFieldChallenges,
  productVendors,
  products,
  vendors,
  workflowInstances,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import {
  resolveAttestationSlots,
  resolveEvidencedPairSlots,
  vendorsForEvidencedPairSlots,
  vendorsForIntegrationSlots,
  type AttestationAuthority,
} from '../lib/attestation-authority';
import {
  auditInsert,
  workflowTransitionInsert,
  type BatchStmt,
  type BatchTuple,
} from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  anchorColumns,
  anchorEntityType,
  anchorMetadata,
  anchorPurgeTags,
  anchorUpdate,
  anchorUpdatedAction,
  anchorWriteMarkers,
  CONTEST_ENTITY_TYPE,
  CONTEST_FIELD_COLUMNS,
  contestAnchorLiveSentinel,
  contestAnchorOf,
  contestAnchorWhere,
  contestNotificationAudit,
  contestValueLabel,
  hydratedTarget,
  hydrateContests,
  isIntegrationClaimed,
  loadContestTarget,
  locateContestAnchor,
  ownerEntitlementActiveSentinel,
  receivedContestsWhere,
  routeContest,
  routesAsConnectorPowered,
  storedFieldValue,
  submittedContestsWhere,
  toStorageValue,
  toWireValue,
  vendorHoldsActiveEntitlement,
  type ContestAnchor,
  type ContestHydration,
  type ContestRow,
  type ContestTarget,
  type IntegrationClaimedPredicate,
  contestIntegrationStateSentinel,
  contestStillOpenSentinel,
  isContestRaceError,
} from '../lib/integration-contests';
import { isConnectorPoweredEdge } from '../lib/connector-powered';
import { isClaimed } from '../lib/integration-claims';
import { requireActiveEntitlement } from '../lib/integration-entitlement';
import { ownerSeatLapsed } from '../lib/vendor-handback';
import {
  protestSubmitRefusal,
  submitterProtestFields,
  toContestProtest,
} from '../lib/contest-protests';
import { assertIntegrationLive, integrationRetiredError } from '../lib/live-integration';
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

/** `workflow_instances.workflow_type` for a contest. Reused, not added: the CHECK
 *  is closed and opening it is a table recreate (§11b). `entity_id` is the
 *  contest id, which can never collide with a `vendor_requests` id. */
export const CONTEST_WORKFLOW_TYPE = 'correction_request';

/** `workflow_instances.final_outcome` per terminal contest status. */
const FINAL_OUTCOME = {
  accepted: 'approved',
  declined: 'rejected',
  withdrawn: 'cancelled',
} as const;

type TerminalStatus = keyof typeof FINAL_OUTCOME;

// ─── Small helpers ───────────────────────────────────────────────────────────

function idParam(c: VendorContext, name: 'id'): string {
  const value = c.req.param(name);
  if (!value) {
    throw new ApiError(400, 'VALIDATION_FAILED', `Missing ${name}`, { field: name });
  }
  return value;
}

/** The caller's owned product ids — the frame for every direction it reads. */
async function ownedProductSet(db: Db, vendorId: string): Promise<Set<string>> {
  const rows = await db
    .select({ productId: productVendors.productId })
    .from(productVendors)
    .where(eq(productVendors.vendorId, vendorId));
  return new Set(rows.map((r) => r.productId));
}

/** Endpoint A unless the caller owns only endpoint B. Same fallback
 *  `POST /api/vendor/claims` uses when no `context_product_id` is sent. */
function frameIsSource(owned: ReadonlySet<string>, sourceId: string, targetId: string): boolean {
  if (owned.has(sourceId)) return true;
  return !owned.has(targetId);
}

/** Row → wire, for either side. Returns `null` for a row whose integration is gone
 *  (the FK cascades, so only a concurrent delete can produce one).
 *
 *  `viewerVendorId` and `now` drive the AECI-1009 submitter-side fields (the
 *  protest window and the cooldown). They are sent only to the vendor that filed
 *  the contest; the owner's copy of the same row carries `null` in each. */
export function toVendorContest(
  row: ContestRow,
  hydration: ContestHydration,
  owned: ReadonlySet<string>,
  viewerVendorId: string | null = null,
  now: string = new Date().toISOString(),
): VendorContest | null {
  const integration = hydratedTarget(hydration, row);
  if (!integration) return null;
  const contextIsSource = frameIsSource(
    owned,
    integration.sourceProduct.id,
    integration.targetProduct.id,
  );
  const context = contextIsSource ? integration.sourceProduct : integration.targetProduct;
  const other = contextIsSource ? integration.targetProduct : integration.sourceProduct;
  const field = row.field as IntegrationContestField;
  const vendorRef = (id: string) => ({ id, name: hydration.vendorNames.get(id) ?? '' });
  return {
    id: row.id,
    integration_id: integration.id,
    anchor: integration.anchor,
    integration_name: integration.name,
    context_product: {
      id: context.id,
      name: context.name,
      slug: context.slug,
      logo_url: context.logoUrl,
    },
    other_product: { id: other.id, name: other.name, slug: other.slug, logo_url: other.logoUrl },
    field,
    current_value: toWireValue(field, row.currentValue, contextIsSource),
    proposed_value: toWireValue(field, row.proposedValue, contextIsSource),
    current_label: contestValueLabel(field, row.currentValue, hydration.vendorNames),
    proposed_label: contestValueLabel(field, row.proposedValue, hydration.vendorNames),
    reason: row.reason,
    routed_to: row.routedTo as VendorContest['routed_to'],
    status: row.status as VendorContest['status'],
    submitter_vendor: vendorRef(row.submitterVendorId),
    owner_vendor: row.ownerVendorId ? vendorRef(row.ownerVendorId) : null,
    decision_note: row.decisionNote,
    decided_at: row.decidedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    protest: toContestProtest(row),
    ...(viewerVendorId !== null && row.submitterVendorId === viewerVendorId
      ? submitterProtestFields(row, integration, now)
      : {
          protest_opens_at: null,
          protest_closes_at: null,
          protest_basis: null,
          cooldown_until: null,
        }),
  };
}

export async function echo(
  c: VendorContext,
  db: Db,
  vendorId: string,
  row: ContestRow,
  status = 200,
): Promise<Response> {
  const [hydration, owned] = await Promise.all([
    hydrateContests(db, [row]),
    ownedProductSet(db, vendorId),
  ]);
  const contest = toVendorContest(row, hydration, owned, vendorId);
  if (!contest) throw notFoundError('contest', { id: row.id });
  const body: VendorContestResponse = { contest };
  validateResponseInDev(c.env, () => VendorContestResponseSchema.parse(body));
  return json(body, { status });
}

/** Both endpoint slugs, for the pair-page purge, the notification snapshot and
 *  the recrawl. */
export async function endpointSlugs(
  db: Db,
  sourceId: string,
  targetId: string,
): Promise<readonly [string, string] | null> {
  const rows = await db
    .select({ id: products.id, slug: products.slug })
    .from(products)
    .where(inArray(products.id, [sourceId, targetId]));
  const slug = new Map(rows.map((r) => [r.id, r.slug]));
  const a = slug.get(sourceId);
  const b = slug.get(targetId);
  return a && b ? [a, b] : null;
}

/**
 * The shared tail of a decision: the transition row plus the workflow instance
 * moving to its terminal state. A contest always has an instance (submit creates
 * it); a `null` `workflow_id` would be a corrupt row, so one is minted rather than
 * losing the transition.
 */
export function closeWorkflow(
  db: Db,
  row: ContestRow,
  toState: TerminalStatus,
  entry: Omit<WorkflowTransitionEntry, 'workflowId' | 'fromState' | 'toState'>,
  now: string,
): { stmts: BatchStmt[]; transition: WorkflowTransitionEntry } {
  const workflowId = row.workflowId ?? crypto.randomUUID();
  const transition: WorkflowTransitionEntry = {
    ...entry,
    workflowId,
    fromState: 'open',
    toState,
  };
  const instance = row.workflowId
    ? db
        .update(workflowInstances)
        .set({ currentState: toState, completedAt: now, finalOutcome: FINAL_OUTCOME[toState] })
        .where(eq(workflowInstances.id, workflowId))
    : db.insert(workflowInstances).values({
        id: workflowId,
        workflowType: CONTEST_WORKFLOW_TYPE,
        entityId: row.id,
        currentState: toState,
        completedAt: now,
        finalOutcome: FINAL_OUTCOME[toState],
      });
  return { stmts: [instance, workflowTransitionInsert(db, transition)], transition };
}

/**
 * Run a decision batch whose first two statements are the guarded
 * `UPDATE … WHERE status = 'open'` and {@link contestStillOpenSentinel}. A lost
 * race aborts the WHOLE batch — no audit row, no transition, no notification, no
 * catalog write — and answers `409 CONTEST_NOT_OPEN`. Any other error rethrows.
 * Returns the committed row for the echo.
 */
export async function runGuardedContestBatch(
  db: Db,
  id: string,
  stmts: BatchStmt[],
): Promise<ContestRow> {
  try {
    await db.batch(stmts as BatchTuple);
  } catch (error) {
    if (!isContestRaceError(error)) throw error;
    const current = await db.query.integrationFieldChallenges.findFirst({
      columns: { status: true },
      where: eq(integrationFieldChallenges.id, id),
    });
    // Still open means the contest sentinel passed and the integration-state one
    // tripped (`contestIntegrationStateSentinel`, AECI-1005).
    if (current?.status === 'open') {
      throw new ApiError(
        409,
        ApiErrorCode.CONTEST_INTEGRATION_CHANGED,
        'The integration was claimed or its owner changed while you were deciding. Reload and decide again.',
      );
    }
    throw contestNotOpen(current?.status ?? 'closed');
  }
  const row = await db.query.integrationFieldChallenges.findFirst({
    where: eq(integrationFieldChallenges.id, id),
  });
  if (!row) throw notFoundError('contest', { id });
  return row;
}

function contestNotOpen(status: string): ApiError {
  return new ApiError(409, ApiErrorCode.CONTEST_NOT_OPEN, `This contest is already ${status}.`);
}

function isOpenContestConflict(error: unknown): boolean {
  const text = String((error as { cause?: unknown })?.cause ?? '') + String(error);
  return /integration_field_challenges_open_key|UNIQUE constraint failed: integration_field_challenges/.test(
    text,
  );
}

// ─── POST /api/vendor/integrations/:id/contests ──────────────────────────────

/**
 * The submit route, for either anchor.
 *
 * `claimed` is the routing predicate. It defaults to {@link isIntegrationClaimed},
 * the real `claimed_at` test since AECI-1005 replaced the stub, and stays a
 * parameter so a spec can pin either route without seeding a claim.
 *
 * The path id may name a `connector_evidenced_pairs` row (AECI-1092), found the way
 * the AECI-1089 claim and the AECI-1090 edit find it on the same `/integrations/:id`
 * path: `integrations` first, then the pairs (`locateContestAnchor`). An evidenced
 * pair is contested exactly as an `integrations` row is: the same endpoint-vendor
 * check (its evidenced arm, `resolveEvidencedPairSlots`), the same owner refusal,
 * the same checks and the same routing, over the eleven fields that table has. An
 * id in neither table falls through to the integrations check and its flat 404, so
 * the lookup discloses nothing. `anchorKind` pins the table in a spec.
 */
export function createSubmitContestHandler(
  dbFor: DbFactory = getDb,
  claimed: IntegrationClaimedPredicate = isIntegrationClaimed,
  anchorKind?: ContestAnchorKind,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const id = idParam(c, 'id');
    const { db } = writeDb(c, dbFor);
    const anchor: ContestAnchor = anchorKind
      ? { kind: anchorKind, id }
      : await locateContestAnchor(db, id);

    // 1. Authority, alone in its wave: an endpoint vendor or a flat 404.
    const authority: AttestationAuthority =
      anchor.kind === 'evidenced_pair'
        ? await resolveEvidencedPairSlots(db, vendorId, anchor.id)
        : await resolveAttestationSlots(db, vendorId, anchor.id);

    const [target, vendor] = await Promise.all([
      loadContestTarget(db, anchor),
      db.query.vendors.findFirst({ columns: { id: true }, where: eq(vendors.id, vendorId) }),
    ]);
    if (!vendor) throw notFoundError('vendor', { id: vendorId });
    if (!target) throw notFoundError('integration', { id: anchor.id });

    // 2. The owner cannot contest its own integration.
    if (target.builtByVendorId === vendorId) {
      throw new ApiError(
        403,
        ApiErrorCode.CONTEST_OWN_INTEGRATION,
        'Your company owns this integration, so you can edit it rather than contest it.',
      );
    }
    // 2b. A retired row takes no new contest (AECI-1010). Its owner withdrew it, and
    //     the retire closed every open contest on it as withdrawn.
    assertIntegrationLive(target);

    // 3. Shape. A field the anchor's table does not have is a shape error: an
    //    evidenced pair has no `mechanism_kind` (§11b.13).
    const payload = await parseJsonBody(c, SubmitIntegrationContestSchema);
    const field = payload.field;
    if (!contestFieldsFor(anchor.kind).includes(field)) {
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        `${field} cannot be contested on an integration delivered through a connector product`,
        { field: 'field' },
      );
    }
    const owned = authority.slots.map((slot) =>
      slot === 'vendor_a' ? authority.sourceProductId : authority.targetProductId,
    );
    if (payload.context_product_id && !owned.includes(payload.context_product_id)) {
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        'context_product_id must be one of your own products on this integration',
        { field: 'context_product_id' },
      );
    }
    const contextIsSource = payload.context_product_id
      ? payload.context_product_id === authority.sourceProductId
      : authority.slots.includes('vendor_a');

    // 4. Value — a business rule per field, so 422 rather than 400.
    const wire = payload.proposed_value;
    const problem = contestValueProblem(field, wire);
    if (problem) {
      throw new ApiError(422, ApiErrorCode.CONTEST_INVALID_VALUE, problem, {
        field: 'proposed_value',
      });
    }
    if (field === 'owner' && wire !== null) {
      const slotVendors =
        anchor.kind === 'evidenced_pair'
          ? await vendorsForEvidencedPairSlots(db, [anchor.id])
          : await vendorsForIntegrationSlots(db, [anchor.id]);
      const slots = slotVendors.get(anchor.id);
      const endpointVendors = new Set([
        ...(slots?.slots.vendor_a ?? []),
        ...(slots?.slots.vendor_b ?? []),
      ]);
      if (!endpointVendors.has(wire)) {
        throw new ApiError(
          422,
          ApiErrorCode.CONTEST_INVALID_VALUE,
          'The proposed owner must be one of the vendors of this integration’s two products',
          { field: 'proposed_value' },
        );
      }
    }
    const proposedValue = toStorageValue(field, wire, contextIsSource);
    const currentValue = storedFieldValue(target, field);
    if (proposedValue === currentValue) {
      throw new ApiError(
        422,
        ApiErrorCode.CONTEST_NO_CHANGE,
        'The proposed value is the same as the current value.',
        { field: 'proposed_value' },
      );
    }

    // 5. One open contest per (anchor, field, vendor). The partial unique index is
    //    the guarantee; this read turns the common case into a clean 409.
    const duplicate = await db.query.integrationFieldChallenges.findFirst({
      columns: { id: true },
      where: and(
        contestAnchorWhere(anchor),
        eq(integrationFieldChallenges.field, field),
        eq(integrationFieldChallenges.submitterVendorId, vendorId),
        eq(integrationFieldChallenges.status, 'open'),
      ),
    });
    if (duplicate) throw duplicateContest(duplicate.id);

    // 6. AECI-1009 (§11b.12.8): an open protest on this field, then a lost
    //    protest's 90-day cooldown, which any change to the value lifts.
    const refusal = await protestSubmitRefusal(db, {
      anchor,
      field,
      vendorId,
      liveValue: currentValue,
      now: new Date().toISOString(),
    });
    if (refusal) throw refusal;

    const pairSlugs = await endpointSlugs(db, target.sourceProductId, target.targetProductId);
    const draft = {
      anchor,
      target,
      field,
      currentValue,
      proposedValue,
      reason: payload.reason,
      pairSlugs,
    };

    // 7. Route and write. A lost race with an admin clearing the owner's entitlement
    //    (ruling B) aborts on `ownerEntitlementActiveSentinel`; the second attempt
    //    re-reads the entitlement and routes the contest to AECi (ruling E).
    for (let attempt = 1; ; attempt++) {
      const plan = await planSubmit(db, c, vendorId, draft, claimed);
      try {
        await db.batch(plan.stmts as BatchTuple);
      } catch (error) {
        // Two submits raced past the read above; the index caught the second.
        if (isOpenContestConflict(error)) throw duplicateContest(null);
        if (!isContestRaceError(error)) throw error;
        // A `json()` abort: the live sentinel, or the owner-entitlement one. Re-read
        // to tell them apart, because the D1 error does not carry the token.
        const now = await loadContestTarget(db, anchor);
        if (!now || now.retiredAt) throw integrationRetiredError();
        if (plan.entitlementGuarded && attempt < 2) continue;
        // A second lost race with an entitlement change, or an abort the re-read cannot
        // explain: nothing was written, so answer 409 rather than a raw D1 error.
        throw new ApiError(
          409,
          ApiErrorCode.CONTEST_INTEGRATION_CHANGED,
          'The integration’s owner changed while you were filing. Nothing was sent. Try again.',
        );
      }
      // No purge: nothing public changed. The forward still runs.
      afterVendorWrite(c, [], plan.audits);
      return echo(c, db, vendorId, plan.row, 201);
    }
  };
}

interface SubmitDraft {
  anchor: ContestAnchor;
  target: ContestTarget;
  field: IntegrationContestField;
  currentValue: string | null;
  proposedValue: string | null;
  reason: string;
  pairSlugs: readonly [string, string] | null;
}

/**
 * Route one contest and build its submit batch (§11b.4, with ruling A and ruling E
 * on a connector-powered row). The owner's entitlement is read only when it can
 * change the answer. When the contest does route to that owner, the batch carries
 * `ownerEntitlementActiveSentinel`, so a clear that commits first aborts it.
 */
async function planSubmit(
  db: Db,
  c: VendorContext,
  vendorId: string,
  draft: SubmitDraft,
  claimed: IntegrationClaimedPredicate,
): Promise<{
  stmts: BatchStmt[];
  audits: AuditLogEntry[];
  row: ContestRow;
  entitlementGuarded: boolean;
}> {
  const session = c.get('auth');
  const { anchor, target, field } = draft;
  const owner = target.builtByVendorId;
  // Ruling A, forward-looking: a `mechanism_kind` contest whose proposal would make the
  // row connector-powered goes to AECi too (`routesAsConnectorPowered`, shared with
  // the seat return).
  const connectorPowered = routesAsConnectorPowered(target, field, draft.proposedValue);
  const needsEntitlement =
    target.connectorPowered &&
    owner !== null &&
    field !== 'owner' &&
    field !== 'mechanism_kind' &&
    claimed(target);
  const ownerEntitled = needsEntitlement ? await vendorHoldsActiveEntitlement(db, owner) : true;
  const route = routeContest(target, field, claimed, {
    connectorPowered,
    ownerEntitled,
  });
  // AECI-989: an owner with no unbanned seat cannot answer. The contest goes to
  // AECi, stamped so an unban routes it back (`lib/vendor-handback.ts`).
  const seatLapsed =
    route.routedTo === 'owner' &&
    route.ownerVendorId !== null &&
    (await ownerSeatLapsed(db, route.ownerVendorId));
  const routedTo: typeof route.routedTo = seatLapsed ? 'aeci' : route.routedTo;
  const { ownerVendorId } = route;
  const entitlementGuarded = routedTo === 'owner' && target.connectorPowered;

  const now = new Date().toISOString();
  const contestId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const row: ContestRow = {
    id: contestId,
    ...anchorColumns(anchor),
    field,
    currentValue: draft.currentValue,
    proposedValue: draft.proposedValue,
    reason: draft.reason,
    submitterVendorId: vendorId,
    submittedBy: session.userId,
    routedTo,
    ownerVendorId,
    status: 'open',
    decisionNote: null,
    decidedBy: null,
    decidedAt: null,
    upstreamLinearIssueId: null,
    upstreamLinearIssueUrl: null,
    workflowId,
    ownerSeatLapsedAt: seatLapsed ? now : null,
    ...EMPTY_PROTEST_COLUMNS,
    createdAt: now,
    updatedAt: now,
  };
  const metadata = {
    source: AUDIT_SOURCE,
    vendorId,
    contestId,
    ...anchorMetadata(anchor),
    field,
    routedTo,
  };
  const audit: AuditLogEntry = {
    actorId: session.userId,
    actorType: auditActorType(session),
    action: 'integration.contest.submitted',
    entityType: CONTEST_ENTITY_TYPE,
    entityId: contestId,
    afterState: {
      field,
      current_value: draft.currentValue,
      proposed_value: draft.proposedValue,
      routed_to: routedTo,
      owner_vendor_id: ownerVendorId,
    },
    metadata,
  };
  const transition: WorkflowTransitionEntry = {
    workflowId,
    fromState: null,
    toState: 'open',
    actorId: session.userId,
    reason: 'contest submitted',
    metadata,
  };
  const audits: AuditLogEntry[] = [audit];
  if (routedTo === 'owner' && ownerVendorId) {
    audits.push(
      contestNotificationAudit(
        { actorId: session.userId, actorType: auditActorType(session) },
        {
          vendorId: ownerVendorId,
          contestId,
          integrationId: anchor.id,
          ...(anchor.kind === 'evidenced_pair' ? { anchor: 'evidenced_pair' as const } : {}),
          integrationName: target.name,
          field,
          event: 'submitted',
          pairSlugs: draft.pairSlugs,
        },
      ),
    );
  }

  const stmts: BatchStmt[] = [
    // The instance first: the contest's `workflow_id` FK points at it.
    db.insert(workflowInstances).values({
      id: workflowId,
      workflowType: CONTEST_WORKFLOW_TYPE,
      entityId: contestId,
      currentState: 'open',
      initiatedBy: session.userId,
      initiatedAt: now,
    }),
    db.insert(integrationFieldChallenges).values(row),
    // AECI-1010: a retire that committed after the read above would otherwise leave
    // an open contest on a retired row, which the retire's own close missed.
    contestAnchorLiveSentinel(db, anchor),
    // Ruling B's submit-side half: the owner must still be entitled at commit.
    ...(entitlementGuarded && ownerVendorId
      ? [ownerEntitlementActiveSentinel(db, ownerVendorId)]
      : []),
    workflowTransitionInsert(db, transition),
    ...audits.map((entry) => auditInsert(db, entry)),
  ];
  return { stmts, audits, row, entitlementGuarded };
}

/** Every AECI-1009 protest column, empty. A new contest carries no protest. */
const EMPTY_PROTEST_COLUMNS = {
  protestStatus: null,
  protestBasis: null,
  protestReason: null,
  protestEvidence: null,
  protestedBy: null,
  protestedAt: null,
  protestReplyDueAt: null,
  protestReply: null,
  protestReplyEvidence: null,
  protestRepliedBy: null,
  protestRepliedAt: null,
  protestDecisionNote: null,
  protestDecidedBy: null,
  protestDecidedAt: null,
  protestWorkflowId: null,
} satisfies Partial<ContestRow>;

function duplicateContest(existingId: string | null): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.CONTEST_DUPLICATE,
    'You already have an open contest on this field of this integration.',
    existingId ? { details: { contest_id: existingId } } : {},
  );
}

// ─── GET /api/vendor/contests ────────────────────────────────────────────────

/**
 * The caller's contests, both sides. Scoped by `submittedContestsWhere` ∪
 * `receivedContestsWhere`, whose union is `vendorContestsWhere` — the predicate
 * the `contests` cursor on `GET /api/vendor/updates` imports. Not rate-limited
 * and not audited: it is a read.
 *
 * Each list is most recently updated first (AECI-1009), `id` as the tiebreaker, and capped at
 * `VENDOR_CONTEST_LIST_CAP`. The cursor reports on the whole scope, so an edit to
 * a row past the cap moves it without changing what the list shows. That costs
 * one wasted refetch and nothing else, and a vendor with more than 100 contests on
 * one side is not a case launch has to serve.
 */
export function createListVendorContestsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);

    // AECI-1009: newest ACTIVITY first. A protest can land on a contest filed months
    // ago, and under `created_at` that row could sit past the cap and never show
    // while the cursor still moved for it.
    const order = [desc(integrationFieldChallenges.updatedAt), asc(integrationFieldChallenges.id)];
    const [submitted, received, owned] = await Promise.all([
      db
        .select()
        .from(integrationFieldChallenges)
        .where(submittedContestsWhere(vendorId))
        .orderBy(...order)
        .limit(VENDOR_CONTEST_LIST_CAP),
      db
        .select()
        .from(integrationFieldChallenges)
        .where(receivedContestsWhere(vendorId))
        .orderBy(...order)
        .limit(VENDOR_CONTEST_LIST_CAP),
      ownedProductSet(db, vendorId),
    ]);
    const hydration = await hydrateContests(db, [...submitted, ...received]);
    const now = new Date().toISOString();
    const map = (rows: ContestRow[]) =>
      rows
        .map((row) => toVendorContest(row, hydration, owned, vendorId, now))
        .filter((row): row is VendorContest => row !== null);

    const body: ListVendorContestsResponse = {
      submitted: map(submitted),
      received: map(received),
    };
    validateResponseInDev(c.env, () => ListVendorContestsResponseSchema.parse(body));
    return json(body);
  };
}

// ─── POST /api/vendor/contests/:id/withdraw ──────────────────────────────────

export function createWithdrawContestHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const id = idParam(c, 'id');
    const { db } = writeDb(c, dbFor);

    // Submitter only. Anyone else — including the owner — gets the same 404 an
    // unknown id gets.
    const row = await db.query.integrationFieldChallenges.findFirst({
      where: and(
        eq(integrationFieldChallenges.id, id),
        eq(integrationFieldChallenges.submitterVendorId, vendorId),
      ),
    });
    if (!row) throw notFoundError('contest', { id });
    if (row.status !== 'open') throw contestNotOpen(row.status);

    const now = new Date().toISOString();
    const metadata = {
      source: AUDIT_SOURCE,
      vendorId,
      contestId: id,
      ...anchorMetadata(contestAnchorOf(row)),
      field: row.field,
    };
    const audits: AuditLogEntry[] = [
      {
        actorId: session.userId,
        actorType: auditActorType(session),
        action: 'integration.contest.withdrawn',
        entityType: CONTEST_ENTITY_TYPE,
        entityId: id,
        beforeState: { status: 'open' },
        afterState: { status: 'withdrawn' },
        metadata,
      },
    ];
    const notify = await notificationFor(db, row, session, 'withdrawn');
    if (notify) audits.push(notify);
    const workflow = closeWorkflow(
      db,
      row,
      'withdrawn',
      { actorId: session.userId, reason: 'contest withdrawn', metadata },
      now,
    );

    const after = await runGuardedContestBatch(db, id, [
      db
        .update(integrationFieldChallenges)
        .set({ status: 'withdrawn', updatedAt: now })
        .where(
          and(eq(integrationFieldChallenges.id, id), eq(integrationFieldChallenges.status, 'open')),
        ),
      // Immediately after the guarded UPDATE, before everything else.
      contestStillOpenSentinel(db, id),
      ...workflow.stmts,
      ...audits.map((entry) => auditInsert(db, entry)),
    ]);
    afterVendorWrite(c, [], audits);
    return echo(c, db, vendorId, after);
  };
}

/**
 * The `notification.sent` row for the other side of a contest event, or `null`
 * when there is no vendor on the other side. `submitted` / `withdrawn` go to the
 * owner, and only when the contest is owner-routed (an AECi-routed contest has no
 * vendor decider to tell). `accepted` / `declined` always go to the submitter.
 */
export async function notificationFor(
  db: Db,
  row: ContestRow,
  actor: { userId: string; role: string },
  event: ContestNotificationEvent,
  extra: { protestClosesAt?: string } = {},
): Promise<AuditLogEntry | null> {
  const toOwner = event === 'submitted' || event === 'withdrawn';
  const recipient = toOwner
    ? row.routedTo === 'owner'
      ? row.ownerVendorId
      : null
    : row.submitterVendorId;
  if (!recipient) return null;
  const anchor = contestAnchorOf(row);
  const integration = await loadContestTarget(db, anchor);
  const pairSlugs = integration
    ? await endpointSlugs(db, integration.sourceProductId, integration.targetProductId)
    : null;
  return contestNotificationAudit(
    { actorId: actor.userId, actorType: auditActorType(actor) },
    {
      vendorId: recipient,
      contestId: row.id,
      integrationId: anchor.id,
      ...(anchor.kind === 'evidenced_pair' ? { anchor: 'evidenced_pair' as const } : {}),
      integrationName: integration?.name ?? null,
      field: row.field as IntegrationContestField,
      event,
      pairSlugs,
      ...extra,
    },
  );
}

// ─── POST /api/vendor/contests/:id/decision ──────────────────────────────────

export function createDecideContestHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const id = idParam(c, 'id');
    const { db } = writeDb(c, dbFor);

    // Only the decider: owner-routed, with the caller as the snapshot owner.
    // Everyone else, the submitter included, gets the unknown-id 404.
    const row = await db.query.integrationFieldChallenges.findFirst({
      where: and(eq(integrationFieldChallenges.id, id), receivedContestsWhere(vendorId)),
    });
    if (!row) throw notFoundError('contest', { id });
    if (row.status !== 'open') throw contestNotOpen(row.status);

    // AECI-1005 review: the decider was frozen at SUBMIT, so re-check that the caller
    // still owns the row now. An AECi owner accept can reassign a claimed row (and
    // re-routes its open contests to AECi in the same batch); a caller that lost the
    // row, or a row that is no longer claimed, must not decide. The same condition
    // is re-asserted inside the batch by `contestIntegrationStateSentinel` below.
    // AECI-1092: the row may be an evidenced pair; both tables carry the same columns.
    const anchor = contestAnchorOf(row);
    const target = await loadContestTarget(db, anchor);
    if (!target || !isClaimed(target) || target.builtByVendorId !== vendorId) {
      throw new ApiError(
        409,
        ApiErrorCode.CONTEST_INTEGRATION_CHANGED,
        'Your company is no longer the owner of this integration, so AEC Integrations decides this contest.',
      );
    }
    // AECI-1040 ruling 2 (§11b.13 follow-up ruling 2): deciding a contest on a
    // connector-powered row is an owner write, so it needs an active entitlement.
    // Ownership has settled above, so the 403 discloses nothing new. An admin clear
    // re-routes these contests to AECi in its own batch (ruling B), so this is the
    // backstop for a portal that has not refetched yet.
    if (target.connectorPowered) requireActiveEntitlement(c);

    const payload = await parseJsonBody(c, DecideContestSchema);
    const status = payload.decision === 'accept' ? 'accepted' : 'declined';
    const note = payload.note ?? null;
    const now = new Date().toISOString();
    const field = row.field as IntegrationContestField;
    const metadata = {
      source: AUDIT_SOURCE,
      vendorId,
      contestId: id,
      ...anchorMetadata(anchor),
      field,
    };

    const audits: AuditLogEntry[] = [
      {
        actorId: session.userId,
        actorType: auditActorType(session),
        action: `integration.contest.${status}`,
        entityType: CONTEST_ENTITY_TYPE,
        entityId: id,
        beforeState: { status: 'open' },
        afterState: { status, decision_note: note },
        metadata,
      },
    ];
    const stmts: BatchStmt[] = [
      db
        .update(integrationFieldChallenges)
        .set({
          status,
          decisionNote: note,
          decidedBy: session.userId,
          decidedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(integrationFieldChallenges.id, id),
            eq(integrationFieldChallenges.status, 'open'),
            // AECI-1092: still this caller's to decide. A re-route to AECi (an owner
            // reassignment, or ruling B's entitlement clear) that commits between the
            // read above and this batch leaves the row open but no longer owner-routed,
            // and the old owner must not decide it.
            receivedContestsWhere(vendorId),
          ),
        ),
      // Immediately after the guarded UPDATE: a lost race aborts the batch here,
      // before the catalog write, the audit rows and the notification.
      contestStillOpenSentinel(db, id),
      // AECI-1005 review: and the caller must still hold the claimed row when the
      // batch runs, or a reassignment landing mid-decision is decided by the old owner.
      contestIntegrationStateSentinel(db, anchor, {
        claimed: true,
        ownerVendorId: vendorId,
      }),
    ];

    let tags: string[] = [];
    let pairSlugs: readonly [string, string] | null = null;
    if (status === 'accepted') {
      // `owner` never routes to a vendor (§11b), so this is unreachable short of a
      // corrupt row. Refuse rather than write a column no accept may touch. The same
      // holds for `mechanism_kind` on a connector-powered row (ruling A), and that
      // column does not exist on an evidenced pair at all.
      if (field === 'owner' || (field === 'mechanism_kind' && target.connectorPowered)) {
        throw new ApiError(500, 'INTERNAL_ERROR', `A ${field} contest cannot be owner-decided`);
      }
      // AECI-1092 review: the owner may not make its own row connector-powered through
      // a contest, exactly as its edit may not (`vendor-integration-edits.ts`). A
      // contest routed before AECI-1092 can still propose `iPaaS` or `integrator` to
      // the owner, so the accept is refused on the row as it would be. Declining stays
      // open, and AECi can still decide it through the admin queue.
      if (
        field === 'mechanism_kind' &&
        isConnectorPoweredEdge({
          poweredByProductId: target.poweredByProductId,
          mechanismKind: row.proposedValue,
        })
      ) {
        throw new ApiError(
          422,
          ApiErrorCode.INTEGRATION_INVALID_VALUE,
          'A connector-delivered integration type cannot be set here',
          { field: 'mechanism_kind' },
        );
      }
      const column = CONTEST_FIELD_COLUMNS[field];
      const before = storedFieldValue(target, field);
      const purge = await anchorPurgeTags(db, target, pairCacheTag);
      pairSlugs = purge.pairSlugs;
      tags = purge.tags;
      stmts.push(
        // Runs only if the sentinels above passed, i.e. this request won.
        anchorUpdate(db, anchor, {
          [column]: row.proposedValue,
          ...maintenanceTransferColumns(now),
          // Explicit, as the AECI-1090 owner edit does: it moves the owned-rows cursor.
          updatedAt: now,
        }),
      );
      audits.push({
        actorId: session.userId,
        actorType: auditActorType(session),
        action: anchorUpdatedAction(anchor.kind),
        entityType: anchorEntityType(anchor.kind),
        entityId: anchor.id,
        beforeState: {
          [field]: before,
          maintained_by: target.maintainedBy,
          last_reviewed_at: target.lastReviewedAt,
        },
        afterState: {
          [field]: row.proposedValue,
          maintained_by: 'vendor',
          last_reviewed_at: now,
        },
        metadata: {
          ...metadata,
          reason: 'contest-accepted',
          // Present only on the hand-changing save, never as `false` (§13.9).
          ...(isMaintenanceTransfer(target) ? { maintenanceTransfer: true } : {}),
          // The AECI-1089/1090 carve-out markers, so an owner accept and an owner
          // edit on the same row audit identically.
          ...anchorWriteMarkers(target),
        },
      });
    }
    // AECI-1009: an OWNER decline can be protested to AECi for 30 days, and the
    // notification says until when. This is the owner's decision route, so it is
    // always an owner decision; an AECi decline never carries the date.
    const notify = await notificationFor(
      db,
      row,
      session,
      status,
      status === 'declined'
        ? { protestClosesAt: addContestDays(now, CONTEST_PROTEST_FILING_DAYS) }
        : {},
    );
    if (notify) audits.push(notify);
    const workflow = closeWorkflow(
      db,
      row,
      status,
      { actorId: session.userId, reason: note ?? `contest ${status}`, metadata },
      now,
    );
    stmts.push(...workflow.stmts, ...audits.map((entry) => auditInsert(db, entry)));
    const after = await runGuardedContestBatch(db, id, stmts);

    // The owner edit's tail (AECI-1090): a by-id Algolia sync of the record, behind
    // promote's `dispatchHook` watchdog. The integrations index holds evidenced pairs
    // too, and the by-id path reads both tables.
    if (status === 'accepted') {
      dispatchOwnerWriteSearch(
        c,
        'vendor-contest-algolia',
        syncOwnerWriteSearch(
          c,
          db,
          { integrations: [anchor.id], products: [], vendors: [] },
          'aeci.api.vendor.contest_algolia_sync_failed',
        ),
      );
    }

    const base = publicSiteBase(c.env);
    const recrawl =
      status === 'accepted' && pairSlugs && recrawlEnabled(c.env) && base
        ? attestationEditRecrawl(base, pairSlugs[0], pairSlugs[1])
        : undefined;
    afterVendorWrite(c, tags, audits, recrawl, db);
    return echo(c, db, vendorId, after);
  };
}

/**
 * Integration field contests, vendor side (`/api/vendor/*`, AECI-1008 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b) — Drizzle/D1.
 *
 *   POST /api/vendor/integrations/:id/contests   — submit a contest (201).
 *   GET  /api/vendor/contests                    — `{ submitted, received }`.
 *   POST /api/vendor/contests/:id/withdraw       — the submitter withdraws.
 *   POST /api/vendor/contests/:id/decision       — the owner accepts or declines.
 *
 * `routes/vendor.ts` holds the narrative of this surface's invariants. Five rules
 * of this module's own:
 *
 * ── 1. A SEAT IS THE WHOLE GATE ─────────────────────────────────────────────
 * `requireVendor()` only. No `requireCapability`, no Verified check. This is a
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
  ApiErrorCode,
  contestValueProblem,
  DecideContestSchema,
  ListVendorContestsResponseSchema,
  SubmitIntegrationContestSchema,
  VENDOR_CONTEST_LIST_CAP,
  VendorContestResponseSchema,
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
  integrations,
  productVendors,
  products,
  vendors,
  workflowInstances,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import {
  resolveAttestationSlots,
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
  CONTEST_ENTITY_TYPE,
  CONTEST_FIELD_COLUMNS,
  contestNotificationAudit,
  contestValueLabel,
  hydrateContests,
  isIntegrationClaimed,
  receivedContestsWhere,
  routeContest,
  storedFieldValue,
  submittedContestsWhere,
  toStorageValue,
  toWireValue,
  type ContestHydration,
  type ContestRow,
  type IntegrationClaimedPredicate,
  contestIntegrationStateSentinel,
  contestStillOpenSentinel,
  isContestRaceError,
} from '../lib/integration-contests';
import { isClaimed } from '../lib/integration-claims';
import {
  assertIntegrationLive,
  integrationLiveSentinel,
  integrationRetiredError,
  isIntegrationRetiredRaceError,
} from '../lib/live-integration';
import { publicSiteBase } from '../lib/public-urls';
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
 *  (the FK cascades, so only a concurrent delete can produce one). */
export function toVendorContest(
  row: ContestRow,
  hydration: ContestHydration,
  owned: ReadonlySet<string>,
): VendorContest | null {
  const integration = hydration.integrations.get(row.integrationId);
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
    integration_id: row.integrationId,
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
  };
}

async function echo(
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
  const contest = toVendorContest(row, hydration, owned);
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
 * `claimed` is the routing predicate. It defaults to {@link isIntegrationClaimed},
 * the real `claimed_at` test since AECI-1005 replaced the stub, and stays a
 * parameter so a spec can pin either route without seeding a claim.
 */
export function createSubmitContestHandler(
  dbFor: DbFactory = getDb,
  claimed: IntegrationClaimedPredicate = isIntegrationClaimed,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const integrationId = idParam(c, 'id');
    const { db } = writeDb(c, dbFor);

    // 1. Authority, alone in its wave: an endpoint vendor or a flat 404.
    const authority: AttestationAuthority = await resolveAttestationSlots(
      db,
      vendorId,
      integrationId,
    );

    const [integration, vendor] = await Promise.all([
      db.query.integrations.findFirst({ where: eq(integrations.id, integrationId) }),
      db.query.vendors.findFirst({ columns: { id: true }, where: eq(vendors.id, vendorId) }),
    ]);
    if (!vendor) throw notFoundError('vendor', { id: vendorId });
    if (!integration) throw notFoundError('integration', { id: integrationId });

    // 2. The owner cannot contest its own integration.
    if (integration.builtByVendorId === vendorId) {
      throw new ApiError(
        403,
        ApiErrorCode.CONTEST_OWN_INTEGRATION,
        'Your company owns this integration, so you can edit it rather than contest it.',
      );
    }
    // 2b. A retired row takes no new contest (AECI-1010). Its owner withdrew it, and
    //     the retire closed every open contest on it as withdrawn.
    assertIntegrationLive(integration);

    // 3. Shape.
    const payload = await parseJsonBody(c, SubmitIntegrationContestSchema);
    const field = payload.field;
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
      const slots = (await vendorsForIntegrationSlots(db, [integrationId])).get(integrationId);
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
    const currentValue = storedFieldValue(integration, field);
    if (proposedValue === currentValue) {
      throw new ApiError(
        422,
        ApiErrorCode.CONTEST_NO_CHANGE,
        'The proposed value is the same as the current value.',
        { field: 'proposed_value' },
      );
    }

    // 5. One open contest per (integration, field, vendor). The partial unique
    //    index is the guarantee; this read turns the common case into a clean 409.
    const duplicate = await db.query.integrationFieldChallenges.findFirst({
      columns: { id: true },
      where: and(
        eq(integrationFieldChallenges.integrationId, integrationId),
        eq(integrationFieldChallenges.field, field),
        eq(integrationFieldChallenges.submitterVendorId, vendorId),
        eq(integrationFieldChallenges.status, 'open'),
      ),
    });
    if (duplicate) throw duplicateContest(duplicate.id);

    const { routedTo, ownerVendorId } = routeContest(integration, field, claimed);
    const now = new Date().toISOString();
    const contestId = crypto.randomUUID();
    const workflowId = crypto.randomUUID();
    const pairSlugs = await endpointSlugs(
      db,
      integration.sourceProductId,
      integration.targetProductId,
    );

    const row: ContestRow = {
      id: contestId,
      integrationId,
      field,
      currentValue,
      proposedValue,
      reason: payload.reason,
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
      createdAt: now,
      updatedAt: now,
    };
    const metadata = {
      source: AUDIT_SOURCE,
      vendorId,
      contestId,
      integrationId,
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
        current_value: currentValue,
        proposed_value: proposedValue,
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
            integrationId,
            integrationName: integration.name,
            field,
            event: 'submitted',
            pairSlugs,
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
      integrationLiveSentinel(db, integrationId),
      workflowTransitionInsert(db, transition),
      ...audits.map((entry) => auditInsert(db, entry)),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      // Two submits raced past the read above; the index caught the second.
      if (isOpenContestConflict(error)) throw duplicateContest(null);
      // The only `json()` in this batch is the live sentinel.
      if (isIntegrationRetiredRaceError(error)) throw integrationRetiredError();
      throw error;
    }

    // No purge: nothing public changed. The forward still runs.
    afterVendorWrite(c, [], audits);
    return echo(c, db, vendorId, row, 201);
  };
}

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
 * Each list is newest first, `id` as the tiebreaker, and capped at
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

    const order = [desc(integrationFieldChallenges.createdAt), asc(integrationFieldChallenges.id)];
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
    const map = (rows: ContestRow[]) =>
      rows
        .map((row) => toVendorContest(row, hydration, owned))
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
      integrationId: row.integrationId,
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
): Promise<AuditLogEntry | null> {
  const toOwner = event === 'submitted' || event === 'withdrawn';
  const recipient = toOwner
    ? row.routedTo === 'owner'
      ? row.ownerVendorId
      : null
    : row.submitterVendorId;
  if (!recipient) return null;
  const integration = await db.query.integrations.findFirst({
    columns: { name: true, sourceProductId: true, targetProductId: true },
    where: eq(integrations.id, row.integrationId),
  });
  const pairSlugs = integration
    ? await endpointSlugs(db, integration.sourceProductId, integration.targetProductId)
    : null;
  return contestNotificationAudit(
    { actorId: actor.userId, actorType: auditActorType(actor) },
    {
      vendorId: recipient,
      contestId: row.id,
      integrationId: row.integrationId,
      integrationName: integration?.name ?? null,
      field: row.field as IntegrationContestField,
      event,
      pairSlugs,
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
    const owned = await db.query.integrations.findFirst({
      columns: { id: true, claimedAt: true, builtByVendorId: true },
      where: eq(integrations.id, row.integrationId),
    });
    if (!owned || !isClaimed(owned) || owned.builtByVendorId !== vendorId) {
      throw new ApiError(
        409,
        ApiErrorCode.CONTEST_INTEGRATION_CHANGED,
        'Your company is no longer the owner of this integration, so AEC Integrations decides this contest.',
      );
    }

    const payload = await parseJsonBody(c, DecideContestSchema);
    const status = payload.decision === 'accept' ? 'accepted' : 'declined';
    const note = payload.note ?? null;
    const now = new Date().toISOString();
    const field = row.field as IntegrationContestField;
    const metadata = {
      source: AUDIT_SOURCE,
      vendorId,
      contestId: id,
      integrationId: row.integrationId,
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
          and(eq(integrationFieldChallenges.id, id), eq(integrationFieldChallenges.status, 'open')),
        ),
      // Immediately after the guarded UPDATE: a lost race aborts the batch here,
      // before the catalog write, the audit rows and the notification.
      contestStillOpenSentinel(db, id),
      // AECI-1005 review: and the caller must still hold the claimed row when the
      // batch runs, or a reassignment landing mid-decision is decided by the old owner.
      contestIntegrationStateSentinel(db, row.integrationId, {
        claimed: true,
        ownerVendorId: vendorId,
      }),
    ];

    let tags: string[] = [];
    let pairSlugs: readonly [string, string] | null = null;
    if (status === 'accepted') {
      // `owner` never routes to a vendor (§11b), so this is unreachable short of a
      // corrupt row. Refuse rather than write a column no accept may touch.
      if (field === 'owner') {
        throw new ApiError(500, 'INTERNAL_ERROR', 'An owner contest cannot be owner-decided');
      }
      const integration = await db.query.integrations.findFirst({
        where: eq(integrations.id, row.integrationId),
      });
      if (!integration) throw notFoundError('contest', { id });
      const column = CONTEST_FIELD_COLUMNS[field];
      const before = storedFieldValue(integration, field);
      pairSlugs = await endpointSlugs(db, integration.sourceProductId, integration.targetProductId);
      stmts.push(
        db
          .update(integrations)
          .set({ [column]: row.proposedValue, ...maintenanceTransferColumns(now) })
          // Runs only if the sentinel above passed, i.e. this request won.
          .where(eq(integrations.id, row.integrationId)),
      );
      audits.push({
        actorId: session.userId,
        actorType: auditActorType(session),
        action: 'integration.updated',
        entityType: 'integration',
        entityId: row.integrationId,
        beforeState: {
          [field]: before,
          maintained_by: integration.maintainedBy,
          last_reviewed_at: integration.lastReviewedAt,
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
          ...(isMaintenanceTransfer(integration) ? { maintenanceTransfer: true } : {}),
        },
      });
      if (pairSlugs) {
        tags = [
          pairCacheTag(pairSlugs[0], pairSlugs[1]),
          `product:${pairSlugs[0]}`,
          `product:${pairSlugs[1]}`,
        ];
      }
    }

    const notify = await notificationFor(db, row, session, status);
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

    const base = publicSiteBase(c.env);
    const recrawl =
      status === 'accepted' && pairSlugs && recrawlEnabled(c.env) && base
        ? attestationEditRecrawl(base, pairSlugs[0], pairSlugs[1])
        : undefined;
    afterVendorWrite(c, tags, audits, recrawl, db);
    return echo(c, db, vendorId, after);
  };
}

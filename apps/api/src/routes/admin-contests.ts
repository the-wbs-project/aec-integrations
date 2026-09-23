/**
 * Integration field contests, AECi side (AECI-1008 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b; `API_CONTRACTS.md` §6.10) — Drizzle/D1.
 *
 *   GET   /api/admin/contests      — the queue, by status and route, paginated.
 *   PATCH /api/admin/contests/:id  — accept or decline an AECi-routed contest.
 *
 * ── WHAT AN ACCEPT WRITES DEPENDS ON THE INTEGRATION (AECI-1005) ────────────
 * Every accept files a `REVIEW - ` Linear issue after commit
 * (`createLinearIssueForContest`, playbook AECI-1025; the §6.7 sweep retries it).
 * What it writes HERE follows from the row's ownership state at decision time,
 * because a claimed integration is no longer written by promote (ADR 0035):
 *
 *   - content field, unclaimed row: nothing here (promote carries it).
 *     Issue: "Apply contested field".
 *   - content field, claimed row: the column plus `integration.updated`, and a
 *     purge. Issue: "Apply contested field", worded "AECi already applied it".
 *   - `owner`, proposed = submitter: `built_by_vendor_id`, `claimed_at`, the
 *     maintenance transfer, `integration.claimed`, and a claim notification to the
 *     other endpoint vendors. Issue: "Record integration owner". Since AECI-1092
 *     (ruling C) this holds on a connector-powered row too; before it, decision 9
 *     kept the claim off those rows and the accept wrote nothing here.
 *
 * AECI-1092: every case applies to a contest on a connector-evidenced pair as well.
 * The writes go to `connector_evidenced_pairs` under the entity type promote uses
 * for it (`connector_evidenced_pair`), and the purge adds the connector's page.
 *   - `owner`, proposed = someone else (or neither), claimed row: the new
 *     `built_by_vendor_id` and `claimed_at = NULL`, so the new owner must claim by
 *     its own act and the promote fence lifts. Issue: "Record integration owner".
 *   - `owner`, proposed = someone else, unclaimed row: nothing here.
 *
 * The owner-unknown claim of decision 11 is the third case: an endpoint vendor
 * contests the `owner` field on a row with no owner and proposes itself. Only an
 * endpoint vendor can file one, because contests require an endpoint seat. That is
 * enough: a non-endpoint owner claims its own connector-powered rows directly since
 * AECI-1089.
 *
 * A second sentinel (`contestIntegrationStateSentinel`) aborts the batch if the
 * row's claim state or owner moved after the read, so the cases above are always
 * decided on the state the batch commits against (`409 CONTEST_INTEGRATION_CHANGED`).
 *
 * This is the eighth named write exception in `ADMIN_PANEL_SPEC.md`: a decision
 * write, which since AECI-1005 also writes catalog data on the claimed-row paths.
 *
 * ── OWNER-ROUTED ROWS ARE READ-ONLY HERE, UNLESS STRANDED ───────────────────
 * The list can show them (`?routed_to=owner`) so an operator can see a dispute.
 * The PATCH refuses them with `409 CONTEST_ROUTED_TO_OWNER`: the owner decides, and
 * two deciders on one row is how a contest gets accepted twice with two values.
 * The exception is a STRANDED row, whose `owner_vendor_id` went NULL because the
 * owner vendor was deleted (`ON DELETE SET NULL`). No vendor can decide it any more,
 * so AECi does, exactly as if it had been routed here (AECI-1005).
 *
 * One batch per decision: the guarded UPDATE (`WHERE status = 'open'`), its
 * `audit_log` row, the workflow transition and instance update, and the
 * `notification.sent` row that tells the submitting vendor. The guarded UPDATE is
 * followed immediately by `contestStillOpenSentinel`, so a lost race rolls the
 * whole batch back (no audit, transition or notification) and answers 409, like
 * the vendor handlers.
 */

import {
  AdminContestSchema,
  ApiErrorCode,
  DecideContestSchema,
  ListAdminContestsQuerySchema,
  ListAdminContestsResponseSchema,
  type AdminContest,
  type IntegrationContestField,
  type ListAdminContestsResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import { integrationFieldChallenges, vendors, workflowInstances } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { logBatchToPosthog, logToPosthog, submitCount, type PosthogLogEvent } from '../posthog';
import { auditInsert, workflowTransitionInsert, type BatchStmt } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  vendorsForEvidencedPairSlots,
  vendorsForIntegrationSlots,
} from '../lib/attestation-authority';
import {
  claimColumns,
  claimNotificationAudit,
  INTEGRATION_CLAIMED_ACTION,
  isClaimed,
} from '../lib/integration-claims';
import {
  anchorEntityType,
  anchorMetadata,
  anchorPurgeTags,
  anchorUpdate,
  anchorUpdatedAction,
  anchorWriteMarkers,
  contestAnchorOf,
  contestAnchorWhere,
  hydratedTarget,
  loadContestTarget,
  rerouteToAeciStatements,
  ownerEntitlementActiveSentinel,
  vendorHoldsActiveEntitlement,
  type ContestAnchor,
  CONTEST_ENTITY_TYPE,
  CONTEST_FIELD_COLUMNS,
  contestIntegrationStateSentinel,
  contestValueUnchangedSentinel,
  isContestValueStale,
  storedFieldValue,
  type ContentContestField,
  contestValueLabel,
  hydrateContests,
  pairPathFor,
  type ContestHydration,
  type ContestIntegrationContext,
  type ContestRow,
  contestStillOpenSentinel,
} from '../lib/integration-contests';
import {
  createLinearIssueForContest,
  drizzleContestLinearStore,
  type ContestAppliedMode,
  type LinearIssueOutcome,
} from '../lib/linear';
import { ownerStillHolds, toContestProtest } from '../lib/contest-protests';
import { dispatchOwnerWriteSearch, syncOwnerWriteSearch } from './integration-retire-write';
import { pairCacheTag } from './promote-pair';
import {
  CONTEST_WORKFLOW_TYPE,
  endpointSlugs,
  notificationFor,
  runGuardedContestBatch,
} from './vendor-contests';
import { isConnectorPoweredEdge } from '../lib/connector-powered';
import { purgeTags } from './vendor-shared';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** The post-commit Linear seam. Injected so specs can assert it without a
 *  transport; the default is the real never-throwing creator. */
export type FileContestIssue = typeof createLinearIssueForContest;

const FINAL_OUTCOME = { accepted: 'approved', declined: 'rejected' } as const;

// ─── Mapping ─────────────────────────────────────────────────────────────────

export function toAdminContest(row: ContestRow, hydration: ContestHydration): AdminContest | null {
  const integration = hydratedTarget(hydration, row);
  if (!integration) return null;
  const link = (p: ContestIntegrationContext['sourceProduct']) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    logo_url: p.logoUrl,
  });
  const vendorRef = (id: string) => ({ id, name: hydration.vendorNames.get(id) ?? '' });
  const liveValue = storedFieldValue(integration, row.field as IntegrationContestField);
  return {
    id: row.id,
    integration: {
      id: integration.id,
      name: integration.name,
      source_product: link(integration.sourceProduct),
      target_product: link(integration.targetProduct),
      pair_path:
        pairPathFor([integration.sourceProduct.slug, integration.targetProduct.slug]) ?? '',
      anchor: integration.anchor,
      connector: integration.connectorProduct ? link(integration.connectorProduct) : null,
    },
    field: row.field as IntegrationContestField,
    current_value: row.currentValue,
    proposed_value: row.proposedValue,
    current_label: contestValueLabel(row.field, row.currentValue, hydration.vendorNames),
    proposed_label: contestValueLabel(row.field, row.proposedValue, hydration.vendorNames),
    live_value: liveValue,
    live_label: contestValueLabel(row.field, liveValue, hydration.vendorNames),
    value_stale: row.status === 'open' && isContestValueStale(row, integration),
    reason: row.reason,
    routed_to: row.routedTo as AdminContest['routed_to'],
    status: row.status as AdminContest['status'],
    submitter_vendor: vendorRef(row.submitterVendorId),
    owner_vendor: row.ownerVendorId ? vendorRef(row.ownerVendorId) : null,
    decision_note: row.decisionNote,
    decided_at: row.decidedAt,
    upstream_linear_issue_id: row.upstreamLinearIssueId,
    upstream_linear_issue_url: row.upstreamLinearIssueUrl,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    // AECI-1009: the protest, and whether the vendor that decided still holds the row.
    protest: toContestProtest(row),
    owner_changed: row.ownerVendorId !== null && !ownerStillHolds(row, integration),
  };
}

/** `aeci.contest.moderation.action` — one count per PATCH attempt, the contest
 *  twin of `aeci.claim.moderation.action` (`docs/OBSERVABILITY.md`). */
function emitModeration(
  c: AdminContext,
  decision: 'accept' | 'decline',
  outcome: 'ok' | 'not_open' | 'routed_to_owner',
): void {
  try {
    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.contest.moderation.action', 1, [
      `action:${decision}`,
      `outcome:${outcome}`,
    ]);
  } catch {
    // Telemetry must never fail a committed decision.
  }
}

/**
 * The §26.5 forward of a moderation write's audit rows and workflow transitions, as
 * ONE `logBatchToPosthog` call rather than one request per row. The events are the
 * ones {@link forwarders} logs, field for field. Each leg self-gates on its own key.
 */
export function forwardModerationBatch(
  c: AdminContext,
  audits: readonly AuditLogEntry[],
  transitions: readonly WorkflowTransitionEntry[],
): void {
  const events: PosthogLogEvent[] = [
    ...audits.map((entry) => ({
      level: 'info' as const,
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      source: 'admin-moderation',
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
    })),
    ...transitions.map((entry) => ({
      level: 'info' as const,
      message: `workflow ${entry.fromState ?? '∅'}→${entry.toState} ${entry.workflowId}`,
      source: 'admin-moderation',
      from_state: entry.fromState ?? undefined,
      to_state: entry.toState,
      workflow_id: entry.workflowId,
    })),
  ];
  if (events.length === 0) return;
  logBatchToPosthog(c.executionCtx, c.env, c.req.raw, events);
}

export function forwarders(c: AdminContext) {
  const log = (message: string, extra: Record<string, unknown>) => {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message,
      source: 'admin-moderation',
      ...extra,
    });
  };
  if (!c.env.POSTHOG_PROJECT_KEY) return { audit: undefined, workflow: undefined };
  return {
    audit: (entry: AuditLogEntry) =>
      log(`audit ${entry.action} ${entry.entityId ?? ''}`.trim(), {
        action: entry.action,
        entity_type: entry.entityType ?? undefined,
        entity_id: entry.entityId ?? undefined,
      }),
    workflow: (entry: WorkflowTransitionEntry) =>
      log(`workflow ${entry.fromState ?? '∅'}→${entry.toState} ${entry.workflowId}`, {
        from_state: entry.fromState ?? undefined,
        to_state: entry.toState,
        workflow_id: entry.workflowId,
      }),
  };
}

// ─── GET /api/admin/contests ─────────────────────────────────────────────────

export function createAdminContestsListHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListAdminContestsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const { db } = dbFor(c.env);
    // AECI-1009: `protest_status` switches the list to the Protests view. Every
    // protested row is `declined` and owner-routed, so the two contest filters are
    // ignored there. Served by `integration_field_challenges_protest_idx`.
    const protestView = query.protest_status !== undefined;
    const where = protestView
      ? eq(integrationFieldChallenges.protestStatus, query.protest_status as string)
      : and(
          eq(integrationFieldChallenges.status, query.status),
          eq(integrationFieldChallenges.routedTo, query.routed_to),
        );
    // Served by `integration_field_challenges_queue_idx (routed_to, status,
    // created_at)`. `id` breaks a `created_at` tie so pages are stable (AECI-99).
    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(integrationFieldChallenges)
        .where(where)
        .orderBy(
          desc(
            protestView
              ? integrationFieldChallenges.protestedAt
              : integrationFieldChallenges.createdAt,
          ),
          asc(integrationFieldChallenges.id),
        )
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(integrationFieldChallenges).where(where),
    ]);
    const hydration = await hydrateContests(db, rows);
    const body: ListAdminContestsResponse = {
      data: rows
        .map((row) => toAdminContest(row, hydration))
        .filter((row): row is AdminContest => row !== null),
      page: query.page,
      perPage: query.perPage,
      total: totalRows[0]?.value ?? 0,
    };
    validateResponseInDev(c.env, () => ListAdminContestsResponseSchema.parse(body));
    return json(body);
  };
}

// ─── PATCH /api/admin/contests/:id ───────────────────────────────────────────

export function createModerateContestHandler(
  dbFor: DbFactory = getDb,
  fileIssue: FileContestIssue = createLinearIssueForContest,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = c.req.param('id');
    if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing contest id', { field: 'id' });
    const payload = await DecideContestSchema.parseAsync(await readJson(c));
    const { db } = writeDb(c, dbFor);

    const row = await db.query.integrationFieldChallenges.findFirst({
      where: eq(integrationFieldChallenges.id, id),
    });
    if (!row) throw notFoundError('contest', { id });
    // A stranded owner-routed row (owner vendor deleted) is AECi's to decide.
    const stranded = row.routedTo === 'owner' && row.ownerVendorId === null;
    if (row.routedTo !== 'aeci' && !stranded) {
      emitModeration(c, payload.decision, 'routed_to_owner');
      throw new ApiError(
        409,
        ApiErrorCode.CONTEST_ROUTED_TO_OWNER,
        'This contest is decided by the integration’s owner, not by AECi.',
      );
    }
    if (row.status !== 'open') {
      emitModeration(c, payload.decision, 'not_open');
      throw new ApiError(
        409,
        ApiErrorCode.CONTEST_NOT_OPEN,
        `This contest is already ${row.status}.`,
      );
    }

    const status = payload.decision === 'accept' ? 'accepted' : 'declined';
    const note = payload.note ?? null;
    const now = new Date().toISOString();
    const metadata = {
      source: 'admin-moderation',
      contestId: id,
      ...anchorMetadata(contestAnchorOf(row)),
      field: row.field,
      submitterVendorId: row.submitterVendorId,
    };
    const audit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: `integration.contest.${status}`,
      entityType: CONTEST_ENTITY_TYPE,
      entityId: id,
      beforeState: { status: 'open' },
      afterState: { status, decision_note: note },
      metadata,
    };
    const workflowId = row.workflowId ?? crypto.randomUUID();
    const transition: WorkflowTransitionEntry = {
      workflowId,
      fromState: 'open',
      toState: status,
      actorId: session.userId,
      reason: note ?? `contest ${status}`,
      metadata,
    };
    const notify = await notificationFor(db, row, session, status);
    const accept =
      status === 'accepted'
        ? await planAcceptWrites(
            db,
            row,
            { actorId: session.userId, actorType: auditActorType(session) },
            now,
          )
        : null;
    if (accept) {
      // `appliedMode` is also what the §6.7 sweep reads back to re-file the issue.
      audit.metadata = {
        ...metadata,
        appliedMode: accept.appliedMode,
        ...(stranded ? { stranded: true } : {}),
      };
    }
    const audits = [audit, ...(accept?.audits ?? []), ...(notify ? [notify] : [])];

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
      // before the transition, the audit row and the notification.
      contestStillOpenSentinel(db, id),
      // AECI-1005: then the integration-state guard and any catalog write the accept
      // plans. Empty for a decline.
      ...(accept?.stmts ?? []),
      row.workflowId
        ? db
            .update(workflowInstances)
            .set({ currentState: status, completedAt: now, finalOutcome: FINAL_OUTCOME[status] })
            .where(eq(workflowInstances.id, workflowId))
        : db.insert(workflowInstances).values({
            id: workflowId,
            workflowType: CONTEST_WORKFLOW_TYPE,
            entityId: id,
            currentState: status,
            completedAt: now,
            finalOutcome: FINAL_OUTCOME[status],
          }),
      workflowTransitionInsert(db, transition),
      ...audits.map((entry) => auditInsert(db, entry)),
    ];
    let after: ContestRow;
    try {
      after = await runGuardedContestBatch(db, id, stmts);
    } catch (error) {
      if (error instanceof ApiError && error.code === ApiErrorCode.CONTEST_NOT_OPEN) {
        emitModeration(c, payload.decision, 'not_open');
      }
      // Both integration-side sentinels surface as CONTEST_INTEGRATION_CHANGED from
      // the shared runner, because SQLite's error does not carry the token. Tell the
      // value case apart by re-reading: claim state and owner as planned, but the
      // column moved, is the stale accept (AECI-1006).
      if (
        accept &&
        error instanceof ApiError &&
        error.code === ApiErrorCode.CONTEST_INTEGRATION_CHANGED &&
        (await acceptWentStale(db, row))
      ) {
        throw contestValueStale();
      }
      throw error;
    }
    emitModeration(c, payload.decision, 'ok');

    const hydration = await hydrateContests(db, [after]);
    // ONE request for every audit row and the transition (AECI-1092 review, the
    // AECI-666 connection-limit class). An accept can carry the owner claim, a
    // notification per endpoint vendor and several re-routes, and it shares the
    // tail with the purge, the Algolia sync and the Linear filing.
    forwardModerationBatch(c, audits, [transition]);
    if (accept) {
      if (accept.tags.length) c.executionCtx.waitUntil(purgeTags(c, accept.tags));
      // AECI-1092: an accept that wrote the row here takes the owner edit's search
      // tail too (a by-id Algolia sync, either table). An upstream-only accept wrote
      // nothing, so promote carries it.
      if (accept.appliedMode !== 'upstream-only') {
        const anchor = contestAnchorOf(after);
        dispatchOwnerWriteSearch(
          c,
          'admin-contest-algolia',
          syncOwnerWriteSearch(
            c,
            db,
            { integrations: [anchor.id], products: [], vendors: [] },
            'aeci.api.admin.contest_algolia_sync_failed',
          ),
        );
      }
      c.executionCtx.waitUntil(
        fileContestIssue(c, db, fileIssue, after, hydration, accept.appliedMode),
      );
    }

    const body = toAdminContest(after, hydration);
    if (!body) throw notFoundError('contest', { id });
    validateResponseInDev(c.env, () => AdminContestSchema.parse(body));
    return json(body);
  };
}

/** Build the issue input from a committed row and file it. Never rejects: the
 *  creator never throws, and a hydration gap resolves to a logged skip that the
 *  §6.7 sweep will retry. */
async function fileContestIssue(
  c: AdminContext,
  db: Db,
  fileIssue: FileContestIssue,
  row: ContestRow,
  hydration: ContestHydration,
  appliedMode: ContestAppliedMode,
): Promise<LinearIssueOutcome | null> {
  const integration = hydratedTarget(hydration, row);
  if (!integration) return null;
  return fileIssue(c, drizzleContestLinearStore(db), {
    contestId: row.id,
    integrationId: integration.id,
    ...(integration.anchor === 'evidenced_pair'
      ? {
          anchor: 'evidenced_pair' as const,
          connectorProductName: integration.connectorProduct?.name ?? null,
        }
      : {}),
    integrationName: integration.name,
    sourceProductName: integration.sourceProduct.name,
    targetProductName: integration.targetProduct.name,
    pairPath: pairPathFor([integration.sourceProduct.slug, integration.targetProduct.slug]),
    field: row.field,
    currentValue: row.currentValue,
    acceptedValue: row.proposedValue,
    currentLabel: contestValueLabel(row.field, row.currentValue, hydration.vendorNames),
    acceptedLabel: contestValueLabel(row.field, row.proposedValue, hydration.vendorNames),
    submitterVendorName: hydration.vendorNames.get(row.submitterVendorId) ?? row.submitterVendorId,
    reason: row.reason,
    adminNote: row.decisionNote,
    appliedMode,
  }).catch(() => null);
}

/**
 * Re-route every OPEN owner-routed contest on this row to AECi, because the accept
 * being planned takes the row away from the owner they were routed to (AECI-1005
 * review). Without it the old owner kept an inbox of contests on a row it no longer
 * owns, and could still accept them. The statements are
 * `rerouteToAeciStatements`'s, shared with ruling B's entitlement clear. The vendor
 * decide handler also refuses a caller that no longer owns the row, so a contest
 * submitted in the gap is covered too.
 */
async function rerouteOwnerContests(
  db: Db,
  deciding: ContestRow,
  anchor: ContestAnchor,
  actor: { actorId: string; actorType: AuditLogEntry['actorType'] },
  now: string,
  stmts: BatchStmt[],
  audits: AuditLogEntry[],
): Promise<void> {
  const open = await db
    .select()
    .from(integrationFieldChallenges)
    .where(
      and(
        contestAnchorWhere(anchor),
        eq(integrationFieldChallenges.routedTo, 'owner'),
        eq(integrationFieldChallenges.status, 'open'),
      ),
    );
  const reroute = rerouteToAeciStatements(
    db,
    open.filter((contest) => contest.id !== deciding.id),
    actor,
    now,
    'owner changed: re-routed to AECi',
    { reroutedBy: deciding.id },
  );
  stmts.push(...reroute.stmts);
  audits.push(...reroute.audits);
}

/**
 * An accept that makes a claimed row connector-powered moves the open owner-routed
 * contests on it that the owner may no longer decide (AECI-1092 review):
 *
 *  - every open `mechanism_kind` contest, always (ruling A: that column is frozen on a
 *    connector-powered row, so the owner can accept no contest on it);
 *  - every other open owner-routed contest when the owner holds no active entitlement
 *    (ruling B: deciding is an owner write, and ruling E would have sent them to AECi).
 *
 * An entitled owner keeps its content contests, as ruling B allows. Those rows get an
 * `updated_at` touch (the DB clock at commit) in the same batch, and `ownerEntitlementActiveSentinel` guards
 * the batch: a clear committing first aborts this accept, and a clear that planned
 * before this commit sees the touch move its fingerprint and re-plans against the
 * now connector-powered row. The touch changes no state, so it writes no audit row.
 */
async function rerouteOnBecomingConnectorPowered(
  db: Db,
  deciding: ContestRow,
  anchor: ContestAnchor,
  ownerVendorId: string,
  actor: { actorId: string; actorType: AuditLogEntry['actorType'] },
  now: string,
  stmts: BatchStmt[],
  audits: AuditLogEntry[],
): Promise<void> {
  const open = (
    await db
      .select()
      .from(integrationFieldChallenges)
      .where(
        and(
          contestAnchorWhere(anchor),
          eq(integrationFieldChallenges.routedTo, 'owner'),
          eq(integrationFieldChallenges.status, 'open'),
        ),
      )
  ).filter((contest) => contest.id !== deciding.id);
  if (open.length === 0) return;
  const entitled = await vendorHoldsActiveEntitlement(db, ownerVendorId);
  const moving = entitled ? open.filter((c) => c.field === 'mechanism_kind') : open;
  const staying = open.filter((c) => !moving.includes(c));
  const reroute = rerouteToAeciStatements(
    db,
    moving,
    actor,
    now,
    'row became connector-powered: re-routed to AECi',
    { reroutedBy: deciding.id, reason: 'became-connector-powered' },
  );
  stmts.push(...reroute.stmts);
  audits.push(...reroute.audits);
  if (staying.length > 0) {
    stmts.push(
      ownerEntitlementActiveSentinel(db, ownerVendorId),
      db
        .update(integrationFieldChallenges)
        // The DB clock AT COMMIT, not the request's `now` (review): the touch must be
        // newer than any contest updated before this batch lands, or a clear that
        // planned in between could see an unchanged MAX(updated_at). The format is
        // `toISOString()`'s (`YYYY-MM-DDTHH:MM:SS.sssZ`), so ordering stays lexical.
        .set({ updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` })
        .where(
          and(
            inArray(
              integrationFieldChallenges.id,
              staying.map((c) => c.id),
            ),
            eq(integrationFieldChallenges.status, 'open'),
          ),
        ),
    );
  }
}

/** `409 CONTEST_VALUE_STALE` (AECI-1006). */
function contestValueStale(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.CONTEST_VALUE_STALE,
    'The value on the integration changed after this contest was filed, most likely by its owner. Decline the contest, or ask the vendor to withdraw it and file again against the current value.',
  );
}

/** After a lost batch: did the contested column move while claim state held? */
async function acceptWentStale(db: Db, row: ContestRow): Promise<boolean> {
  const integration = await loadContestTarget(db, contestAnchorOf(row));
  return integration ? isContestValueStale(row, integration) : false;
}

/**
 * The integration-side half of an AECi accept (AECI-1005): the state guard, the
 * catalog write the header's cases call for, its audit rows, and the purge tags.
 * Every statement runs after the contest's own sentinel, so a lost decision race
 * writes none of it.
 *
 * AECI-1092: the row may be an `integrations` row or a connector-evidenced pair, and
 * every case below applies to both. The writes go to the anchor's own table, under
 * the entity type promote uses for it. Ruling C (§11b.13): an owner-approved accept
 * on a connector-powered row is no longer a special case; it records the owner and
 * the claim exactly as on any other row.
 */
export async function planAcceptWrites(
  db: Db,
  row: ContestRow,
  actor: { actorId: string; actorType: AuditLogEntry['actorType'] },
  now: string,
): Promise<{
  stmts: BatchStmt[];
  audits: AuditLogEntry[];
  tags: string[];
  appliedMode: ContestAppliedMode;
}> {
  const anchor = contestAnchorOf(row);
  const integration = await loadContestTarget(db, anchor);
  if (!integration) throw notFoundError('contest', { id: row.id });
  const claimed = isClaimed(integration);
  // AECI-1006: a content accept on a claimed row writes the column here, so it
  // must not land on a value that moved since submit (usually the owner's own
  // edit). The pre-read answers the common case; the sentinel below is the
  // in-batch half for an edit that lands after this read.
  if (isContestValueStale(row, integration)) throw contestValueStale();
  const stmts: BatchStmt[] = [
    contestIntegrationStateSentinel(db, anchor, {
      claimed,
      ownerVendorId: integration.builtByVendorId,
    }),
  ];
  if (row.field !== 'owner' && claimed) {
    stmts.push(
      contestValueUnchangedSentinel(db, anchor, row.field as ContentContestField, row.currentValue),
    );
  }
  const audits: AuditLogEntry[] = [];
  const field = row.field as IntegrationContestField;
  const base = {
    source: 'admin-moderation',
    contestId: row.id,
    ...anchorMetadata(anchor),
    ...anchorWriteMarkers(integration),
  };
  const entity = { entityType: anchorEntityType(anchor.kind), entityId: integration.id };

  let appliedMode: ContestAppliedMode = 'upstream-only';
  if (field !== 'owner') {
    if (claimed) {
      const column = CONTEST_FIELD_COLUMNS[field];
      stmts.push(anchorUpdate(db, anchor, { [column]: row.proposedValue }));
      audits.push({
        ...actor,
        action: anchorUpdatedAction(anchor.kind),
        ...entity,
        beforeState: { [field]: storedFieldValue(integration, field) },
        afterState: { [field]: row.proposedValue },
        metadata: { ...base, reason: 'contest-accepted' },
      });
      appliedMode = 'applied-here';
      // Review finding (AECI-1092): this accept can turn an ordinary claimed row into a
      // connector-powered one (`mechanism_kind` → `iPaaS` / `integrator`). Rulings A
      // and B then apply to the contests already open on it, in this same batch.
      if (
        field === 'mechanism_kind' &&
        !integration.connectorPowered &&
        integration.builtByVendorId !== null &&
        isConnectorPoweredEdge({
          poweredByProductId: integration.poweredByProductId,
          mechanismKind: row.proposedValue,
        })
      ) {
        await rerouteOnBecomingConnectorPowered(
          db,
          row,
          anchor,
          integration.builtByVendorId,
          actor,
          now,
          stmts,
          audits,
        );
      }
    }
  } else if (row.proposedValue === row.submitterVendorId) {
    // The owner-unknown claim (decision 11) and "we own it, not them" alike: an admin
    // approval is an act, so it sets `claimed_at` (decision 12). AECI-1092 ruling C:
    // this now holds on a connector-powered row too, in either table. The v1
    // exception (decision 9 kept the claim off those rows) is retired.
    const newOwner = row.submitterVendorId;
    stmts.push(anchorUpdate(db, anchor, { builtByVendorId: newOwner, ...claimColumns(now) }));
    audits.push({
      ...actor,
      action: INTEGRATION_CLAIMED_ACTION,
      ...entity,
      beforeState: {
        claimed_at: integration.claimedAt,
        built_by_vendor_id: integration.builtByVendorId,
        maintained_by: integration.maintainedBy,
        last_reviewed_at: integration.lastReviewedAt,
      },
      afterState: {
        claimed_at: now,
        built_by_vendor_id: newOwner,
        maintained_by: 'vendor',
        last_reviewed_at: now,
      },
      metadata: {
        ...base,
        reason: 'owner-approved',
        ...(integration.maintainedBy !== 'vendor' ? { maintenanceTransfer: true } : {}),
      },
    });
    // Tell every other endpoint vendor, exactly as the owner's own claim does.
    const [slotVendors, pairSlugs, owner] = await Promise.all([
      anchor.kind === 'evidenced_pair'
        ? vendorsForEvidencedPairSlots(db, [integration.id])
        : vendorsForIntegrationSlots(db, [integration.id]),
      endpointSlugs(db, integration.sourceProductId, integration.targetProductId),
      db.query.vendors.findFirst({
        columns: { companyName: true },
        where: eq(vendors.id, newOwner),
      }),
    ]);
    const slots = slotVendors.get(integration.id)?.slots;
    const recipients = [...new Set([...(slots?.vendor_a ?? []), ...(slots?.vendor_b ?? [])])]
      .filter((vendorId) => vendorId !== newOwner)
      .sort();
    for (const vendorId of recipients) {
      audits.push(
        claimNotificationAudit(
          actor,
          {
            vendorId,
            integrationId: integration.id,
            integrationName: integration.name,
            ownerVendorId: newOwner,
            ownerName: owner?.companyName ?? null,
            pairSlugs,
          },
          anchor.kind,
        ),
      );
    }
    appliedMode = 'owner-recorded';
    if (integration.builtByVendorId !== newOwner) {
      await rerouteOwnerContests(db, row, anchor, actor, now, stmts, audits);
    }
  } else if (claimed) {
    // Reassigned away from the vendor that claimed it, or to "neither": the new owner
    // has not acted, so `claimed_at` clears and the promote fence lifts (ADR 0035).
    stmts.push(anchorUpdate(db, anchor, { builtByVendorId: row.proposedValue, claimedAt: null }));
    audits.push({
      ...actor,
      action: anchorUpdatedAction(anchor.kind),
      ...entity,
      beforeState: {
        built_by_vendor_id: integration.builtByVendorId,
        claimed_at: integration.claimedAt,
      },
      afterState: { built_by_vendor_id: row.proposedValue, claimed_at: null },
      metadata: { ...base, reason: 'owner-reassigned' },
    });
    appliedMode = 'owner-recorded';
    await rerouteOwnerContests(db, row, anchor, actor, now, stmts, audits);
  }

  let tags: string[] = [];
  if (appliedMode !== 'upstream-only') {
    tags = (await anchorPurgeTags(db, integration, pairCacheTag)).tags;
  }
  return { stmts, audits, tags, appliedMode };
}

export async function readJson(c: AdminContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
}

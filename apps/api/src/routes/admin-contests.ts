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
 *     Since AECI-1628 it also writes a record-only `field_overrides` row (born
 *     lifted, so a caption and never a lock), and so requires `sourceUrl`.
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
  AdminDecideContestSchema,
  ApiErrorCode,
  vendorVisibleReasonMetadata,
  ListAdminContestsQuerySchema,
  ListAdminContestsResponseSchema,
  type AdminContest,
  type IntegrationContestField,
  type ListAdminContestsResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { FieldOverrideEntityType as LockEntity } from '@aeci/shared';
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { and, asc, count, desc, eq, isNotNull } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import { integrationFieldChallenges, vendors, workflowInstances } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { logBatchToPosthog, submitCount, type PosthogLogEvent } from '../posthog';
import {
  auditInsert,
  landedAuditEntries,
  workflowTransitionInsert,
  type BatchStmt,
} from '../lib/audit';
import { guardedHideAuditStatement, vendorEditHideClears } from '../lib/field-hides';
import { aeciOverrideNotificationAudit } from '../lib/aeci-override-notifications';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import {
  assertFieldsUnlocked,
  correctionRecordInsert,
  fieldsUnlockedSentinel,
  lockRaceRefusal,
} from '../lib/field-overrides';
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
  clearSeatStamp,
  type ContestAnchor,
  CONTEST_ENTITY_TYPE,
  CONTEST_FIELD_COLUMNS,
  contestIntegrationStateSentinel,
  contestValueUnchangedSentinel,
  acceptOverwritesVendorField,
  acceptRecordsCorrection,
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
import {
  anyThreadMoveRaced,
  openThreadsOnAnchor,
  planThreadMoveCloses,
} from '../lib/claim-thread-lifecycle';
import { purgeTags } from './vendor-shared';
import { vendorAuditStamp } from '../lib/audit-vendor';
import { dispatchMirrorSync } from '../lib/ownership-sync';

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
    accept_note_required: row.status === 'open' && acceptOverwritesVendorField(row, integration),
    accept_source_required: row.status === 'open' && acceptRecordsCorrection(row, integration),
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
 * `audit {action} {id}` / `workflow {from}→{to} {id}` lines every §26.5 forward sends,
 * field for field. Each leg self-gates on its own key.
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
    const payload = await AdminDecideContestSchema.parseAsync(await readJson(c));
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
    // AECI-1159: AECi's own note, never shown to a vendor. On the decision's audit row.
    const internalNote = payload.internalNote;
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
    const notify = await notificationFor(
      'portal-contest-decided-by-aeci',
      db,
      row,
      session,
      status,
    );
    const accept =
      status === 'accepted'
        ? await planAcceptWrites(
            db,
            row,
            { actorId: session.userId, actorType: auditActorType(session) },
            now,
            { sourceUrl: payload.sourceUrl ?? null, reason: note, internalNote },
          )
        : null;
    if (accept?.overwritesVendorField && !note) {
      // AECI-1191: an accept that changes a vendor-held value says why. Checked
      // after the stale and routing refusals, before anything is written.
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        'Add a note. This accept changes a value the integration’s owner holds.',
        { field: 'note' },
      );
    }
    if (accept?.recordsCorrection && !payload.sourceUrl) {
      // AECI-1628: the accept is recorded as AECi's correction and shown publicly with
      // its source, so it names one. Same point as the note check.
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        'Add a source link. This accept is shown on the listing as AEC Integrations’ correction.',
        { field: 'sourceUrl' },
      );
    }
    if (accept) {
      // `appliedMode` is also what the §6.7 sweep reads back to re-file the issue.
      // AECI-1191: the admin's note is the reason, on the decision's own row.
      // AECI-1159: on an accept that overwrites the owner's value, it is the reason
      // shown to the displaced owner, and is marked vendor-visible.
      audit.metadata = {
        ...metadata,
        appliedMode: accept.appliedMode,
        ...(stranded ? { stranded: true } : {}),
        ...(note
          ? accept.overwritesVendorField
            ? vendorVisibleReasonMetadata({ reason: note, internalNote })
            : { reason: note }
          : {}),
      };
    }
    if (internalNote) audit.metadata = { ...(audit.metadata ?? {}), internalNote };
    // AECI-1159: the displaced owner is told, with the reason, in the same batch.
    // Before this it was told nothing. The submitter keeps its own decision notice.
    const displaced =
      accept?.displacedOwner && note
        ? aeciOverrideNotificationAudit(
            'portal-field-overridden-by-aeci',
            { actorId: session.userId, actorType: auditActorType(session) },
            {
              event: 'field_overridden',
              vendorId: accept.displacedOwner.vendorId,
              reason: note,
              integrationId: accept.displacedOwner.integrationId,
              integrationName: accept.displacedOwner.integrationName,
              field: row.field,
              pairSlugs: accept.displacedOwner.pairSlugs,
              entityType: accept.displacedOwner.entityType,
            },
          )
        : null;
    // AECI-1192 / AECI-1193: the decision and any catalog write it applies are about
    // the integration the OWNER holds, so they carry the owner and its plan, never the
    // submitter (`submitterVendorId` stays in metadata). The notification keeps its
    // recipient. A stranded row has no owner: both columns stay NULL.
    const stamp = await vendorAuditStamp(db, row.ownerVendorId);
    const audits = [
      { ...audit, ...stamp },
      // A row that already names a vendor is a `notification.sent` to its recipient.
      ...(accept?.audits ?? []).map((entry) => (entry.vendorId ? entry : { ...entry, ...stamp })),
      ...(notify ? [notify] : []),
      ...(displaced ? [displaced] : []),
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
      after = await runGuardedContestBatch(db, id, stmts, accept?.lockRace);
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
    // AECI-1238: a hide the accept ended forwards only if its guarded row landed.
    const landedHideRows = accept?.guardedAudits.length
      ? await landedAuditEntries(db, accept.guardedAudits)
      : [];
    forwardModerationBatch(c, [...audits, ...landedHideRows], [transition]);
    if (accept) {
      if (accept.tags.length) c.executionCtx.waitUntil(purgeTags(c, accept.tags));
      // AECI-1092: an accept that wrote the row here takes the owner edit's search
      // tail too (a by-id Algolia sync, either table). An upstream-only accept wrote
      // nothing, so promote carries it. So did an owner accept naming the holder
      // (AECI-1235), which has nothing to sync.
      if (accept.wroteHere) {
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
      // AECI-1413: an accept that wrote the row here changed an owned record's content,
      // and this route does not run through `afterVendorWrite`. An upstream-only accept
      // wrote nothing here, so there is nothing to mirror.
      if (accept.wroteHere) dispatchMirrorSync(c, audits, 'admin', db);
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
  return fileIssue(c, drizzleContestLinearStore(db, 'contest-accept'), {
    notification: 'linear-contest-issue',
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
 * `rerouteToAeciStatements`'s, shared with the became-connector-powered accept. The vendor
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
 * contests on it that the owner may no longer decide (AECI-1092 review): every open
 * `mechanism_kind` contest (ruling A: that column is frozen on a connector-powered
 * row, so the owner can accept no contest on it). Every other contest stays with the
 * owner, on any plan (AECI-1663, ruling 14, retired rulings B and E).
 *
 * A `mechanism_kind` contest a seat lapse already moved to AECi on this row (stamped
 * with `owner_seat_lapsed_at`, AECI-989) loses the stamp, so no seat event can send
 * it back (AECI-1092 reconciliation, §11b.13).
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
  const stamped = (
    await db
      .select()
      .from(integrationFieldChallenges)
      .where(
        and(
          contestAnchorWhere(anchor),
          eq(integrationFieldChallenges.routedTo, 'aeci'),
          eq(integrationFieldChallenges.ownerVendorId, ownerVendorId),
          eq(integrationFieldChallenges.status, 'open'),
          isNotNull(integrationFieldChallenges.ownerSeatLapsedAt),
        ),
      )
  ).filter((contest) => contest.id !== deciding.id);
  const moving = open.filter((c) => c.field === 'mechanism_kind');
  const unstamping = stamped.filter((c) => c.field === 'mechanism_kind');
  if (moving.length === 0 && unstamping.length === 0) return;
  const unstamp = clearSeatStamp(db, unstamping, actor, now, {
    reason: 'became-connector-powered',
    reroutedBy: deciding.id,
  });
  stmts.push(...unstamp.stmts);
  audits.push(...unstamp.audits);
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
}

/** `409 CONTEST_VALUE_STALE` (AECI-1006). */
function contestValueStale(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.CONTEST_VALUE_STALE,
    'The value on the integration changed after this contest was filed, most likely by its owner. Decline the contest, or ask the vendor to withdraw it and file again against the current value.',
  );
}

/**
 * `409 CONTEST_INTEGRATION_CHANGED` for a private-thread race on an accept that makes
 * the row connector-powered (AECI-1661, §15.10). No new error code: the admin queue
 * already handles this one on its generic retry path (`ADMIN_PANEL_SPEC.md` §5.12).
 */
function threadRaceRefusal(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.CONTEST_INTEGRATION_CHANGED,
    'A private thread on this integration was opened or closed while you were deciding. Reload and decide again.',
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
  /**
   * AECI-1628: what the correction record carries on an `applied-here` accept. The
   * record is written only when both `sourceUrl` and `reason` are present; the handler
   * refuses the accept without them (`recordsCorrection`), so it never commits bare.
   */
  record?: { sourceUrl: string | null; reason: string | null; internalNote?: string | null },
): Promise<{
  stmts: BatchStmt[];
  audits: AuditLogEntry[];
  tags: string[];
  appliedMode: ContestAppliedMode;
  /**
   * AECI-1235: the accept writes the integration row here. False for an
   * `upstream-only` accept and for an `owner` accept naming the current holder,
   * which records the owner without writing it. Gates the purge and the Algolia sync.
   */
  wroteHere: boolean;
  /** AECI-1191: the accept changes a vendor-held value, so it requires a note. */
  overwritesVendorField: boolean;
  /**
   * AECI-1628: the accept writes a vendor-held content field here, so it is recorded
   * as AECi's correction (a record-only `field_overrides` row) and requires a source.
   */
  recordsCorrection: boolean;
  /**
   * AECI-1159: the owner whose value the accept overwrites, when it is a vendor
   * other than the submitter. `null` when nothing vendor-held changes, or when the
   * row has no owner on file.
   */
  displacedOwner: DisplacedOwner | null;
  /** AECI-1237: names a lock that landed mid-batch, for `runGuardedContestBatch`. */
  lockRace?: () => Promise<ApiError | null>;
  /**
   * AECI-1238 (§11d.7): the `field_hide_cleared` rows and their notices, already in
   * `stmts` as guarded inserts. Forward only `landedAuditEntries` of these, never
   * insert them again.
   */
  guardedAudits: AuditLogEntry[];
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
  let wroteHere = true;
  let lockRace: (() => Promise<ApiError | null>) | undefined;
  const guardedAudits: AuditLogEntry[] = [];
  if (field !== 'owner') {
    if (claimed) {
      // AECI-1237 (§11d.5): this accept writes the column, and a field AECi corrected
      // and locked is written only through the lock. Lift it first, then decide. The
      // sentinel is the in-batch half for a lock set while this admin decided.
      const lockEntity = anchorEntityType(anchor.kind) as LockEntity;
      await assertFieldsUnlocked(db, lockEntity, anchor.id, [field]);
      const lockSentinel = fieldsUnlockedSentinel(db, lockEntity, anchor.id, [field]);
      if (lockSentinel) stmts.push(lockSentinel);
      lockRace = () => lockRaceRefusal(db, lockEntity, anchor.id, [field]);
      const column = CONTEST_FIELD_COLUMNS[field];
      stmts.push(anchorUpdate(db, anchor, { [column]: row.proposedValue }));
      // AECI-1628 (§11b.6, §11d.5): AECi just wrote a value the owner holds, so the
      // write is recorded as AECi's correction. A record-only row, born lifted: it
      // captions the value publicly and never locks it, so the owner can still edit.
      // After the sentinels and the column update, in the same batch.
      let recordMeta: { overrideId: string; sourceUrl: string } | null = null;
      if (record?.sourceUrl && record.reason) {
        const overrideId = crypto.randomUUID();
        stmts.push(
          correctionRecordInsert(db, {
            id: overrideId,
            entityType: lockEntity,
            entityId: integration.id,
            field,
            value: row.proposedValue,
            sourceUrl: record.sourceUrl,
            reason: record.reason,
            internalNote: record.internalNote ?? null,
            vendorId: integration.builtByVendorId,
            actorId: actor.actorId,
            at: now,
          }),
        );
        recordMeta = { overrideId, sourceUrl: record.sourceUrl };
      }
      audits.push({
        ...actor,
        action: anchorUpdatedAction(anchor.kind),
        ...entity,
        beforeState: { [field]: storedFieldValue(integration, field) },
        afterState: { [field]: row.proposedValue },
        metadata: { ...base, reason: 'contest-accepted', ...(recordMeta ?? {}) },
      });
      // AECI-1238 (§11d.7): AECi replaced the value, so a hide on the field ends here
      // as a correction, and the vendor named on the hide is told. The notice and the
      // audit row are guarded on the hide still standing.
      if (storedFieldValue(integration, field) !== row.proposedValue) {
        const hideClear = await vendorEditHideClears(db, {
          entityType: lockEntity,
          entityId: integration.id,
          changedFields: [field],
          actor,
          stamp: await vendorAuditStamp(db, integration.builtByVendorId),
          at: now,
          source: 'admin-moderation',
          kind: 'corrected',
          reason: record?.reason ?? null,
        });
        if (hideClear.hides.length > 0) {
          const pairSlugs = await endpointSlugs(
            db,
            integration.sourceProductId,
            integration.targetProductId,
          );
          for (const hide of hideClear.hides) {
            if (!hide.vendorId || !record?.reason) continue;
            const notice = aeciOverrideNotificationAudit(
              'portal-field-hide-cleared-by-aeci',
              actor,
              {
                event: 'field_hide_cleared',
                vendorId: hide.vendorId,
                reason: record.reason,
                fieldHideId: hide.id,
                field: hide.field,
                clearKind: 'corrected',
                entityType: lockEntity as 'integration' | 'connector_evidenced_pair',
                entityId: integration.id,
                integrationName: integration.name,
                pairSlugs,
              },
            );
            stmts.push(guardedHideAuditStatement(db, hide.id, notice));
            guardedAudits.push(notice);
          }
          stmts.push(...hideClear.stmts);
          guardedAudits.push(...hideClear.audits);
        }
      }
      appliedMode = 'applied-here';
      // Review finding (AECI-1092): this accept can turn an ordinary claimed row into a
      // connector-powered one (`mechanism_kind` → `iPaaS` / `integrator`). An evidenced
      // pair is connector-powered by definition, so this names an `integrations` row.
      // Rulings A and B then apply to the contests already open on it, in this same
      // batch, and AECI-1661 closes its open threads.
      if (
        field === 'mechanism_kind' &&
        anchor.kind === 'integration' &&
        !integration.connectorPowered &&
        isConnectorPoweredEdge({
          poweredByProductId: integration.poweredByProductId,
          mechanismKind: row.proposedValue,
        })
      ) {
        // AECI-1661 (§15.10): the thread routes refuse every write on a
        // connector-powered edge (§15.2), so the row's open threads close
        // `not_attestable` in this batch, after the column UPDATE — the same closes,
        // sentinels and race rule as promote's in-place flip (AECI-1541). Planned
        // even when no thread is open, so a first post landing between the read and
        // the batch cannot leave an open thread (AECI-1544).
        const threads = await openThreadsOnAnchor(db, anchor.id);
        const threadPlan = planThreadMoveCloses(db, {
          threads,
          anchorId: anchor.id,
          now,
          cause: 'became_connector_powered',
          // The admin's accept caused the close, so the rows name the admin, not
          // `system`.
          actor,
        });
        stmts.push(...threadPlan.stmts);
        audits.push(...threadPlan.audits);
        // The plan's sentinels abort like every other, and SQLite's error carries no
        // token. Name a thread race after the lock race, which has priority, and only
        // while the contest is still open: a second admin who won the same accept
        // closed these threads too, and that loser must hear CONTEST_NOT_OPEN.
        const lockNamer = lockRace;
        lockRace = async () => {
          const locked = lockNamer ? await lockNamer() : null;
          if (locked) return locked;
          const current = await db.query.integrationFieldChallenges.findFirst({
            columns: { status: true },
            where: eq(integrationFieldChallenges.id, row.id),
          });
          if (current?.status !== 'open') return null;
          return (await anyThreadMoveRaced(db, [threadPlan.planned])) ? threadRaceRefusal() : null;
        };
        if (integration.builtByVendorId !== null) {
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
    }
  } else if (row.proposedValue === row.submitterVendorId) {
    // The owner-unknown claim (decision 11) and "we own it, not them" alike: an admin
    // approval is an act, so it sets `claimed_at` (decision 12). AECI-1092 ruling C:
    // this now holds on a connector-powered row too, in either table. The v1
    // exception (decision 9 kept the claim off those rows) is retired.
    const newOwner = row.submitterVendorId;
    stmts.push(
      anchorUpdate(db, anchor, {
        builtByVendorId: newOwner,
        ...claimColumns(now),
        // AECI-1614: the new owner has written nothing, so the old owner's date cannot
        // stand under its name. The same owner re-recorded keeps its date.
        ...(integration.builtByVendorId !== newOwner ? { vendorEditedAt: null } : {}),
      }),
    );
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
          'portal-integration-claim',
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
  } else if (claimed && row.proposedValue === integration.builtByVendorId) {
    // AECI-1235: another vendor proposed the vendor that holds the claim, usually
    // filed before that vendor claimed it. Nothing changes hands: no write, no
    // re-route, and `claimed_at` stays. Same test as `acceptOverwritesVendorField`.
    // The state sentinel above still aborts if the holder lost the claim meanwhile.
    // The issue is "Record integration owner", so the review app records the holder.
    appliedMode = 'owner-recorded';
    wroteHere = false;
  } else if (claimed) {
    // Reassigned away from the vendor that claimed it, or to "neither": the new owner
    // has not acted, so `claimed_at` clears and the promote fence lifts (ADR 0035).
    stmts.push(
      anchorUpdate(db, anchor, {
        builtByVendorId: row.proposedValue,
        claimedAt: null,
        // AECI-1614: promote can write the row again, and the caption goes with the claim.
        vendorEditedAt: null,
      }),
    );
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

  wroteHere &&= appliedMode !== 'upstream-only';
  let tags: string[] = [];
  if (wroteHere) {
    tags = (await anchorPurgeTags(db, integration, pairCacheTag)).tags;
  }
  const overwritesVendorField = acceptOverwritesVendorField(row, integration);
  const displacedId = integration.builtByVendorId;
  const displacedOwner: DisplacedOwner | null =
    overwritesVendorField && displacedId && displacedId !== row.submitterVendorId
      ? {
          vendorId: displacedId,
          integrationId: integration.id,
          integrationName: integration.name,
          entityType: anchorEntityType(anchor.kind),
          pairSlugs: await endpointSlugs(
            db,
            integration.sourceProductId,
            integration.targetProductId,
          ),
        }
      : null;
  return {
    stmts,
    audits,
    tags,
    appliedMode,
    wroteHere,
    overwritesVendorField,
    recordsCorrection: acceptRecordsCorrection(row, integration),
    displacedOwner,
    lockRace,
    guardedAudits,
  };
}

/** The owner an AECi accept displaces (AECI-1159), as its notice snapshots it. */
interface DisplacedOwner {
  vendorId: string;
  integrationId: string;
  integrationName: string | null;
  entityType: string;
  pairSlugs: readonly [string, string] | null;
}

export async function readJson(c: AdminContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
}

/**
 * Protests to AECi, admin side (AECI-1009 / `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11b.12) — Drizzle/D1.
 *
 *   PATCH /api/admin/contests/:id/protest — AECi says which side it agrees with.
 *
 * **The ruling is advice (ruled 2026-09-22).** It writes the protest columns and
 * nothing else: no `integrations` write, no maintenance transfer, no purge, no
 * re-crawl, no Algolia write and no Linear issue. The owner decides the field
 * (ADR 0035 decision 1); an upheld protest tells both vendors that AECi agrees
 * with the submitter, and the owner may then edit, or not.
 *
 * **The owner's reply deadline does not block AECi** (ruled). Nor does a change of
 * owner after filing: the ruling is about a decision already made.
 *
 * One batch: the guarded `UPDATE … WHERE protest_status = 'open'`, the
 * `changes() = 0` sentinel immediately after it, the protest instance closed with
 * its transition, the audit row, and a `notification.sent` row to each side. A lost
 * race writes nothing and answers `409 PROTEST_NOT_OPEN`.
 */

import {
  addContestDays,
  CONTEST_PROTEST_COOLDOWN_DAYS,
  DecideContestProtestSchema,
  AdminContestSchema,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq } from 'drizzle-orm';

import { getDb } from '../db/client';
import { integrationFieldChallenges } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { PROTEST_ACTIONS, protestNotOpen, runGuardedProtestBatch } from '../lib/contest-protests';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  anchorMetadata,
  contestAnchorOf,
  CONTEST_ENTITY_TYPE,
  contestStillOpenSentinel,
  hydrateContests,
} from '../lib/integration-contests';
import { forwardModerationBatch, readJson, toAdminContest } from './admin-contests';
import { closeProtestWorkflow, protestNotifications, type Clock } from './vendor-contest-protests';
import type { VendorContext } from './vendor-shared';

type AdminContext = VendorContext;

export function createDecideContestProtestHandler(
  dbFor: DbFactory = getDb,
  clock: Clock = () => new Date(),
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = c.req.param('id');
    if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing contest id', { field: 'id' });
    const { db } = writeDb(c, dbFor);

    const row = await db.query.integrationFieldChallenges.findFirst({
      where: eq(integrationFieldChallenges.id, id),
    });
    if (!row) throw notFoundError('contest', { id });
    if (row.protestStatus !== 'open') throw protestNotOpen();

    const payload = await DecideContestProtestSchema.parseAsync(await readJson(c));
    const status = payload.decision === 'uphold' ? 'upheld' : 'rejected';
    const now = clock().toISOString();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const metadata = {
      source: 'admin-moderation',
      contestId: id,
      ...anchorMetadata(contestAnchorOf(row)),
      field: row.field,
      submitterVendorId: row.submitterVendorId,
    };
    const cooldownUntil =
      status === 'rejected' ? addContestDays(now, CONTEST_PROTEST_COOLDOWN_DAYS) : undefined;
    const event = status === 'upheld' ? 'protest_upheld' : 'protest_rejected';
    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: status === 'upheld' ? PROTEST_ACTIONS.upheld : PROTEST_ACTIONS.rejected,
        entityType: CONTEST_ENTITY_TYPE,
        entityId: id,
        beforeState: { protest_status: 'open' },
        afterState: { protest_status: status, protest_decision_note: payload.note },
        metadata,
      },
      // Both sides hear the outcome. A deleted owner (`owner_vendor_id` NULL) is skipped.
      ...(await protestNotifications(db, row, actor, event, [
        {
          vendorId: row.submitterVendorId,
          extra: { recipientRole: 'submitter', ...(cooldownUntil ? { cooldownUntil } : {}) },
        },
        { vendorId: row.ownerVendorId, extra: { recipientRole: 'owner' } },
      ])),
    ];
    const stmts: BatchStmt[] = [
      db
        .update(integrationFieldChallenges)
        .set({
          protestStatus: status,
          protestDecisionNote: payload.note,
          protestDecidedBy: session.userId,
          protestDecidedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(integrationFieldChallenges.id, id),
            eq(integrationFieldChallenges.protestStatus, 'open'),
          ),
        ),
      contestStillOpenSentinel(db, id),
      ...closeProtestWorkflow(db, row, status, session.userId, payload.note, metadata, now),
      ...audits.map((entry) => auditInsert(db, entry)),
    ];
    const after = await runGuardedProtestBatch(db, id, stmts, async () => protestNotOpen());

    // ONE request for every audit row (AECI-1092 review, the AECI-666 class).
    forwardModerationBatch(c, audits, []);

    const hydration = await hydrateContests(db, [after]);
    const body = toAdminContest(after, hydration);
    if (!body) throw notFoundError('contest', { id });
    validateResponseInDev(c.env, () => AdminContestSchema.parse(body));
    return json(body);
  };
}

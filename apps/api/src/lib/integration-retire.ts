/**
 * Integration retire and restore: the pieces the route, the notification feed and the
 * specs share (AECI-1010 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.6).
 *
 * The read-side half, the "live integration" predicate every count and public read
 * applies, is `./live-integration`. This module is the write-side half.
 */

import {
  orderedPairSlugs,
  type IntegrationRetireEvent,
  type IntegrationRetiredBy,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { integrationFieldChallenges } from '../db/schema';
import { NOTIFICATION_SENT_ACTION } from './attestation-notify';
import { ONE_ROW } from './integration-claims';
import {
  anchorColumnSql,
  contestAnchorWhere,
  toContestAnchor,
  type ContestAnchor,
} from './integration-contests';

/** `audit_log.entity_type` for every write to a `connector_evidenced_pairs` row
 *  (AECI-1091), as promote records a pair write (`routes/promote.ts`). */
export const EVIDENCED_PAIR_ENTITY_TYPE = 'connector_evidenced_pair';

/** `metadata.anchor` on a pair write's audit rows, as the AECI-1089 claim writes it. */
export const EVIDENCED_PAIR_ANCHOR = 'evidenced_pair';

/** `audit_log.action` for a retire and a restore. */
export const INTEGRATION_RETIRED_ACTION = 'integration.retired';
export const INTEGRATION_RESTORED_ACTION = 'integration.restored';

/** `metadata.kind` on the `notification.sent` row a retire or restore writes. */
export const RETIRE_NOTIFICATION_KIND = 'integration_retire';

/** `workflow_transitions.reason`, and the contest audit row's `metadata.reason`, for a
 *  contest a retire closed. Distinguishes it from a submitter's own withdraw. */
export const RETIRE_CLOSED_CONTEST_REASON = 'integration retired';

/**
 * A batch statement that ABORTS the batch when the statement before it changed zero
 * rows. Push it immediately after the retire's or restore's guarded UPDATE, so a
 * concurrent retire, restore, or owner change rolls back the audit row and the
 * notifications with it. `json('integration-retire-race')` is malformed JSON, so it
 * raises. Same mechanism as `claimRaceSentinel`, and over the same `ONE_ROW` source, so
 * it fires even when the guarded row is gone.
 */
export function retireRaceSentinel(db: Db) {
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json('integration-retire-race') END` })
    .from(ONE_ROW);
}

/**
 * A batch statement that ABORTS a retire when any contest on the row is still open
 * after the retire's own closes ran. The handler reads the open contests before the
 * batch; a contest submitted in between would otherwise stay open on a retired row.
 * Paired with the contest submit's `integrationLiveSentinel`, which covers the other
 * interleaving. Selects FROM `ONE_ROW`, so it evaluates exactly once.
 */
export function noOpenContestsSentinel(db: Db, anchor: ContestAnchor | string) {
  // AECI-1091: either anchor column (AECI-1092's `evidenced_pair_id` for a pair).
  // A bare id means an `integrations` row, the pre-AECI-1092 call form.
  const { kind, id } = toContestAnchor(anchor);
  return db
    .select({
      guard: sql`CASE WHEN EXISTS (
        SELECT 1 FROM ${integrationFieldChallenges}
        WHERE ${anchorColumnSql(kind)} = ${id}
          AND ${integrationFieldChallenges.status} = 'open'
      ) THEN json('integration-retire-race') END`,
    })
    .from(ONE_ROW);
}

/** True for the error either sentinel above raises, or a contest sentinel in the same
 *  batch. The handler re-reads and re-derives the refusal, so it need not tell them
 *  apart. */
export function isRetireRaceError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/malformed JSON/i.test(text) || text.includes('integration-retire-race')) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The open contests on one row, oldest first. What a retire closes. Either anchor
 *  (AECI-1091): a pair's contests sit on `evidenced_pair_id` (AECI-1092). */
export function openContestsOn(db: Db, anchor: ContestAnchor | string) {
  return db.query.integrationFieldChallenges.findMany({
    where: and(
      contestAnchorWhere(toContestAnchor(anchor)),
      eq(integrationFieldChallenges.status, 'open'),
    ),
    orderBy: (t, { asc }) => [asc(t.createdAt), asc(t.id)],
  });
}

/** What a retire or restore `notification.sent` row records. `vendorId` is the
 *  RECIPIENT, which is what the feed's `json_extract(metadata, '$.vendorId')` matches. */
export interface RetireNotificationMetadata {
  kind: typeof RETIRE_NOTIFICATION_KIND;
  event: IntegrationRetireEvent;
  /** Who retired or restored it (AECI-1046). Absent on rows written before it,
   *  which the feed reads as `'owner'`. */
  retiredBy: IntegrationRetiredBy;
  vendorId: string;
  integrationId: string;
  integrationName: string | null;
  /** `null` only on an admin write to a vendor-held row with no owner on file. */
  ownerVendorId: string | null;
  ownerName: string | null;
  pairSlugs: readonly [string, string] | null;
}

/**
 * The `notification.sent` row telling one vendor that the owner, or since AECI-1046
 * AEC Integrations, retired or restored an integration on its product. An admin write
 * also notifies the owner. Pushed into the SAME batch as the write.
 * `entity_type` is `integration`, like the claim notification.
 */
export function retireNotificationAudit(
  actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] },
  metadata: Omit<RetireNotificationMetadata, 'kind'>,
  /** `'connector_evidenced_pair'` for a pair (AECI-1091), as every pair write
   *  records it. The feed reads `metadata`, never the entity type. */
  entityType: 'integration' | typeof EVIDENCED_PAIR_ENTITY_TYPE = 'integration',
): AuditLogEntry {
  const full: RetireNotificationMetadata = {
    kind: RETIRE_NOTIFICATION_KIND,
    ...metadata,
    pairSlugs: metadata.pairSlugs ? orderedPairSlugs(...metadata.pairSlugs) : null,
  };
  return {
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: NOTIFICATION_SENT_ACTION,
    entityType,
    entityId: metadata.integrationId,
    metadata: full,
  };
}

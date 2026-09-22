/**
 * Integration retire and restore: the pieces the route, the notification feed and the
 * specs share (AECI-1010 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.6).
 *
 * The read-side half, the "live integration" predicate every count and public read
 * applies, is `./live-integration`. This module is the write-side half.
 */

import { orderedPairSlugs, type IntegrationRetireEvent } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { integrationFieldChallenges } from '../db/schema';
import { NOTIFICATION_SENT_ACTION } from './attestation-notify';
import { ONE_ROW } from './integration-claims';

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
export function noOpenContestsSentinel(db: Db, integrationId: string) {
  return db
    .select({
      guard: sql`CASE WHEN EXISTS (
        SELECT 1 FROM ${integrationFieldChallenges}
        WHERE ${integrationFieldChallenges.integrationId} = ${integrationId}
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

/** The open contests on one integration, oldest first. What a retire closes. */
export function openContestsOn(db: Db, integrationId: string) {
  return db.query.integrationFieldChallenges.findMany({
    where: and(
      eq(integrationFieldChallenges.integrationId, integrationId),
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
  vendorId: string;
  integrationId: string;
  integrationName: string | null;
  ownerVendorId: string;
  ownerName: string | null;
  pairSlugs: readonly [string, string] | null;
}

/**
 * The `notification.sent` row telling one endpoint vendor that the owner retired or
 * restored an integration on its product. Pushed into the SAME batch as the write.
 * `entity_type` is `integration`, like the claim notification.
 */
export function retireNotificationAudit(
  actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] },
  metadata: Omit<RetireNotificationMetadata, 'kind'>,
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
    entityType: 'integration',
    entityId: metadata.integrationId,
    metadata: full,
  };
}

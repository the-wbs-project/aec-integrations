/**
 * Integration ownership: the rules the claim route, the contest router, promote and
 * the notification feed share (AECI-1005 / ADR 0035 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5).
 *
 * The vocabulary, because two older words look similar and mean something else:
 *
 *   - **owner** — the vendor in `integrations.built_by_vendor_id`. AECI-1003 ruled
 *     that the column means "the vendor that offers the integration", not "the firm
 *     that wrote the code". There is no `owner_vendor_id` (decision 12).
 *   - **claimed** — `claimed_at IS NOT NULL`. The owner took the row by an act: its
 *     own claim, or an admin approval of an owner-unknown claim. This, and only this,
 *     fences promote (decision 13).
 *   - **`maintained_by`** — the two-value display marker. It flips to `'vendor'`
 *     when EITHER endpoint vendor attests, so it means "a vendor touched this", not
 *     "a vendor owns this". A claim sets it too (§13.9), so the chip reads right,
 *     but nothing decides ownership from it.
 *   - **vendor-held** — claimed, OR created by a vendor (`origin = 'vendor'`). The ops
 *     tools use this wider test, because a vendor-created row has no upstream record
 *     and every orphan detector would otherwise call it stranded.
 */

import { orderedPairSlugs } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { integrations } from '../db/schema';
import { NOTIFICATION_SENT_ACTION } from './attestation-notify';

type IntegrationRow = typeof integrations.$inferSelect;

/**
 * A one-row FROM source for the batch sentinels here and in
 * `lib/integration-contests.ts`. A sentinel must evaluate its CASE exactly once
 * whatever state the guarded row is in, including when that row is gone, which a
 * `FROM <table> WHERE id = ?` source cannot promise (AECI-1005 review).
 */
export const ONE_ROW = sql`(SELECT 1)`;

/** `audit_log.action` for a claim, and for the owner-unknown approval that has
 *  the same effect. */
export const INTEGRATION_CLAIMED_ACTION = 'integration.claimed';

/** `metadata.kind` on the `notification.sent` row a claim writes. */
export const CLAIM_NOTIFICATION_KIND = 'integration_claim';

/** Has the owner taken this row? The single definition. */
export function isClaimed(row: Pick<IntegrationRow, 'claimedAt'>): boolean {
  return row.claimedAt !== null && row.claimedAt !== undefined;
}

/**
 * Is this row owned by a vendor rather than seeded by AECi? Claimed, or
 * vendor-created. The strand audit, the datatool prune and the retraction
 * consumer carry their own copy of this test in plain JS
 * (`scripts/ops/2026-09-retraction-consumer/vendor-held.mjs`), because
 * `scripts/ops/**` cannot import TypeScript. `vendor-held.spec.ts` pins the two.
 */
export function isVendorHeld(row: Pick<IntegrationRow, 'claimedAt' | 'origin'>): boolean {
  return isClaimed(row) || row.origin === 'vendor';
}

/**
 * The §13.9 maintenance-transfer columns plus the claim stamp: everything a claim
 * writes to the row, and nothing else.
 */
export function claimColumns(now: string): {
  claimedAt: string;
  maintainedBy: 'vendor';
  lastReviewedAt: string;
} {
  return { claimedAt: now, maintainedBy: 'vendor', lastReviewedAt: now };
}

/**
 * A batch statement that ABORTS the batch when the statement before it changed zero
 * rows. Push it immediately after the claim's guarded
 * `UPDATE … WHERE claimed_at IS NULL`.
 *
 * Same mechanism as `contestStillOpenSentinel` (`lib/integration-contests.ts`), and
 * for the same reason: D1 has no interactive transactions, so a batch cannot branch
 * on whether its guarded UPDATE matched. Without it the loser of two racing claims
 * would still commit its audit row and a notification saying it claimed a row it
 * did not. `json('integration-already-claimed')` is malformed JSON, so it raises and
 * rolls the whole batch back. {@link isClaimRaceError} recognises it.
 */
export function claimRaceSentinel(db: Db, _integrationId: string) {
  // FROM a one-row constant, not from the integration (AECI-1005 review): if the row
  // was deleted between the read and the batch, `FROM integrations WHERE id = ?`
  // returns nothing, the guard never runs, and the audit and notification rows
  // commit for a claim that wrote nothing.
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json('integration-already-claimed') END` })
    .from(ONE_ROW);
}

/**
 * A batch statement that ABORTS a promote whose plan saw this integration unclaimed,
 * if it has been claimed since (AECI-1005's race half of the promote fence).
 *
 * The plan and the commit are not atomic with each other. The plan-time skip in
 * `routes/promote.ts` handles every row that was claimed before the promote started;
 * this handles the one that is claimed while it runs. It selects FROM the row it
 * guards, so it evaluates once per guarded row and costs one indexed lookup. A
 * claimed row makes it raise, the whole promote batch rolls back, and the job
 * errors with `INTEGRATION_CLAIMED_DURING_PROMOTE`. Re-pushing then plans against
 * the claimed row, skips it, and commits the rest.
 *
 * Why abort rather than guard each column: a promote writes more than the row. It
 * writes the row's claims and attestations, an endpoint-move record, and on a
 * cross-table move it DELETES the row. A `CASE` per column would protect the columns
 * and nothing else. One sentinel protects all of it.
 */
export function promoteClaimFenceSentinel(db: Db, integrationId: string) {
  return db
    .select({
      guard: sql`CASE WHEN ${integrations.claimedAt} IS NOT NULL THEN json('integration-claimed-during-promote') END`,
    })
    .from(integrations)
    .where(eq(integrations.id, integrationId));
}

function raisedMalformedJson(error: unknown, token: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/malformed JSON/i.test(text)) return true;
    if (text.includes(token)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** True for the error {@link claimRaceSentinel} raises, in D1 or SQLite. Nothing else
 *  in a claim batch calls `json()`, so the match is unambiguous. */
export function isClaimRaceError(error: unknown): boolean {
  return raisedMalformedJson(error, 'integration-already-claimed');
}

/** True for the error {@link promoteClaimFenceSentinel} raises. A promote batch
 *  calls `json()` nowhere else, so the match is unambiguous there too. */
export function isPromoteClaimFenceError(error: unknown): boolean {
  return raisedMalformedJson(error, 'integration-claimed-during-promote');
}

/** What a claim `notification.sent` row records. `vendorId` is the RECIPIENT, which
 *  is what the feed's `json_extract(metadata, '$.vendorId')` filter matches. */
export interface ClaimNotificationMetadata {
  kind: typeof CLAIM_NOTIFICATION_KIND;
  vendorId: string;
  integrationId: string;
  integrationName: string | null;
  ownerVendorId: string;
  ownerName: string | null;
  pairSlugs: readonly [string, string] | null;
}

/**
 * The `notification.sent` row telling one endpoint vendor that the owner claimed an
 * integration on its product. Pushed into the SAME batch as the claim, so a
 * rolled-back claim cannot leave a notification behind. `entity_type` is
 * `integration` and `entity_id` the integration, which keeps it apart from the §7
 * detector rows (entity: a claim) and the contest rows (entity: a contest).
 */
export function claimNotificationAudit(
  actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] },
  metadata: Omit<ClaimNotificationMetadata, 'kind'>,
): AuditLogEntry {
  const full: ClaimNotificationMetadata = {
    kind: CLAIM_NOTIFICATION_KIND,
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

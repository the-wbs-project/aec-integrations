/**
 * The lifecycle of a private row thread outside its own routes (AECI-1536,
 * `STAGE_2_ATTESTATIONS_SPEC.md` §15.5 and §15.10).
 *
 * The thread routes (AECI-1535) create threads and write messages. Everything here
 * is what OTHER writes do to a thread:
 *
 * - **Promote deletes a claim with a thread as before, and detaches the thread**
 *   (§15.5). {@link planClaimRemovedThreadCloses} NULLs `claim_id`, writes the
 *   anchor snapshot and closes an open thread `claim_removed`, in the delete's batch.
 * - **A thread closes read-only and never reopens** (§15.10). Retire closes it
 *   `retired`, a withdrawn added row closes it `withdrawn`, and a promote move that
 *   makes the edge connector-powered closes it `not_attestable`.
 *   {@link threadCloseStatements} writes the guarded UPDATE and the `thread.closed`
 *   audit row (§15.7) for each. `retract-product.ts` closes `claim_removed` in raw
 *   SQL, because that lane is pure SQL text.
 * - **The 2-year retention sweep** (§15.10). {@link runThreadRetentionSweep} deletes
 *   a thread 2 years after its newest message, deleted messages included, in bounded
 *   pages. Its messages and read markers cascade. One `thread.retention_deleted`
 *   summary row per page, in that page's batch.
 *
 * - **Every close tells both companies** (AECI-1548, §15.8).
 *   {@link threadClosedNoticeStatements} writes one `portal-thread-closed` row per
 *   company in the close's batch. The notice links the thread by id, which is how a
 *   vendor reaches a thread whose row is gone (`GET /api/vendor/threads/:threadId`).
 *
 * No audit row carries message text (§15.7).
 */

import type { ThreadClosedReason } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import type { Db } from '../db/client';
import { auditLog, claimThreads, claims, taxonomyDataObjects, vendors } from '../db/schema';
import { NOTIFICATION_SENT_ACTION } from './attestation-notify';
import { auditInsert, auditInsertWhere, type BatchStmt, type BatchTuple } from './audit';
import { ONE_ROW } from './integration-claims';
import type { PortalNotificationId } from './notifications/registry';
import { chunked } from './promote-claims';
import { THREAD_CLOSED_NOTIFICATION_KIND, THREAD_ENTITY_TYPE } from './thread-notification';

export { THREAD_ENTITY_TYPE };

// ─── The close notice (AECI-1548) ───────────────────────────────────────────

/** The registry id of the close notice (`notifications/registry.ts`). */
export const THREAD_CLOSED_NOTIFICATION_ID = 'portal-thread-closed' satisfies PortalNotificationId;

const noticeOtherVendor = alias(vendors, 'notice_other_vendor');

/**
 * The `portal-thread-closed` rows for one thread (AECI-1548, §15.8): one
 * `notification.sent` row per company on the thread, so both companies' seats see
 * the close and can open the thread by id after its row is gone. Ruled 2026-10-30:
 * a vendor keeps read access to a detached thread, and this notice is the way back.
 *
 * Each row is an `INSERT … SELECT … FROM claim_threads`, so the recipients are the
 * two STAMPED companies (§15.3) and the names are read at commit time, with no read
 * before the batch. The data object is the live claim's, else the one in
 * `anchor_snapshot`, so a row placed after a `claim_removed` detach still names it.
 * `claimId` is bound from the caller, because the detach has nulled the column.
 *
 * `onlyIfOpen` adds `closed_at IS NULL` to the WHERE. The `'skip'` close puts the
 * rows BEFORE its guarded UPDATE with that guard, so a lost race writes no notice.
 * Every other close puts them after the close, where a race already aborted the batch.
 *
 * No row carries message text (§15.7). Not forwarded post-commit: the forward of the
 * close's own `thread.closed` row already records the event.
 */
export function threadClosedNoticeStatements(
  db: Db,
  args: {
    threadId: string;
    claimId: string | null;
    reason: ThreadClosedReason;
    now: string;
    actor: Pick<AuditLogEntry, 'actorId' | 'actorType'>;
    onlyIfOpen?: boolean;
    notification: Extract<PortalNotificationId, 'portal-thread-closed'>;
  },
): BatchStmt[] {
  const row = {
    action: NOTIFICATION_SENT_ACTION,
    notificationId: args.notification,
  };
  const dataObjectKey = sql`coalesce(${claims.dataObjectId}, json_extract(${claimThreads.anchorSnapshot}, '$.dataObjectId'))`;
  const where: SQL = args.onlyIfOpen
    ? and(eq(claimThreads.id, args.threadId), isNull(claimThreads.closedAt))!
    : eq(claimThreads.id, args.threadId);
  const sides = [
    { recipient: claimThreads.vendorAId, other: claimThreads.vendorBId },
    { recipient: claimThreads.vendorBId, other: claimThreads.vendorAId },
  ];
  const val = (v: string | null) => sql`${v}`;
  return sides.map(({ recipient, other }) => {
    const metadata = sql`json_object(
      'kind', ${THREAD_CLOSED_NOTIFICATION_KIND},
      'notificationId', ${row.notificationId},
      'vendorId', ${recipient},
      'otherVendorId', ${other},
      'otherVendorName', ${noticeOtherVendor.companyName},
      'threadId', ${claimThreads.id},
      'claimId', ${args.claimId},
      'closedReason', ${args.reason},
      'dataObject', json(CASE WHEN ${taxonomyDataObjects.id} IS NULL THEN NULL
        ELSE json_object('slug', ${taxonomyDataObjects.slug}, 'name', ${taxonomyDataObjects.name}) END)
    )`;
    return db.insert(auditLog).select(
      db
        .select({
          id: val(crypto.randomUUID()).as('id'),
          actorId: val(args.actor.actorId ?? null).as('actor_id'),
          actorType: val(args.actor.actorType).as('actor_type'),
          action: val(row.action).as('action'),
          entityType: val(THREAD_ENTITY_TYPE).as('entity_type'),
          entityId: sql`${claimThreads.id}`.as('entity_id'),
          beforeState: sql`NULL`.as('before_state'),
          afterState: sql`NULL`.as('after_state'),
          metadata: metadata.as('metadata'),
          // AECI-1192: `notification.sent` carries the RECIPIENT in `vendor_id`.
          vendorId: sql`${recipient}`.as('vendor_id'),
          productId: sql`NULL`.as('product_id'),
          vendorTier: sql`NULL`.as('vendor_tier'),
          vendorEntitlementStatus: sql`NULL`.as('vendor_entitlement_status'),
          productTier: sql`NULL`.as('product_tier'),
          productEntitlementStatus: sql`NULL`.as('product_entitlement_status'),
          createdAt: val(args.now).as('created_at'),
        })
        .from(claimThreads)
        .leftJoin(noticeOtherVendor, eq(noticeOtherVendor.id, other))
        .leftJoin(claims, eq(claims.id, claimThreads.claimId))
        .leftJoin(taxonomyDataObjects, eq(taxonomyDataObjects.id, dataObjectKey))
        .where(where),
    );
  });
}

/** `audit_log.action` for a close (§15.7). */
export const THREAD_CLOSED_ACTION = 'thread.closed';

/** `audit_log.action` for one page of the retention sweep (§15.7). */
export const THREAD_RETENTION_DELETED_ACTION = 'thread.retention_deleted';

// ─── Promote's claim deletes: detach and close ──────────────────────────────

/** A thread on a claim a promote is about to delete, as the plan read it. */
export interface ClaimThreadRow {
  id: string;
  claimId: string;
  closedAt: string | null;
}

/** The statement {@link loadThreadsOnClaims} runs per chunk. Exported so the
 *  connector-catalog arm can put it in its batched pre-read. */
export function threadsOnClaimsQuery(db: Db, claimIds: readonly string[]) {
  return db
    .select({ id: claimThreads.id, claimId: claimThreads.claimId, closedAt: claimThreads.closedAt })
    .from(claimThreads)
    .where(inArray(claimThreads.claimId, [...claimIds]));
}

/** Every thread, open or closed, on these claims. Chunked at `ID_CHUNK`. */
export async function loadThreadsOnClaims(
  db: Db,
  claimIds: readonly string[],
): Promise<ClaimThreadRow[]> {
  const out: ClaimThreadRow[] = [];
  for (const chunk of chunked([...new Set(claimIds)])) {
    for (const row of await threadsOnClaimsQuery(db, chunk)) {
      if (row.claimId) out.push({ id: row.id, claimId: row.claimId, closedAt: row.closedAt });
    }
  }
  return out;
}

/** The token {@link planClaimRemovedThreadCloses} raises when the threads on a claim
 *  changed between the plan read and the batch. */
const THREAD_DETACH_RACE_TOKEN = 'thread-changed-during-promote';

/** What a failed promote batch re-reads to tell a thread race from its other sentinels. */
export interface PlannedThreadDetach {
  claimIds: string[];
  fingerprint: string;
}

const detachFingerprint = (threads: readonly ClaimThreadRow[]) =>
  threads
    .map((t) => `${t.id}:${t.closedAt === null ? 'open' : 'closed'}`)
    .sort()
    .join('|');

/**
 * Promote deletes a claim that has threads (§15.5, ruled 2026-10-29): a private
 * conversation never keeps a claim on the public page that AECi dropped. In the same
 * batch, BEFORE the claim DELETE, every thread on the claim is detached the way
 * `retract-product.ts` does it: `claim_id` NULLed, `anchor_snapshot` written (the
 * claim's anchor id and data object), and an open thread closed `claim_removed`. A
 * closed thread keeps its reason. The messages stay. One `thread.closed` entry per
 * open thread is returned for the caller to insert in the same batch.
 *
 * `closedInBatch` names threads an earlier statement of the SAME batch already closes
 * (a promote move's `not_attestable` close). They are treated as closed here.
 *
 * Race guard, first, also on a claim with no thread: a sentinel that aborts the batch unless the claim still carries
 * exactly the threads the plan read, with the same ones open. Without it a thread
 * opened in between would close with no audit row, and one closed in between would
 * get a second close row. The token is `THREAD_CHANGED_DURING_PROMOTE`'s.
 */
export function planClaimRemovedThreadCloses(
  db: Db,
  args: {
    claim: { id: string; anchorId: string; dataObjectId: string };
    threads: readonly ClaimThreadRow[];
    now: string;
    actor: Pick<AuditLogEntry, 'actorId' | 'actorType'>;
    metadata: Record<string, unknown>;
    closedInBatch?: ReadonlySet<string>;
  },
): { stmts: BatchStmt[]; audits: AuditLogEntry[]; planned: PlannedThreadDetach } {
  const threads = args.threads
    .filter((t) => t.claimId === args.claim.id)
    .map((t) =>
      t.closedAt === null && args.closedInBatch?.has(t.id) ? { ...t, closedAt: args.now } : t,
    );
  const open = threads.filter((t) => t.closedAt === null).map((t) => t.id);
  const claimId = args.claim.id;
  const openNow = sql`(SELECT count(*) FROM "claim_threads" t WHERE t."claim_id" = ${claimId} AND t."closed_at" IS NULL)`;
  const openPlanned = open.length
    ? sql`(SELECT count(*) FROM "claim_threads" t WHERE t."claim_id" = ${claimId} AND t."closed_at" IS NULL AND t."id" IN (${sql.join(
        open.map((id) => sql`${id}`),
        sql`, `,
      )}))`
    : sql`0`;
  const guard = db
    .select({
      guard: sql`CASE WHEN (SELECT count(*) FROM "claim_threads" t WHERE t."claim_id" = ${claimId}) <> ${threads.length}
        OR ${openNow} <> ${open.length} OR ${openPlanned} <> ${open.length}
        THEN json(${THREAD_DETACH_RACE_TOKEN}) END`,
    })
    .from(ONE_ROW);
  const snapshot = JSON.stringify({
    anchorId: args.claim.anchorId,
    dataObjectId: args.claim.dataObjectId,
  });
  const detach = db
    .update(claimThreads)
    .set({
      claimId: null,
      anchorSnapshot: sql`coalesce("anchor_snapshot", ${snapshot})`,
      closedAt: sql`coalesce("closed_at", ${args.now})`,
      closedReason: sql`coalesce("closed_reason", 'claim_removed')`,
    })
    .where(eq(claimThreads.claimId, claimId));
  const audits: AuditLogEntry[] = open.map((id) => ({
    ...args.actor,
    action: THREAD_CLOSED_ACTION,
    entityType: THREAD_ENTITY_TYPE,
    entityId: id,
    afterState: { closedAt: args.now, closedReason: 'claim_removed' },
    metadata: { ...args.metadata, claimId, closedReason: 'claim_removed' },
  }));
  const planned = {
    claimIds: [claimId],
    fingerprint: detachFingerprint(args.threads.filter((t) => t.claimId === claimId)),
  };
  // A claim with no thread still gets the guard, so a thread opened on it between the
  // read and the batch cannot be detached by the FK's SET NULL with no close and no row.
  if (threads.length === 0) return { stmts: [guard], audits: [], planned };
  // AECI-1548: both companies hear of each close, after the detach, so the notice
  // reads the data object from the snapshot the detach just wrote.
  const notices = open.flatMap((threadId) =>
    threadClosedNoticeStatements(db, {
      notification: THREAD_CLOSED_NOTIFICATION_ID,
      threadId,
      claimId,
      reason: 'claim_removed',
      now: args.now,
      actor: args.actor,
    }),
  );
  return { stmts: [guard, detach, ...notices], audits, planned };
}

/** A fresh v4 uuid per row, in SQL, for the set-based INSERT … SELECTs: a bound
 *  `randomUUID()` would repeat across the rows of one statement. */
const SQL_UUID = sql`lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))`;

/** The SQL fragment both claim-delete detach lanes write into `anchor_snapshot`: the
 *  claim's anchor id and data object, read off the claim while it still exists. The
 *  same JSON {@link planClaimRemovedThreadCloses} stringifies. Correlated on the
 *  unaliased `claim_threads`. */
const ANCHOR_SNAPSHOT_FROM_CLAIM = sql`(SELECT json_object('anchorId', c."anchor_id", 'dataObjectId', c."data_object_id") FROM "claims" c WHERE c."id" = "claim_threads"."claim_id")`;

/**
 * The set-based twin of {@link planClaimRemovedThreadCloses}, for a delete that does not
 * plan its claims one by one (AECI-1542, §15.5). `claimIds` is a subquery naming the
 * claims the SAME batch is about to delete, scoped exactly as that DELETE is. It runs
 * at batch time on whatever threads are there, so it needs no race guard, as
 * `retract-product.ts`'s raw-SQL lane does not. Place the statements before the
 * DELETE that removes the claims, by id or by cascade from their anchor row.
 *
 * 1. One `thread.closed` row per thread still open on those claims (§15.7), as an
 *    `INSERT … SELECT`, before the UPDATE closes it.
 * 2. One `portal-thread-closed` notice per company per such thread (AECI-1548, §15.8),
 *    the rows {@link threadClosedNoticeStatements} writes, also before the UPDATE.
 * 3. The detach: `claim_id` NULLed, `anchor_snapshot` written from the claim, and an
 *    open thread closed `claim_removed`. A closed thread keeps its reason.
 *
 * The audit rows are minted in SQL, so the caller's post-commit forward does not carry
 * them. The forward is best-effort (`lib/audit.ts`). The row in `audit_log` is the
 * transactional obligation, and it lands in the batch.
 */
export function claimRemovedThreadDetachWhere(
  db: Db,
  args: {
    claimIds: SQL;
    now: string;
    /** `metadata` on every `thread.closed` row. `claimId` and `closedReason` are added. */
    metadata: Record<string, unknown>;
  },
): BatchStmt[] {
  const inScope = sql`${claimThreads.claimId} IN (${args.claimIds})`;
  const metadata = sql`json_set(${JSON.stringify(args.metadata)}, '$.claimId', ${claimThreads.claimId}, '$.closedReason', 'claim_removed')`;
  const val = (v: string | null) => sql`${v}`;
  const audit = db.insert(auditLog).select(
    db
      .select({
        id: SQL_UUID.as('id'),
        actorId: val(null).as('actor_id'),
        actorType: val('system').as('actor_type'),
        action: val(THREAD_CLOSED_ACTION).as('action'),
        entityType: val(THREAD_ENTITY_TYPE).as('entity_type'),
        entityId: sql`${claimThreads.id}`.as('entity_id'),
        beforeState: val(null).as('before_state'),
        afterState: val(JSON.stringify({ closedAt: args.now, closedReason: 'claim_removed' })).as(
          'after_state',
        ),
        metadata: metadata.as('metadata'),
        vendorId: val(null).as('vendor_id'),
        productId: val(null).as('product_id'),
        vendorTier: val(null).as('vendor_tier'),
        vendorEntitlementStatus: val(null).as('vendor_entitlement_status'),
        productTier: val(null).as('product_tier'),
        productEntitlementStatus: val(null).as('product_entitlement_status'),
        createdAt: val(args.now).as('created_at'),
      })
      .from(claimThreads)
      .where(and(inScope, isNull(claimThreads.closedAt))),
  );
  const detach = db
    .update(claimThreads)
    .set({
      claimId: null,
      anchorSnapshot: sql`coalesce("anchor_snapshot", ${ANCHOR_SNAPSHOT_FROM_CLAIM})`,
      closedAt: sql`coalesce("closed_at", ${args.now})`,
      closedReason: sql`coalesce("closed_reason", 'claim_removed')`,
    })
    .where(inScope);
  return [
    audit,
    ...claimRemovedNoticesWhere(db, inScope, args.now, THREAD_CLOSED_NOTIFICATION_ID),
    detach,
  ];
}

/**
 * The set-based `portal-thread-closed` notices for {@link claimRemovedThreadDetachWhere}
 * (AECI-1548, §15.8): one `notification.sent` row per company per thread still OPEN on
 * the scoped claims, the same rows {@link threadClosedNoticeStatements} writes for one
 * thread. Placed BEFORE the detach, so `closed_at IS NULL` picks the threads this
 * batch closes and the claim still names the data object. `claimId` is the live
 * column, which the detach nulls next.
 */
function claimRemovedNoticesWhere(
  db: Db,
  inScope: SQL,
  now: string,
  notification: Extract<PortalNotificationId, 'portal-thread-closed'>,
): BatchStmt[] {
  const sides = [
    { recipient: claimThreads.vendorAId, other: claimThreads.vendorBId },
    { recipient: claimThreads.vendorBId, other: claimThreads.vendorAId },
  ];
  const row = {
    action: NOTIFICATION_SENT_ACTION,
    notificationId: notification,
  };
  const val = (v: string | null) => sql`${v}`;
  return sides.map(({ recipient, other }) => {
    const metadata = sql`json_object(
      'kind', ${THREAD_CLOSED_NOTIFICATION_KIND},
      'notificationId', ${row.notificationId},
      'vendorId', ${recipient},
      'otherVendorId', ${other},
      'otherVendorName', ${noticeOtherVendor.companyName},
      'threadId', ${claimThreads.id},
      'claimId', ${claimThreads.claimId},
      'closedReason', 'claim_removed',
      'dataObject', json(CASE WHEN ${taxonomyDataObjects.id} IS NULL THEN NULL
        ELSE json_object('slug', ${taxonomyDataObjects.slug}, 'name', ${taxonomyDataObjects.name}) END)
    )`;
    return db.insert(auditLog).select(
      db
        .select({
          id: SQL_UUID.as('id'),
          actorId: val(null).as('actor_id'),
          actorType: val('system').as('actor_type'),
          action: val(row.action).as('action'),
          entityType: val(THREAD_ENTITY_TYPE).as('entity_type'),
          entityId: sql`${claimThreads.id}`.as('entity_id'),
          beforeState: sql`NULL`.as('before_state'),
          afterState: sql`NULL`.as('after_state'),
          metadata: metadata.as('metadata'),
          // AECI-1192: `notification.sent` carries the RECIPIENT in `vendor_id`.
          vendorId: sql`${recipient}`.as('vendor_id'),
          productId: sql`NULL`.as('product_id'),
          vendorTier: sql`NULL`.as('vendor_tier'),
          vendorEntitlementStatus: sql`NULL`.as('vendor_entitlement_status'),
          productTier: sql`NULL`.as('product_tier'),
          productEntitlementStatus: sql`NULL`.as('product_entitlement_status'),
          createdAt: val(now).as('created_at'),
        })
        .from(claimThreads)
        .leftJoin(noticeOtherVendor, eq(noticeOtherVendor.id, other))
        .leftJoin(claims, eq(claims.id, claimThreads.claimId))
        .leftJoin(taxonomyDataObjects, eq(taxonomyDataObjects.id, claims.dataObjectId))
        .where(and(inScope, isNull(claimThreads.closedAt))),
    );
  });
}

/** True when the threads on a planned detach no longer match the plan read. Called only
 *  after a promote batch failed, which rolled back, so the re-read sees the live set. */
export async function anyThreadDetachRaced(
  db: Db,
  planned: readonly PlannedThreadDetach[],
): Promise<boolean> {
  if (planned.length === 0) return false;
  // One chunked read for every planned claim, compared claim by claim.
  const live = await loadThreadsOnClaims(
    db,
    planned.flatMap((entry) => entry.claimIds),
  );
  return planned.some((entry) => {
    const ids = new Set(entry.claimIds);
    return detachFingerprint(live.filter((t) => ids.has(t.claimId))) !== entry.fingerprint;
  });
}

// ─── Closes ─────────────────────────────────────────────────────────────────

/** An open thread a write is about to close. */
export interface OpenThread {
  id: string;
  claimId: string | null;
}

/** The open threads on every claim of one mechanism row, either table (`claims.anchor_id`
 *  is the generated `coalesce(integration_id, connector_evidenced_pair_id)`). Oldest
 *  first, so audit order is stable. */
export function openThreadsOnAnchor(db: Db, anchorId: string): Promise<OpenThread[]> {
  return db
    .select({ id: claimThreads.id, claimId: claimThreads.claimId })
    .from(claimThreads)
    .innerJoin(claims, eq(claims.id, claimThreads.claimId))
    .where(and(eq(claims.anchorId, anchorId), isNull(claimThreads.closedAt)))
    .orderBy(asc(claimThreads.createdAt), asc(claimThreads.id));
}

/** The open thread on one claim, if any. There is at most one (`claim_threads_claim_key`). */
export async function openThreadOnClaim(db: Db, claimId: string): Promise<OpenThread | null> {
  const [row] = await db
    .select({ id: claimThreads.id, claimId: claimThreads.claimId })
    .from(claimThreads)
    .where(and(eq(claimThreads.claimId, claimId), isNull(claimThreads.closedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * A batch statement that ABORTS the batch when the statement before it changed zero
 * rows. `json(token)` on a non-JSON string is malformed JSON, so it raises and rolls
 * the batch back. FROM a one-row constant, so it evaluates even when the thread is gone.
 */
function threadStillOpenSentinel(db: Db, token: string) {
  return db.select({ guard: sql`CASE WHEN changes() = 0 THEN json(${token}) END` }).from(ONE_ROW);
}

/**
 * A batch statement that ABORTS the batch when any thread on the anchor's claims is
 * still open after the batch's own closes ran. The caller read the open threads before
 * the batch; a thread created in between would otherwise stay open on a retired or
 * moved row. The contest twin is `noOpenContestsSentinel`.
 */
export function noOpenThreadsOnAnchorSentinel(db: Db, anchorId: string, token: string) {
  return db
    .select({
      // Raw, aliased SQL: the subquery joins two tables that both have an `id`.
      guard: sql`CASE WHEN EXISTS (
        SELECT 1 FROM "claim_threads" t JOIN "claims" c ON c."id" = t."claim_id"
        WHERE c."anchor_id" = ${anchorId} AND t."closed_at" IS NULL
      ) THEN json(${token}) END`,
    })
    .from(ONE_ROW);
}

export interface ThreadCloseInput {
  threads: readonly OpenThread[];
  reason: Exclude<ThreadClosedReason, 'claim_removed'>;
  now: string;
  actor: Pick<AuditLogEntry, 'actorId' | 'actorType'>;
  /** `metadata` on every `thread.closed` row. `claimId` and `closedReason` are added. */
  metadata: Record<string, unknown>;
  /** The `vendor_id` and plan stamp the write's other rows carry (AECI-1192). */
  stamp?: Pick<AuditLogEntry, 'vendorId' | 'vendorPlan' | 'productPlan'>;
  /**
   * How a lost race is handled.
   * - `{ abort: token }`: the guarded UPDATE is followed by a `changes() = 0` sentinel
   *   raising `token`, so a thread that closed between the read and the batch rolls
   *   the whole write back. Retire and the promote move, which have a 409 for it.
   * - `'skip'`: the audit row is an `INSERT … SELECT` that lands only while the
   *   thread is still open, then the guarded UPDATE. A lost race writes neither, and
   *   the rest of the batch commits. The withdrawn added row, where a thread race
   *   must not fail a vendor's answer.
   */
  onRace: { abort: string } | 'skip';
  /** `false` when the caller inserts the returned entries itself (promote's collector).
   *  Only with `onRace: { abort }`; the `'skip'` form's insert IS its guard. */
  insertAudits?: boolean;
}

/**
 * The `thread.closed` writes for each thread (§15.10, §15.7): a guarded UPDATE of
 * `closed_at` and `closed_reason` (`WHERE closed_at IS NULL`, so a closed thread
 * never changes reason and never reopens), and its audit row with after-state
 * `{ closedAt, closedReason }`. Returns the entries for the caller's post-commit
 * forward.
 */
export function threadCloseStatements(
  db: Db,
  input: ThreadCloseInput,
): { stmts: BatchStmt[]; audits: AuditLogEntry[] } {
  const stmts: BatchStmt[] = [];
  const audits: AuditLogEntry[] = [];
  for (const thread of input.threads) {
    const entry: AuditLogEntry = {
      ...input.actor,
      action: THREAD_CLOSED_ACTION,
      entityType: THREAD_ENTITY_TYPE,
      entityId: thread.id,
      ...(input.stamp ?? {}),
      afterState: { closedAt: input.now, closedReason: input.reason },
      metadata: { ...input.metadata, claimId: thread.claimId, closedReason: input.reason },
    };
    const stillOpen = and(eq(claimThreads.id, thread.id), isNull(claimThreads.closedAt));
    const update = db
      .update(claimThreads)
      .set({ closedAt: input.now, closedReason: input.reason })
      .where(stillOpen);
    // AECI-1548: one close notice per company, in this batch (§15.8).
    const notices = (onlyIfOpen: boolean) =>
      threadClosedNoticeStatements(db, {
        notification: THREAD_CLOSED_NOTIFICATION_ID,
        threadId: thread.id,
        claimId: thread.claimId,
        reason: input.reason,
        now: input.now,
        actor: input.actor,
        onlyIfOpen,
      });
    if (input.onRace === 'skip') {
      // The audit row and the notices first: they read the thread as still open,
      // before the UPDATE.
      stmts.push(
        auditInsertWhere(db, entry, { from: claimThreads, where: stillOpen }),
        ...notices(true),
        update,
      );
    } else {
      stmts.push(update, threadStillOpenSentinel(db, input.onRace.abort));
      if (input.insertAudits !== false) stmts.push(auditInsert(db, entry));
      // After the sentinel, which already aborted the batch on a lost race.
      stmts.push(...notices(false));
    }
    audits.push(entry);
  }
  return { stmts, audits };
}

// ─── The promote cross-table move ───────────────────────────────────────────

/** The token the move's thread sentinels raise. */
const THREAD_MOVE_RACE_TOKEN = THREAD_DETACH_RACE_TOKEN;

/** What a failed promote batch re-reads to tell a thread race from its other sentinels. */
export interface PlannedThreadMove {
  anchorId: string;
  fingerprint: string;
}

const fingerprintOf = (threads: readonly OpenThread[]) =>
  threads
    .map((t) => t.id)
    .sort()
    .join('|');

/**
 * A promote move into `connector_evidenced_pairs` makes the edge connector-powered, so
 * no company may attest to it and its threads close `not_attestable` (§15.2, §15.10), as
 * AECI-1110 withdraws a `mechanism_kind` contest. The claims keep their id and are
 * re-homed, so `claim_id` stays and nothing is re-anchored. The same guards as the
 * contest move: a `changes() = 0` sentinel per close and a last sentinel that aborts if
 * any thread on the anchor is still open, so a thread opened or closed between the plan
 * read and the batch rolls the promote back with `THREAD_CHANGED_DURING_PROMOTE`.
 * The audit entries go into promote's collector, which inserts them in the same batch.
 */
export function planThreadMoveCloses(
  db: Db,
  args: { threads: readonly OpenThread[]; anchorId: string; now: string },
): { stmts: BatchStmt[]; audits: AuditLogEntry[]; planned: PlannedThreadMove } {
  const closes = threadCloseStatements(db, {
    threads: args.threads,
    reason: 'not_attestable',
    now: args.now,
    actor: { actorId: null, actorType: 'system' },
    metadata: {
      integrationId: args.anchorId,
      fromAnchor: 'integration',
      toAnchor: 'evidenced_pair',
    },
    onRace: { abort: THREAD_MOVE_RACE_TOKEN },
    // Promote's collector inserts its entries at the end of the same batch.
    insertAudits: false,
  });
  const stmts = [...closes.stmts];
  stmts.push(noOpenThreadsOnAnchorSentinel(db, args.anchorId, THREAD_MOVE_RACE_TOKEN));
  return {
    stmts,
    audits: closes.audits,
    planned: { anchorId: args.anchorId, fingerprint: fingerprintOf(args.threads) },
  };
}

/** True when a planned move's open threads no longer match the plan read. Called only
 *  after a promote batch failed, which rolled back, so the re-read sees the live set. */
export async function anyThreadMoveRaced(
  db: Db,
  planned: readonly PlannedThreadMove[],
): Promise<boolean> {
  for (const move of planned) {
    if (fingerprintOf(await openThreadsOnAnchor(db, move.anchorId)) !== move.fingerprint) {
      return true;
    }
  }
  return false;
}

// ─── The 2-year retention sweep ─────────────────────────────────────────────

/** Calendar years a thread is kept after its newest message (§15.10). */
export const THREAD_RETENTION_YEARS = 2;

/** Threads per page. Below D1's bound-parameter cap, since the page binds its ids. */
export const THREAD_RETENTION_PAGE_SIZE = 50;

/** Pages per run, so a backlog is spread over several days (at most 1,000 a day). */
export const THREAD_RETENTION_MAX_PAGES = 20;

/** `metadata.source` on the sweep's audit rows. */
export const THREAD_RETENTION_SOURCE = 'thread-retention-sweep';

/** The token the page sentinel raises when the page's DELETE removed fewer threads
 *  than it read, because a message landed on one in between. */
const RETENTION_RACE_TOKEN = 'thread-retention-race';

/** The cutoff instant: `now` minus {@link THREAD_RETENTION_YEARS} calendar years. */
export function threadRetentionCutoff(now: Date): string {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - THREAD_RETENTION_YEARS);
  return cutoff.toISOString();
}

/**
 * A thread's last activity: the newest `created_at` over ALL its messages, soft-deleted
 * ones included, so a delete does not restart the clock (§15.10). A thread with no
 * message at all cannot exist (it is created by the first one); `created_at` is the
 * fallback so such a row still ages out. Correlated on the unaliased `claim_threads`.
 */
const lastActivity = sql`coalesce((SELECT max(m."created_at") FROM "claim_thread_messages" m WHERE m."thread_id" = "claim_threads"."id"), "claim_threads"."created_at")`;

export interface ThreadRetentionResult {
  /** Threads deleted, across every committed page. */
  deleted: number;
  /** Pages committed. Each wrote one summary audit row. */
  pages: number;
  /** True when the run stopped at {@link THREAD_RETENTION_MAX_PAGES} with more due.
   *  The next day continues. */
  truncated: boolean;
  /** True when a page lost a race to a new message and rolled back. The run stops
   *  there; the next day re-reads. */
  raced: boolean;
  cutoff: string;
  /** The committed pages' audit entries, for the caller's post-commit forward. */
  auditEntries: AuditLogEntry[];
}

/**
 * Delete every thread whose last activity is older than the cutoff, in pages
 * (§15.10). Open or closed alike: retire, row removal and erasure do not shorten the
 * period, and nothing lengthens it but a new message.
 *
 * Each page is one batch: the guarded DELETE (`id IN (page)` AND the age predicate,
 * which is authoritative), a sentinel that rolls the page back if the DELETE removed
 * fewer rows than the page read, and one `thread.retention_deleted` row with
 * `{ count, threadIds }`. Scheduled deletes are never exempt from audit (ADR 0022).
 * The DELETE cascades the messages and read markers (`ON DELETE CASCADE`), which is
 * the schema's stated intent: the thread, its messages and its markers go together.
 * SQLite's `changes()` does not count the cascaded rows, so the sentinel compares
 * threads only.
 */
export async function runThreadRetentionSweep(
  db: Db,
  deps: { now?: Date; pageSize?: number; maxPages?: number } = {},
): Promise<ThreadRetentionResult> {
  const now = deps.now ?? new Date();
  const pageSize = deps.pageSize ?? THREAD_RETENTION_PAGE_SIZE;
  const maxPages = deps.maxPages ?? THREAD_RETENTION_MAX_PAGES;
  const cutoff = threadRetentionCutoff(now);
  const due = lt(lastActivity, cutoff);
  const result: ThreadRetentionResult = {
    deleted: 0,
    pages: 0,
    truncated: false,
    raced: false,
    cutoff,
    auditEntries: [],
  };

  while (result.pages < maxPages) {
    const rows = await db
      .select({ id: claimThreads.id })
      .from(claimThreads)
      .where(due)
      .orderBy(asc(claimThreads.id))
      .limit(pageSize + 1);
    const page = rows.slice(0, pageSize).map((row) => row.id);
    if (page.length === 0) return result;

    const entry: AuditLogEntry = {
      actorId: null,
      actorType: 'system',
      action: THREAD_RETENTION_DELETED_ACTION,
      entityType: THREAD_ENTITY_TYPE,
      afterState: { count: page.length, threadIds: page },
      metadata: { source: THREAD_RETENTION_SOURCE, cutoff, retentionYears: THREAD_RETENTION_YEARS },
    };
    const stmts: BatchStmt[] = [
      db.delete(claimThreads).where(and(inArray(claimThreads.id, page), due)),
      db
        .select({
          guard: sql`CASE WHEN changes() <> ${page.length} THEN json(${RETENTION_RACE_TOKEN}) END`,
        })
        .from(ONE_ROW),
      auditInsert(db, entry),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isMalformedJson(error)) throw error;
      result.raced = true;
      return result;
    }
    result.deleted += page.length;
    result.pages += 1;
    result.auditEntries.push(entry);
    if (rows.length <= pageSize) return result;
  }
  result.truncated = true;
  return result;
}

function isMalformedJson(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/malformed JSON/i.test(text) || text.includes(RETENTION_RACE_TOKEN)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

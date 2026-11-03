/**
 * A private row thread read by its id, and the company's list of them
 * (`/api/vendor/*`, AECI-1548 / AECI-1551, `STAGE_2_ATTESTATIONS_SPEC.md` §15.3,
 * §15.10, §15.11) — Drizzle/D1.
 *
 *   GET /api/vendor/threads/:threadId — one thread, and whether the caller may write.
 *   GET /api/vendor/threads           — every thread the company is on, paged.
 *
 * Ruled 2026-10-30 (Chris): a vendor keeps read access to a thread whose row was
 * deleted, and every thread has one permanent page, `…/threads/:threadId`. Every
 * claim read finds a thread by `claim_id`, which a `claim_removed` close nulls.
 * These reads find it by its own id and by the stamped pair. Five rules:
 *
 * ── 1. THE STAMPED PAIR IS THE WHOLE READ GATE ──────────────────────────────
 * Both queries are filtered by `threadParticipantWhere` (`lib/claim-threads.ts`),
 * the one shared definition of who may read a thread (§15.3). A thread of two other
 * companies and a thread that does not exist are one query and one identical `404`.
 * No endpoint check on the read: the caller may no longer own either product, and
 * the claim may be gone.
 *
 * ── 2. WRITES STAY ON THE CLAIM ROUTES; `can_write` SAYS WHETHER ONE WOULD LAND ──
 * There is no write by thread id. A post, a delete and a help ask go through the
 * claim routes (`routes/vendor-threads.ts`) with the thread's `claim_id`. The by-id
 * read answers `can_write` from the checks those routes run, in their order: the
 * thread is open, its claim exists, `requireAttestableRow` passes (a current
 * endpoint, then the §15.2 test) and the integration is live. So the page never
 * offers a write the server refuses, short of a race the write itself answers.
 *
 * ── 3. THE ROW IS NAMED ─────────────────────────────────────────────────────
 * `data_object` is the live claim's data object, else the one the `claim_removed`
 * detach wrote into `anchor_snapshot`, the same key the admin read uses
 * (`routes/admin-threads.ts`).
 *
 * ── 4. THE READ MARKER, AS THE CLAIM GET WRITES IT ──────────────────────────
 * The by-id read upserts the caller's `claim_thread_reads` row, best effort. It is a
 * derived service write, exempt from audit under ADR 0022's 2026-10-29 amendment. A
 * failed marker never fails the read. The list shows no message, so it writes no
 * marker. Reads are never rate-limited.
 *
 * ── 5. THE LIST IS NEWEST ACTIVITY FIRST ────────────────────────────────────
 * Activity is the newest of the thread's creation, its newest message, its help
 * ask and its close. Ties break on `id`, BINARY (`API_CONTRACTS.md` §3.2). Paging
 * is `page` / `perPage`, as on `GET /api/vendor/history`.
 */

import {
  GetVendorThreadByIdResponseSchema,
  ListVendorThreadsResponseSchema,
  VendorThreadListQuerySchema,
  type GetVendorThreadByIdResponse,
  type ListVendorThreadsResponse,
  type ThreadClosedReason,
  type VendorThreadListStatus,
} from '@aeci/shared';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { getDb } from '../db/client';
import {
  claimThreadMessages,
  claimThreadReads,
  claimThreads,
  claims,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { threadParticipantWhere } from '../lib/claim-threads';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { isLiveIntegration } from '../lib/live-integration';
import { logToPosthog } from '../posthog';
import { loadThreadView, requireAttestableRow } from './vendor-threads';
import { sessionVendorId, type VendorContext } from './vendor-shared';

type ThreadRow = typeof claimThreads.$inferSelect;

/** The data object: the live claim's, else the one the `claim_removed` detach stamped. */
const dataObjectKey = sql`coalesce(${claims.dataObjectId}, json_extract(${claimThreads.anchorSnapshot}, '$.dataObjectId'))`;

/**
 * Rule 2: whether a post, a delete and a help ask by this caller would pass the
 * claim routes' checks. A refusal of any of them is `false`, never an error: the
 * read itself still answers.
 */
async function canWriteThread(db: Db, vendorId: string, thread: ThreadRow): Promise<boolean> {
  if (thread.closedAt !== null || thread.claimId === null) return false;
  try {
    const { authority } = await requireAttestableRow(db, vendorId, thread.claimId);
    return isLiveIntegration({ retiredAt: authority.retiredAt });
  } catch (error) {
    // The endpoint 404 and the §15.2 409 mean "not here". Anything else is a fault.
    if (error instanceof ApiError) return false;
    throw error;
  }
}

export function createGetVendorThreadByIdHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const threadId = c.req.param('threadId');
    if (!threadId) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing threadId', { field: 'threadId' });
    }
    // The read marker is a write, so the primary, like the claim GET (rule 4).
    const { db } = writeDb(c, dbFor);

    // Rule 1: one query decides. A stranger and a missing id both find nothing.
    const [found] = await db
      .select({
        thread: claimThreads,
        dataObjectSlug: taxonomyDataObjects.slug,
        dataObjectName: taxonomyDataObjects.name,
      })
      .from(claimThreads)
      .leftJoin(claims, eq(claims.id, claimThreads.claimId))
      .leftJoin(taxonomyDataObjects, eq(taxonomyDataObjects.id, dataObjectKey))
      .where(and(eq(claimThreads.id, threadId), threadParticipantWhere(vendorId)))
      .limit(1);
    if (!found) throw notFoundError('claim_thread', { id: threadId });

    // `is_own` goes through `isOwnMessage` inside the view: the caller's profile AND
    // its company (AECI-1545). `can_write` runs the claim routes' checks (rule 2).
    const [view, canWrite] = await Promise.all([
      loadThreadView(db, found.thread, { profileId: session.userId, vendorId }),
      canWriteThread(db, vendorId, found.thread),
    ]);
    const body: GetVendorThreadByIdResponse = {
      thread: {
        ...view,
        // `loadThreadView` reads a thread found by its claim. This one may have none.
        claim_id: found.thread.claimId,
        data_object:
          found.dataObjectSlug !== null && found.dataObjectName !== null
            ? { slug: found.dataObjectSlug, name: found.dataObjectName }
            : null,
        can_write: canWrite,
      },
    };

    const now = new Date().toISOString();
    try {
      await db
        .insert(claimThreadReads)
        .values({ threadId: found.thread.id, profileId: session.userId, readAt: now })
        .onConflictDoUpdate({
          target: [claimThreadReads.threadId, claimThreadReads.profileId],
          set: { readAt: now },
        });
    } catch (error) {
      logToPosthog(c.executionCtx, c.env, c.req.raw, {
        level: 'warn',
        message: `Thread read marker failed for ${found.thread.id}`,
        outcome: error instanceof Error ? error.message : String(error),
      });
    }

    validateResponseInDev(c.env, () => GetVendorThreadByIdResponseSchema.parse(body));
    return json(body);
  };
}

// ─── GET /api/vendor/threads ─────────────────────────────────────────────────

function statusWhere(status: VendorThreadListStatus): SQL | undefined {
  if (status === 'open') return isNull(claimThreads.closedAt);
  if (status === 'closed') return isNotNull(claimThreads.closedAt);
  return undefined;
}

/**
 * The company's Conversations list (AECI-1551, §15.11): every thread its company is
 * stamped on, open and closed, newest activity first. No message text and no read
 * marker (rule 4). A seat is the whole gate, like every thread read (§15.3).
 */
export function createListVendorThreadsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const query = VendorThreadListQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const { db } = dbFor(c.env);
    const where = and(threadParticipantWhere(vendorId), statusWhere(query.status));

    // Rule 5. SQLite's many-argument `max()` is NULL when any argument is, so each
    // optional time is coalesced to '' (every real timestamp sorts above it).
    const lastActivity = sql<string>`max(coalesce(max(${claimThreadMessages.createdAt}), ''), ${claimThreads.createdAt}, coalesce(${claimThreads.helpRequestedAt}, ''), coalesce(${claimThreads.closedAt}, ''))`;

    const [rows, [tally]] = await Promise.all([
      db
        .select({
          id: claimThreads.id,
          claimId: claimThreads.claimId,
          vendorAId: claimThreads.vendorAId,
          vendorBId: claimThreads.vendorBId,
          closedAt: claimThreads.closedAt,
          closedReason: claimThreads.closedReason,
          helpRequestedAt: claimThreads.helpRequestedAt,
          dataObjectSlug: taxonomyDataObjects.slug,
          dataObjectName: taxonomyDataObjects.name,
          messageCount: count(claimThreadMessages.id),
          lastActivityAt: lastActivity,
        })
        .from(claimThreads)
        .leftJoin(claims, eq(claims.id, claimThreads.claimId))
        .leftJoin(taxonomyDataObjects, eq(taxonomyDataObjects.id, dataObjectKey))
        .leftJoin(claimThreadMessages, eq(claimThreadMessages.threadId, claimThreads.id))
        .where(where)
        .groupBy(claimThreads.id)
        // Timestamps and ids order BINARY (`API_CONTRACTS.md` §3.2).
        .orderBy(desc(lastActivity), asc(claimThreads.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ n: count() }).from(claimThreads).where(where),
    ]);

    const otherOf = (a: string, b: string) => (a === vendorId ? b : a);
    const ids = [...new Set(rows.map((r) => otherOf(r.vendorAId, r.vendorBId)))];
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const found = await db
        .select({ id: vendors.id, name: vendors.companyName })
        .from(vendors)
        .where(inArray(vendors.id, ids));
      for (const v of found) names.set(v.id, v.name);
    }

    const body: ListVendorThreadsResponse = {
      data: rows.map((r) => {
        const other = otherOf(r.vendorAId, r.vendorBId);
        return {
          id: r.id,
          claim_id: r.claimId,
          counterparty: { id: other, name: names.get(other) ?? '' },
          data_object:
            r.dataObjectSlug !== null && r.dataObjectName !== null
              ? { slug: r.dataObjectSlug, name: r.dataObjectName }
              : null,
          message_count: r.messageCount,
          last_activity_at: r.lastActivityAt,
          closed_at: r.closedAt,
          closed_reason: (r.closedReason as ThreadClosedReason | null) ?? null,
          help_requested_at: r.helpRequestedAt,
        };
      }),
      page: query.page,
      perPage: query.perPage,
      total: tally?.n ?? 0,
    };
    validateResponseInDev(c.env, () => ListVendorThreadsResponseSchema.parse(body));
    return json(body);
  };
}

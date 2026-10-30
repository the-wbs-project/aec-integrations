/**
 * One private row thread read by its id (`/api/vendor/*`, AECI-1548 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §15.3, §15.10) — Drizzle/D1.
 *
 *   GET /api/vendor/threads/:threadId — the thread, read-only.
 *
 * Ruled 2026-10-30 (Chris): a vendor keeps read access to a thread whose row was
 * deleted. Every other vendor read finds a thread by `claim_id`, which a
 * `claim_removed` close nulls. This read finds it by its own id, so the close notice
 * (`portal-thread-closed`) can link to it. It also serves a thread whose claim
 * still exists. Four rules:
 *
 * ── 1. THE STAMPED PAIR IS THE WHOLE GATE ───────────────────────────────────
 * The query is filtered by `threadParticipantWhere` (`lib/claim-threads.ts`), the
 * one shared definition of who may read a thread (§15.3). A thread of two other
 * companies and a thread that does not exist are one query and one identical `404`.
 * No endpoint check: the caller may no longer own either product, and the claim
 * may be gone.
 *
 * ── 2. READ-ONLY ────────────────────────────────────────────────────────────
 * There is no write by thread id. A post, a delete and a help ask stay on the
 * claim routes (`routes/vendor-threads.ts`), which need a current endpoint.
 *
 * ── 3. THE ROW IS NAMED ─────────────────────────────────────────────────────
 * `data_object` is the live claim's data object, else the one the `claim_removed`
 * detach wrote into `anchor_snapshot`, the same key the admin read uses
 * (`routes/admin-threads.ts`).
 *
 * ── 4. THE READ MARKER, AS THE CLAIM GET WRITES IT ──────────────────────────
 * The caller's `claim_thread_reads` row is upserted, best effort. It is a derived
 * service write, exempt from audit under ADR 0022's 2026-10-29 amendment. A failed
 * marker never fails the read. Reads are never rate-limited.
 */

import {
  GetVendorThreadByIdResponseSchema,
  type GetVendorThreadByIdResponse,
} from '@aeci/shared';
import { and, eq, sql } from 'drizzle-orm';

import { getDb } from '../db/client';
import { claimThreadReads, claimThreads, claims, taxonomyDataObjects } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { threadParticipantWhere } from '../lib/claim-threads';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { logToPosthog } from '../posthog';
import { loadThreadView } from './vendor-threads';
import { sessionVendorId, type VendorContext } from './vendor-shared';

/** The data object: the live claim's, else the one the `claim_removed` detach stamped. */
const dataObjectKey = sql`coalesce(${claims.dataObjectId}, json_extract(${claimThreads.anchorSnapshot}, '$.dataObjectId'))`;

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
    // its company (AECI-1545).
    const view = await loadThreadView(db, found.thread, {
      profileId: session.userId,
      vendorId,
    });
    const body: GetVendorThreadByIdResponse = {
      thread: {
        ...view,
        // `loadThreadView` reads a thread found by its claim. This one may have none.
        claim_id: found.thread.claimId,
        data_object:
          found.dataObjectSlug !== null && found.dataObjectName !== null
            ? { slug: found.dataObjectSlug, name: found.dataObjectName }
            : null,
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

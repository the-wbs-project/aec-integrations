/**
 * The admin read of private row threads (AECI-1539, `STAGE_2_ATTESTATIONS_SPEC.md`
 * §15.12, `ADMIN_PANEL_SPEC.md` §5.19) — Drizzle/D1.
 *
 *   GET /api/admin/threads       — every thread, newest activity first, `?help=`.
 *   GET /api/admin/threads/:id   — one thread with every message, oldest first.
 *
 * Behind `requireAdmin()` on the `authAdmin` sub-router. Three rules:
 *
 * ── 1. READ-ONLY, AND NOTHING IS WRITTEN BY READING ─────────────────────────
 * AECi writes nothing on a thread in v1 (§15.3). These reads write no audit row,
 * as every admin `GET` does not (`ADMIN_PANEL_SPEC.md` §6 "Conventions"), and no
 * `claim_thread_reads` marker either: a marker is a SEAT's "I opened this", and an
 * operator is not a seat of either company. Reads are never rate-limited.
 *
 * ── 2. AECi READS THE TEXT OF A DELETED MESSAGE ─────────────────────────────
 * The vendor read withholds a soft-deleted body (§15.4). This one returns it, with
 * `deleted_at`, until the 2-year delete removes the row (§15.3).
 *
 * ── 3. A THREAD WHOSE CLAIM IS GONE IS STILL NAMED ──────────────────────────
 * `claim_id` goes null when the claim is deleted (`claim_removed`, §15.10). The data
 * object then comes from `anchor_snapshot.dataObjectId`, which the close writes, so
 * the list can still say what the thread was about.
 */

import {
  AdminThreadDetailResponseSchema,
  AdminThreadsQuerySchema,
  AdminThreadsResponseSchema,
  type AdminThreadDetailResponse,
  type AdminThreadRow,
  type AdminThreadsResponse,
  type ThreadClosedReason,
} from '@aeci/shared';
import { asc, count, desc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import {
  claimThreadMessages,
  claimThreads,
  claims,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

type AdminContext = Context<{ Bindings: Env }>;

const vendorA = alias(vendors, 'thread_vendor_a');
const vendorB = alias(vendors, 'thread_vendor_b');

/**
 * Per-thread message facts as correlated subqueries. The outer table is named in
 * full: a bare interpolated column can bind to the INNER table's `id`
 * (`ADMIN_PANEL_SPEC.md` §6, P1.5 note 4).
 */
const messageCount = sql<number>`(SELECT count(*) FROM "claim_thread_messages" AS "m" WHERE "m"."thread_id" = "claim_threads"."id")`;
const lastMessageAt = sql<
  string | null
>`(SELECT max("m"."created_at") FROM "claim_thread_messages" AS "m" WHERE "m"."thread_id" = "claim_threads"."id")`;

/** The data object: the live claim's, else the one the `claim_removed` close stamped. */
const dataObjectKey = sql`coalesce(${claims.dataObjectId}, json_extract(${claimThreads.anchorSnapshot}, '$.dataObjectId'))`;

function selectThreadRows(db: Db) {
  return db
    .select({
      id: claimThreads.id,
      claimId: claimThreads.claimId,
      dataObjectSlug: taxonomyDataObjects.slug,
      dataObjectName: taxonomyDataObjects.name,
      vendorAId: vendorA.id,
      vendorASlug: vendorA.slug,
      vendorAName: vendorA.companyName,
      vendorBId: vendorB.id,
      vendorBSlug: vendorB.slug,
      vendorBName: vendorB.companyName,
      messageCount,
      lastMessageAt,
      helpRequestedAt: claimThreads.helpRequestedAt,
      closedAt: claimThreads.closedAt,
      closedReason: claimThreads.closedReason,
      createdAt: claimThreads.createdAt,
    })
    .from(claimThreads)
    .innerJoin(vendorA, eq(vendorA.id, claimThreads.vendorAId))
    .innerJoin(vendorB, eq(vendorB.id, claimThreads.vendorBId))
    .leftJoin(claims, eq(claims.id, claimThreads.claimId))
    .leftJoin(taxonomyDataObjects, eq(taxonomyDataObjects.id, dataObjectKey));
}

type ThreadRowRaw = Awaited<ReturnType<ReturnType<typeof selectThreadRows>['where']>>[number];

function toAdminThreadRow(row: ThreadRowRaw): AdminThreadRow {
  return {
    id: row.id,
    claim_id: row.claimId,
    data_object:
      row.dataObjectSlug !== null && row.dataObjectName !== null
        ? { slug: row.dataObjectSlug, name: row.dataObjectName }
        : null,
    vendor_a: { id: row.vendorAId, slug: row.vendorASlug, name: row.vendorAName },
    vendor_b: { id: row.vendorBId, slug: row.vendorBSlug, name: row.vendorBName },
    message_count: Number(row.messageCount ?? 0),
    last_message_at: row.lastMessageAt ?? null,
    help_requested_at: row.helpRequestedAt,
    closed_at: row.closedAt,
    closed_reason: (row.closedReason as ThreadClosedReason | null) ?? null,
    created_at: row.createdAt,
  };
}

// ─── GET /api/admin/threads ──────────────────────────────────────────────────

export function createAdminThreadsListHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = AdminThreadsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const { db } = dbFor(c.env);
    const where: SQL | undefined =
      query.help === 'requested' ? isNotNull(claimThreads.helpRequestedAt) : undefined;

    // Newest activity first: the thread with the latest message on top. A thread
    // with no message left (only possible mid-sweep) sorts by when it opened.
    // `id` breaks a tie so pages are stable (AECI-825). Timestamps order BINARY.
    const [rows, totalRows] = await Promise.all([
      selectThreadRows(db)
        .where(where)
        .orderBy(
          desc(sql`coalesce(${lastMessageAt}, ${claimThreads.createdAt})`),
          asc(claimThreads.id),
        )
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(claimThreads).where(where),
    ]);

    const body: AdminThreadsResponse = {
      data: rows.map(toAdminThreadRow),
      page: query.page,
      perPage: query.perPage,
      total: totalRows[0]?.value ?? 0,
    };
    validateResponseInDev(c.env, () => AdminThreadsResponseSchema.parse(body));
    return json(body);
  };
}

// ─── GET /api/admin/threads/:id ──────────────────────────────────────────────

export function createAdminThreadDetailHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const id = c.req.param('id');
    if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    const { db } = dbFor(c.env);

    const [threadRows, messages] = await Promise.all([
      selectThreadRows(db).where(eq(claimThreads.id, id)).limit(1),
      db
        .select({
          id: claimThreadMessages.id,
          authorProfileId: claimThreadMessages.authorProfileId,
          authorVendorId: vendors.id,
          authorVendorSlug: vendors.slug,
          authorVendorName: vendors.companyName,
          body: claimThreadMessages.body,
          createdAt: claimThreadMessages.createdAt,
          deletedAt: claimThreadMessages.deletedAt,
        })
        .from(claimThreadMessages)
        .innerJoin(vendors, eq(vendors.id, claimThreadMessages.authorVendorId))
        .where(eq(claimThreadMessages.threadId, id))
        // Oldest first, as the vendor read. `id` keeps a same-millisecond pair stable.
        .orderBy(asc(claimThreadMessages.createdAt), asc(claimThreadMessages.id)),
    ]);
    const [thread] = threadRows;
    if (!thread) throw notFoundError('claim_thread', { id });

    const body: AdminThreadDetailResponse = {
      thread: {
        ...toAdminThreadRow(thread),
        messages: messages.map((m) => ({
          id: m.id,
          author_vendor: {
            id: m.authorVendorId,
            slug: m.authorVendorSlug,
            name: m.authorVendorName,
          },
          author_profile_id: m.authorProfileId,
          // Rule 2: the stored text, deleted or not.
          body: m.body,
          created_at: m.createdAt,
          deleted_at: m.deletedAt,
        })),
      },
    };
    validateResponseInDev(c.env, () => AdminThreadDetailResponseSchema.parse(body));
    return json(body);
  };
}

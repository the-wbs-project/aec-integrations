/**
 * Private row threads between the two endpoint companies (`/api/vendor/*`,
 * AECI-1535 / `STAGE_2_ATTESTATIONS_SPEC.md` §15) — Drizzle/D1.
 *
 *   GET    /api/vendor/claims/:claimId/thread                       — the thread, or `null`.
 *   POST   /api/vendor/claims/:claimId/thread/messages              — post (201).
 *   DELETE /api/vendor/claims/:claimId/thread/messages/:messageId   — soft delete (200).
 *   POST   /api/vendor/claims/:claimId/thread/help                  — ask AECi (200).
 *
 * `routes/vendor.ts` holds the narrative of this surface's invariants. Five rules of
 * this module's own:
 *
 * ── 1. ORDER: CLAIM → ATTESTABLE → LIVE → BODY → THREAD STATE ───────────────
 * The claim id is a path param, so the endpoint check runs first, alone in its
 * wave, through `resolveClaimAuthority`: a claim the caller touches neither endpoint
 * of, and a claim that does not exist, are one query and one `404` (§15.3). Then the
 * §15.2 test on every write: `isConnectorPoweredEdge` false, and two DISTINCT
 * vendors on the two endpoints (`vendorsForIntegrationSlots`). A failure is
 * `409 THREAD_NOT_ATTESTABLE`. The two new-speech writes (post, help) then refuse a
 * retired row with `409 INTEGRATION_RETIRED`, as every other vendor write on a
 * retired row does. Then the body, then the thread's own state.
 *
 * ── 2. A THREAD BELONGS TO ITS TWO COMPANIES ────────────────────────────────
 * `vendor_a_id` / `vendor_b_id` are stamped when the first message creates the
 * thread, from the claim's two current endpoint vendors. Ruled 2026-10-29 (§15.3):
 * the stamped pair decides access, through `lib/claim-threads.ts`. A caller of
 * either stamped company may READ, even after its company stopped owning the
 * product. A WRITE also needs a current endpoint of the claim. Anyone else, a third
 * company co-owning an endpoint product included, gets the stranger's `404`.
 * `help_requested_at` is visible to both companies.
 *
 * ── 3. ONE BATCH PER WRITE, NO TEXT IN AUDIT ────────────────────────────────
 * Every write is one `db.batch`: the mutation, its `changes()` / thread-open
 * sentinels, its `audit_log` row and (on a post) the other company's
 * `notification.sent` row. **No audit row and no notification row carries message
 * text** (§15.7, ruled 2026-10-29): `posted` records `{ threadId, claimId, vendorId,
 * length }`. The post-commit forward sends action, entity type and ids only.
 *
 * ── 4. NO CACHE, NO PURGE ───────────────────────────────────────────────────
 * Nothing about a thread reaches a public read or a cached SSR page (§15.6), so
 * `afterVendorWrite` runs with no tags and no re-crawl.
 *
 * ── 5. THE READ MARKER IS EXEMPT ────────────────────────────────────────────
 * The `GET` upserts the caller's `claim_thread_reads` row. It is a derived service
 * write, exempt from audit under ADR 0022's 2026-10-29 amendment, and best effort:
 * a failed marker never fails the read. Reads are never rate-limited.
 */

import {
  ApiErrorCode,
  GetVendorThreadResponseSchema,
  PostThreadMessageSchema,
  VendorThreadResultSchema,
  type GetVendorThreadResponse,
  type ThreadClosedReason,
  type ThreadCompany,
  type VendorThread,
  type VendorThreadResult,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { getDb } from '../db/client';
import {
  claimThreadMessages,
  claimThreadReads,
  claimThreads,
  products,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { logToPosthog } from '../posthog';
import {
  resolveClaimAuthority,
  vendorsForIntegrationSlots,
  type AttestationAuthority,
  type ClaimAuthority,
} from '../lib/attestation-authority';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { isConnectorPoweredEdge } from '../lib/connector-powered';
import { sendThreadHelpRequestedNotification } from '../lib/email';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { ONE_ROW } from '../lib/integration-claims';
import { isThreadParticipant } from '../lib/claim-threads';
import { assertIntegrationLive } from '../lib/live-integration';
import {
  THREAD_ACTIONS,
  THREAD_ENTITY_TYPE,
  THREAD_MESSAGE_ENTITY_TYPE,
  threadMessageNotificationAudit,
} from '../lib/thread-notification';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  parseJsonBody,
  sessionVendorId,
  type VendorContext,
  vendorAuditEntry,
} from './vendor-shared';

type ThreadRow = typeof claimThreads.$inferSelect;

/** The operator alert seam, injectable so a spec can capture what was sent. */
export type SendThreadHelpAlert = typeof sendThreadHelpRequestedNotification;

// ─── Errors ──────────────────────────────────────────────────────────────────

function notAttestable(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.THREAD_NOT_ATTESTABLE,
    'This data row has no private thread. A thread needs two different companies on the two products, and an integration neither of them delivers through a connector.',
  );
}

function threadClosed(reason: string | null): ApiError {
  return new ApiError(409, ApiErrorCode.THREAD_CLOSED, 'This thread is closed. It is read-only.', {
    details: { closed_reason: reason },
  });
}

function notAuthor(): ApiError {
  return new ApiError(
    403,
    ApiErrorCode.MESSAGE_NOT_AUTHOR,
    'Only the person who wrote a message can delete it.',
  );
}

// ─── Params ──────────────────────────────────────────────────────────────────

function pathParam(c: VendorContext, name: 'claimId' | 'messageId'): string {
  const value = c.req.param(name);
  if (!value) {
    throw new ApiError(400, 'VALIDATION_FAILED', `Missing ${name}`, { field: name });
  }
  return value;
}

// ─── The §15.2 test ──────────────────────────────────────────────────────────

/**
 * The two companies a thread on this row would be between, or `null` when the row
 * is not attestable by two companies (§15.2).
 *
 * The caller always fills its own side. `vendor_a` is endpoint A (the source
 * product), `vendor_b` endpoint B, as `lib/attestation-authority.ts` defines the
 * slots. When the caller owns endpoint A, the other side is the first vendor of
 * endpoint B that is not the caller, and the reverse. A company owning both
 * endpoints, with nobody else on either, is one company and gets `null`.
 */
async function threadParties(
  db: Db,
  vendorId: string,
  authority: AttestationAuthority,
): Promise<{ vendorAId: string; vendorBId: string } | null> {
  if (isConnectorPoweredEdge(authority)) return null;
  const slots = (await vendorsForIntegrationSlots(db, [authority.integrationId])).get(
    authority.integrationId,
  );
  if (!slots) return null;
  const other = (list: readonly string[]) => list.find((id) => id !== vendorId) ?? null;
  if (authority.slots.includes('vendor_a')) {
    const b = other(slots.slots.vendor_b);
    if (b) return { vendorAId: vendorId, vendorBId: b };
  }
  if (authority.slots.includes('vendor_b')) {
    const a = other(slots.slots.vendor_a);
    if (a) return { vendorAId: a, vendorBId: vendorId };
  }
  return null;
}

/** Endpoint check (404), then the §15.2 test (409). Every write runs it first. */
async function requireAttestableRow(
  db: Db,
  vendorId: string,
  claimId: string,
): Promise<ClaimAuthority & { parties: { vendorAId: string; vendorBId: string } }> {
  const resolved = await resolveClaimAuthority(db, vendorId, claimId);
  const parties = await threadParties(db, vendorId, resolved.authority);
  if (!parties) throw notAttestable();
  return { ...resolved, parties };
}

// ─── Loads ───────────────────────────────────────────────────────────────────

async function loadThreadRow(db: Db, claimId: string): Promise<ThreadRow | undefined> {
  return db.query.claimThreads.findFirst({ where: eq(claimThreads.claimId, claimId) });
}

/** The thread on this claim, if the caller's company is one of its two. A third
 *  company gets the same 404 as a stranger (rule 2). */
function requireParticipant(thread: ThreadRow, vendorId: string, claimId: string): void {
  if (!isThreadParticipant(thread, vendorId)) {
    throw notFoundError('claim', { id: claimId });
  }
}

/** Who is reading: the session's profile and its current company. */
type Viewer = { readonly profileId: string; readonly vendorId: string };

/**
 * The thread as the caller reads it: messages oldest first, bodies of deleted
 * messages withheld (§15.4). `is_own` needs the profile AND the company the message
 * was posted for, so a person re-seated at another company does not own their old
 * company's messages (AECI-1545). `isOwnMessage` is the one test, shared with the
 * delete.
 */
async function loadThreadView(db: Db, thread: ThreadRow, viewer: Viewer): Promise<VendorThread> {
  const [messages, companies] = await Promise.all([
    db
      .select({
        id: claimThreadMessages.id,
        authorProfileId: claimThreadMessages.authorProfileId,
        authorVendorId: claimThreadMessages.authorVendorId,
        authorVendorName: vendors.companyName,
        body: claimThreadMessages.body,
        createdAt: claimThreadMessages.createdAt,
        deletedAt: claimThreadMessages.deletedAt,
      })
      .from(claimThreadMessages)
      .innerJoin(vendors, eq(vendors.id, claimThreadMessages.authorVendorId))
      .where(eq(claimThreadMessages.threadId, thread.id))
      // Timestamps and ids order BINARY (`API_CONTRACTS.md` §3.2). The `id` tiebreak
      // keeps two messages in the same millisecond in a stable order.
      .orderBy(asc(claimThreadMessages.createdAt), asc(claimThreadMessages.id)),
    db
      .select({ id: vendors.id, name: vendors.companyName })
      .from(vendors)
      .where(inArray(vendors.id, [thread.vendorAId, thread.vendorBId])),
  ]);
  const name = new Map(companies.map((v) => [v.id, v.name]));
  return {
    id: thread.id,
    // The thread was found by this claim id, so it is set.
    claim_id: thread.claimId!,
    vendor_a: { id: thread.vendorAId, name: name.get(thread.vendorAId) ?? '' },
    vendor_b: { id: thread.vendorBId, name: name.get(thread.vendorBId) ?? '' },
    closed_at: thread.closedAt,
    closed_reason: (thread.closedReason as ThreadClosedReason | null) ?? null,
    help_requested_at: thread.helpRequestedAt,
    created_at: thread.createdAt,
    messages: messages.map((m) => ({
      id: m.id,
      author_vendor: { id: m.authorVendorId, name: m.authorVendorName },
      author_removed: m.authorProfileId === null,
      is_own: isOwnMessage(m, viewer),
      body: m.deletedAt ? null : m.body,
      created_at: m.createdAt,
      deleted_at: m.deletedAt,
    })),
  };
}

/** The caller wrote this message for the company it sits at now. */
function isOwnMessage(
  message: { readonly authorProfileId: string | null; readonly authorVendorId: string },
  viewer: Viewer,
): boolean {
  return (
    message.authorProfileId !== null &&
    message.authorProfileId === viewer.profileId &&
    message.authorVendorId === viewer.vendorId
  );
}

/**
 * The company the caller's messages go to (§15.6, AECI-1545). With a thread, the
 * stamped company that is not the caller's, whoever owns the products today. With
 * none, the company the first post would stamp: `threadParties`, the function the
 * post uses, so the composer names the real recipient. `null` when the row is not
 * attestable by two companies.
 */
async function loadCounterparty(
  db: Db,
  vendorId: string,
  view: VendorThread | null,
  authority: AttestationAuthority | null,
): Promise<ThreadCompany | null> {
  if (view) return view.vendor_a.id === vendorId ? view.vendor_b : view.vendor_a;
  if (!authority) return null;
  const parties = await threadParties(db, vendorId, authority);
  if (!parties) return null;
  const otherId = parties.vendorAId === vendorId ? parties.vendorBId : parties.vendorAId;
  const other = await db.query.vendors.findFirst({
    columns: { id: true, companyName: true },
    where: eq(vendors.id, otherId),
  });
  return { id: otherId, name: other?.companyName ?? '' };
}

/** The row's names, for the notification row and the help email. Ids and names
 *  only, never message text. */
async function loadRowContext(
  db: Db,
  resolved: ClaimAuthority,
): Promise<{
  dataObject: { slug: string; name: string };
  sourceName: string;
  targetName: string;
  pairSlugs: readonly [string, string] | null;
}> {
  const { authority, claim } = resolved;
  const [term, endpoints] = await Promise.all([
    db.query.taxonomyDataObjects.findFirst({
      columns: { slug: true, name: true },
      where: eq(taxonomyDataObjects.id, claim.dataObjectId),
    }),
    db
      .select({ id: products.id, slug: products.slug, name: products.name })
      .from(products)
      .where(inArray(products.id, [authority.sourceProductId, authority.targetProductId])),
  ]);
  const byId = new Map(endpoints.map((p) => [p.id, p]));
  const source = byId.get(authority.sourceProductId);
  const target = byId.get(authority.targetProductId);
  return {
    dataObject: term ?? { slug: claim.dataObjectId, name: claim.dataObjectId },
    sourceName: source?.name ?? authority.sourceProductId,
    targetName: target?.name ?? authority.targetProductId,
    pairSlugs: source && target ? [source.slug, target.slug] : null,
  };
}

// ─── Batch guards ────────────────────────────────────────────────────────────

const THREAD_RACE_TOKEN = 'thread-changed';

/** Aborts the batch when the thread closed after the handler read it open. Same
 *  `json()` abort as the contest sentinels (`lib/integration-contests.ts`). */
function threadOpenSentinel(db: Db, threadId: string) {
  return db
    .select({
      guard: sql`CASE WHEN EXISTS (SELECT 1 FROM ${claimThreads} WHERE ${claimThreads.id} = ${threadId} AND ${claimThreads.closedAt} IS NOT NULL) THEN json(${THREAD_RACE_TOKEN}) END`,
    })
    .from(ONE_ROW);
}

/** Aborts the batch when the guarded UPDATE straight before it matched no row. */
function changedSentinel(db: Db) {
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json(${THREAD_RACE_TOKEN}) END` })
    .from(ONE_ROW);
}

function causeChainMatches(error: unknown, pattern: RegExp): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (pattern.test(String((current as { message?: unknown }).message ?? current))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** A sentinel fired. The two sentinels above are the only `json()` calls in a
 *  thread batch, so the match is unambiguous. */
function isThreadRaceError(error: unknown): boolean {
  return causeChainMatches(error, /malformed JSON/i);
}

/** Two first posts raced, and the other one created the thread. */
function isThreadCreateConflict(error: unknown): boolean {
  return causeChainMatches(
    error,
    /claim_threads_claim_key|UNIQUE constraint failed: claim_threads\.claim_id/,
  );
}

// ─── Audit ───────────────────────────────────────────────────────────────────

function threadAudit(
  c: VendorContext,
  action: (typeof THREAD_ACTIONS)[keyof typeof THREAD_ACTIONS],
  entity: { type: string; id: string },
  afterState: Record<string, unknown>,
  metadata: Record<string, unknown>,
): AuditLogEntry {
  const session = c.get('auth');
  return {
    actorId: session.userId,
    actorType: auditActorType(session),
    action,
    entityType: entity.type,
    entityId: entity.id,
    beforeState: null,
    afterState,
    metadata: { source: AUDIT_SOURCE, vendorId: sessionVendorId(c), ...metadata },
  };
}

function respond(c: VendorContext, body: VendorThreadResult, status: 200 | 201): Response {
  validateResponseInDev(c.env, () => VendorThreadResultSchema.parse(body));
  return json(body, { status });
}

// ─── GET /api/vendor/claims/:claimId/thread ──────────────────────────────────

/**
 * The thread and its messages, oldest first, or `thread: null` before the first
 * message. Not gated on §15.2: a row that stopped being attestable still shows the
 * thread it has. `counterparty` names who the caller's messages go to
 * (`loadCounterparty`). Writes the caller's read marker (rule 5).
 */
export function createGetVendorThreadHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const claimId = pathParam(c, 'claimId');
    const { db } = writeDb(c, dbFor);

    // Rule 2: a thread is read by its two stamped companies, whoever owns the
    // products today. Before the first message the endpoint check decides. A
    // stranger gets one identical 404 either way.
    const row = await loadThreadRow(db, claimId);
    const viewer = { profileId: session.userId, vendorId };
    let body: GetVendorThreadResponse;
    if (!row) {
      const { authority } = await resolveClaimAuthority(db, vendorId, claimId);
      body = { thread: null, counterparty: await loadCounterparty(db, vendorId, null, authority) };
    } else {
      requireParticipant(row, vendorId, claimId);
      const thread = await loadThreadView(db, row, viewer);
      body = { thread, counterparty: await loadCounterparty(db, vendorId, thread, null) };
      const now = new Date().toISOString();
      try {
        await db
          .insert(claimThreadReads)
          .values({ threadId: row.id, profileId: session.userId, readAt: now })
          .onConflictDoUpdate({
            target: [claimThreadReads.threadId, claimThreadReads.profileId],
            set: { readAt: now },
          });
      } catch (error) {
        logToPosthog(c.executionCtx, c.env, c.req.raw, {
          level: 'warn',
          message: `Thread read marker failed for ${row.id}`,
          outcome: error instanceof Error ? error.message : String(error),
        });
      }
    }
    validateResponseInDev(c.env, () => GetVendorThreadResponseSchema.parse(body));
    return json(body);
  };
}

// ─── POST /api/vendor/claims/:claimId/thread/messages ────────────────────────

/**
 * Post a message. The first one creates the thread in the same batch (§15.2). The
 * other company gets one `portal-thread-message` row in that batch (§15.8).
 */
export function createPostThreadMessageHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const claimId = pathParam(c, 'claimId');
    const { db } = writeDb(c, dbFor);

    const resolved = await requireAttestableRow(db, vendorId, claimId);
    assertIntegrationLive(resolved.authority);
    const { body } = await parseJsonBody(c, PostThreadMessageSchema);
    const [context, fromVendor] = await Promise.all([
      loadRowContext(db, resolved),
      db.query.vendors.findFirst({
        columns: { companyName: true },
        where: eq(vendors.id, vendorId),
      }),
    ]);
    if (!fromVendor) throw notFoundError('vendor', { id: vendorId });

    // Two attempts: the second runs only when a racing first post created the thread.
    for (let attempt = 1; ; attempt++) {
      const existing = await loadThreadRow(db, claimId);
      if (existing) {
        requireParticipant(existing, vendorId, claimId);
        if (existing.closedAt) throw threadClosed(existing.closedReason);
      }
      const now = new Date().toISOString();
      const threadId = existing?.id ?? crypto.randomUUID();
      const vendorAId = existing?.vendorAId ?? resolved.parties.vendorAId;
      const vendorBId = existing?.vendorBId ?? resolved.parties.vendorBId;
      const recipient = vendorAId === vendorId ? vendorBId : vendorAId;
      const messageId = crypto.randomUUID();

      const posted = threadAudit(
        c,
        THREAD_ACTIONS.posted,
        { type: THREAD_MESSAGE_ENTITY_TYPE, id: messageId },
        { threadId, claimId, vendorId, length: body.length },
        {
          threadId,
          claimId,
          integrationId: resolved.authority.integrationId,
          ...(existing ? {} : { threadCreated: true }),
        },
      );
      const notice = threadMessageNotificationAudit(
        'portal-thread-message',
        { actorId: session.userId, actorType: auditActorType(session) },
        {
          vendorId: recipient,
          fromVendorId: vendorId,
          fromVendorName: fromVendor.companyName,
          threadId,
          messageId,
          claimId,
          integrationId: resolved.authority.integrationId,
          dataObject: context.dataObject,
          pairSlugs: context.pairSlugs,
        },
      );
      const audits = [posted, notice];
      const stmts: BatchStmt[] = [
        existing
          ? threadOpenSentinel(db, threadId)
          : db.insert(claimThreads).values({
              id: threadId,
              claimId,
              vendorAId,
              vendorBId,
              createdAt: now,
            }),
        db.insert(claimThreadMessages).values({
          id: messageId,
          threadId,
          authorProfileId: session.userId,
          authorVendorId: vendorId,
          body,
          createdAt: now,
        }),
        ...audits.map((entry) => auditInsert(db, vendorAuditEntry(c, entry))),
      ];
      try {
        await db.batch(stmts as BatchTuple);
      } catch (error) {
        if (!existing && attempt < 2 && isThreadCreateConflict(error)) continue;
        if (isThreadRaceError(error)) {
          const after = await loadThreadRow(db, claimId);
          throw threadClosed(after?.closedReason ?? null);
        }
        throw error;
      }
      afterVendorWrite(c, [], audits);
      const thread = await loadThreadRow(db, claimId);
      return respond(
        c,
        { thread: await loadThreadView(db, thread!, { profileId: session.userId, vendorId }) },
        201,
      );
    }
  };
}

// ─── DELETE /api/vendor/claims/:claimId/thread/messages/:messageId ───────────

/**
 * Soft-delete the caller's own message (§15.4). `deleted_at` is set and the body
 * leaves every vendor read. The text stays in D1 for AECi until the 2-year delete.
 * Deleting an already deleted message is a no-op `200` with no audit row.
 */
export function createDeleteThreadMessageHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const claimId = pathParam(c, 'claimId');
    const messageId = pathParam(c, 'messageId');
    const { db } = writeDb(c, dbFor);

    await requireAttestableRow(db, vendorId, claimId);
    const thread = await loadThreadRow(db, claimId);
    if (!thread) throw notFoundError('claim_thread_message', { id: messageId });
    requireParticipant(thread, vendorId, claimId);
    const message = await db.query.claimThreadMessages.findFirst({
      where: and(
        eq(claimThreadMessages.id, messageId),
        eq(claimThreadMessages.threadId, thread.id),
      ),
    });
    if (!message) throw notFoundError('claim_thread_message', { id: messageId });
    // The profile AND the company it posted for (AECI-1545): a person re-seated at
    // another company cannot delete their old company's messages.
    if (!isOwnMessage(message, { profileId: session.userId, vendorId })) throw notAuthor();
    if (thread.closedAt) throw threadClosed(thread.closedReason);

    if (!message.deletedAt) {
      const now = new Date().toISOString();
      const audit = threadAudit(
        c,
        THREAD_ACTIONS.deleted,
        { type: THREAD_MESSAGE_ENTITY_TYPE, id: messageId },
        { deletedAt: now },
        { threadId: thread.id, claimId },
      );
      try {
        await db.batch([
          db
            .update(claimThreadMessages)
            .set({ deletedAt: now })
            .where(
              and(eq(claimThreadMessages.id, messageId), isNull(claimThreadMessages.deletedAt)),
            ),
          changedSentinel(db),
          threadOpenSentinel(db, thread.id),
          auditInsert(db, vendorAuditEntry(c, audit)),
        ] as BatchTuple);
        afterVendorWrite(c, [], [audit]);
      } catch (error) {
        if (!isThreadRaceError(error)) throw error;
        // A racing delete of the same message is the no-op it would have been. A
        // close that landed first is the 409.
        const after = await loadThreadRow(db, claimId);
        if (after?.closedAt) throw threadClosed(after.closedReason);
      }
    }
    const fresh = (await loadThreadRow(db, claimId)) ?? thread;
    return respond(
      c,
      { thread: await loadThreadView(db, fresh, { profileId: session.userId, vendorId }) },
      200,
    );
  };
}

// ─── POST /api/vendor/claims/:claimId/thread/help ────────────────────────────

/**
 * Ask AECi to look (§15.3). Sets `help_requested_at` and emails the support inbox
 * after commit. A thread asks once: a second ask while it is set is a no-op `200`
 * that writes and sends nothing. A row with no thread yet is a `404`: a thread is
 * created by its first message, never in advance.
 */
export function createRequestThreadHelpHandler(
  dbFor: DbFactory = getDb,
  sendAlert: SendThreadHelpAlert = sendThreadHelpRequestedNotification,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const claimId = pathParam(c, 'claimId');
    const { db } = writeDb(c, dbFor);

    const resolved = await requireAttestableRow(db, vendorId, claimId);
    assertIntegrationLive(resolved.authority);
    const thread = await loadThreadRow(db, claimId);
    if (!thread) throw notFoundError('claim_thread', { id: claimId });
    requireParticipant(thread, vendorId, claimId);
    if (thread.closedAt) throw threadClosed(thread.closedReason);

    if (!thread.helpRequestedAt) {
      const now = new Date().toISOString();
      const audit = threadAudit(
        c,
        THREAD_ACTIONS.helpRequested,
        { type: THREAD_ENTITY_TYPE, id: thread.id },
        { helpRequestedAt: now },
        { threadId: thread.id, claimId },
      );
      let committed = true;
      try {
        await db.batch([
          db
            .update(claimThreads)
            .set({ helpRequestedAt: now })
            .where(
              and(
                eq(claimThreads.id, thread.id),
                isNull(claimThreads.helpRequestedAt),
                isNull(claimThreads.closedAt),
              ),
            ),
          changedSentinel(db),
          auditInsert(db, vendorAuditEntry(c, audit)),
        ] as BatchTuple);
      } catch (error) {
        if (!isThreadRaceError(error)) throw error;
        // Another seat asked first (the no-op), or the thread closed (the 409).
        const after = await loadThreadRow(db, claimId);
        if (after?.closedAt) throw threadClosed(after.closedReason);
        committed = false;
      }
      if (committed) {
        afterVendorWrite(c, [], [audit]);
        c.executionCtx.waitUntil(alertAeci(c, db, resolved, thread, sendAlert));
      }
    }
    const fresh = (await loadThreadRow(db, claimId)) ?? thread;
    return respond(
      c,
      { thread: await loadThreadView(db, fresh, { profileId: session.userId, vendorId }) },
      200,
    );
  };
}

/** Email AECi after commit, inside `waitUntil`. Never rejects. */
async function alertAeci(
  c: VendorContext,
  db: Db,
  resolved: ClaimAuthority,
  thread: ThreadRow,
  sendAlert: SendThreadHelpAlert,
): Promise<void> {
  try {
    const vendorId = sessionVendorId(c);
    const otherId = thread.vendorAId === vendorId ? thread.vendorBId : thread.vendorAId;
    const [context, named, [tally]] = await Promise.all([
      loadRowContext(db, resolved),
      db
        .select({ id: vendors.id, name: vendors.companyName })
        .from(vendors)
        .where(inArray(vendors.id, [vendorId, otherId])),
      db
        .select({ n: count() })
        .from(claimThreadMessages)
        .where(eq(claimThreadMessages.threadId, thread.id)),
    ]);
    const names = new Map(named.map((v) => [v.id, v.name]));
    await sendAlert(c, {
      threadId: thread.id,
      claimId: resolved.claim.id,
      integrationName: `${context.sourceName} and ${context.targetName}`,
      dataObjectName: context.dataObject.name,
      requesterVendorName: names.get(vendorId) ?? vendorId,
      otherVendorName: names.get(otherId) ?? otherId,
      messageCount: tally?.n ?? 0,
      pairSlugs: context.pairSlugs,
    });
  } catch (error) {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: `Thread help alert failed for ${thread.id}`,
      outcome: error instanceof Error ? error.message : String(error),
    });
  }
}

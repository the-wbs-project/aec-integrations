/**
 * The ownership message to the review app (AECI-1418, E6b.2; ADR 0042;
 * `docs/REVIEW_APP_PROMOTE_API.md` §4d). The first call the live app makes INTO the
 * review app.
 *
 * Producer enqueues, consumer works:
 *
 *   1. A write that moves ownership commits its batch (claim approval, the admin seat
 *      provision, a proposal accept or decline, "Return records to AECi"). Post-commit
 *      it calls {@link dispatchOwnershipSync}, which `send()`s one
 *      `OwnershipSyncMessage` to `OWNERSHIP_SYNC_QUEUE` inside `waitUntil`. A send
 *      failure warns and is swallowed: the user's write already committed, and the
 *      backfill (`ops:backfill-ownership-sync`) re-sends any vendor.
 *   2. The `queue()` consumer (`scheduled.ts`) routes an `aeci-ownership-sync-*` batch
 *      to {@link deliverOwnershipSync}. It reads the vendor's CURRENT state from D1,
 *      builds the whole record ({@link buildOwnershipRecord}) and `PUT`s it. The
 *      message carries no ownership data, so a late delivery still sends the latest
 *      state, and the receiver's `version` check drops anything older.
 *
 * Every attempt writes one `ownership_sync_deliveries` row (log-class, ADR 0022
 * 2026-10-20 amendment) and one `aeci.ownership_sync.delivery` count. Every response
 * body is released unread with `discardResponseBody`, on every path: the receiver's
 * status code is the whole answer.
 */

import {
  OWNERSHIP_RECORD_SCHEMA_VERSION,
  OwnershipSyncMessageSchema,
  ownershipRecordUrl,
  type OwnershipIntegration,
  type OwnershipProposal,
  type OwnershipRecord,
  type OwnershipSyncMessage,
  type OwnershipSyncReason,
  type RecordOwner,
} from '@aeci/shared';
import { discardResponseBody } from '@aeci/shared/response-drain';
import { eq, inArray, or } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import {
  connectorEvidencedPairs,
  integrations,
  ownershipSyncDeliveries,
  productProposals,
  productVendors,
  vendors,
  type OwnershipSyncOutcome,
} from '../db/schema';
import type { Env } from '../env';
import { logToPosthog, submitCount } from '../posthog';
import { loadOwnedProductIds, loadOwnedVendorIds } from './claimed-vendors';
import type { DbFactory } from './handler-utils';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Queue-name prefix the consumer routes on. Names are `aeci-ownership-sync-{env}`. */
export const OWNERSHIP_SYNC_QUEUE_PREFIX = 'aeci-ownership-sync-';

/**
 * The consumer's `max_retries` in every `wrangler.jsonc` block. A message is delivered
 * at most `1 + OWNERSHIP_SYNC_MAX_RETRIES` times. `wrangler-ownership-sync.spec.ts`
 * pins the config to this constant, because the consumer uses it to tell the last
 * attempt (`exhausted`) from one that will come back (`retry`).
 */
export const OWNERSHIP_SYNC_MAX_RETRIES = 5;

/** Per-attempt request budget. The receiver does one small D1 write. */
export const OWNERSHIP_SYNC_TIMEOUT_MS = 10_000;

/** Ids per `IN (...)` list. D1 caps a statement at 100 bound parameters, and the
 *  integration reads bind each chunk twice (source OR target). */
const ID_CHUNK = 40;

/** `retry()` delay before attempt `attempt + 1`: 30 s, 60 s, 120 s, 240 s, 480 s. */
export function retryDelaySeconds(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempt - 1), 900);
}

export function isOwnershipSyncQueue(queueName: string): boolean {
  return queueName.startsWith(OWNERSHIP_SYNC_QUEUE_PREFIX);
}

/** Status → outcome. 2xx delivered, 409 stale (the receiver holds newer), 408/429/5xx
 *  retryable, every other status permanent. */
export function classifyStatus(status: number): 'delivered' | 'stale' | 'retry' | 'permanent' {
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 409) return 'stale';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'permanent';
}

// ---------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------

/** Anything with `waitUntil`: a Worker `ExecutionContext` or Hono's. */
type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

/** The slice of a Hono context the producer needs. */
export interface OwnershipSyncProducerContext {
  env: Env;
  executionCtx: WaitUntil;
  req: { raw: Request };
}

/**
 * Enqueue one ownership message per vendor. Never throws. One vendor is one `send()`;
 * several are one `sendBatch()` (100 per call, the Queues cap). Emits
 * `aeci.ownership_sync.enqueue{outcome,reason}`: `ok`, `failed` (warns too) or
 * `unbound` (no queue binding on this Worker, warns too).
 */
export async function enqueueOwnershipSync(
  target: { env: Env; ctx: WaitUntil; request: Request },
  vendorIds: readonly string[],
  reason: OwnershipSyncReason,
  now: Date = new Date(),
): Promise<void> {
  const ids = [...new Set(vendorIds)];
  if (ids.length === 0) return;
  const { env, ctx, request } = target;
  const count = (outcome: 'ok' | 'failed' | 'unbound', n: number) =>
    submitCount(ctx, env, request, 'aeci.ownership_sync.enqueue', n, [
      `outcome:${outcome}`,
      `reason:${reason}`,
    ]);
  const queue = env.OWNERSHIP_SYNC_QUEUE;
  if (!queue) {
    count('unbound', ids.length);
    logToPosthog(ctx, env, request, {
      level: 'warn',
      message: 'aeci.ownership_sync.enqueue: OWNERSHIP_SYNC_QUEUE is not bound; nothing sent',
      reason,
      vendor_ids: ids,
    });
    return;
  }
  const enqueuedAt = now.toISOString();
  const bodies: OwnershipSyncMessage[] = ids.map((vendorId) => ({ vendorId, reason, enqueuedAt }));
  try {
    if (bodies.length === 1) {
      await queue.send(bodies[0]!);
    } else {
      for (let i = 0; i < bodies.length; i += 100) {
        await queue.sendBatch(bodies.slice(i, i + 100).map((body) => ({ body })));
      }
    }
    count('ok', ids.length);
  } catch (error) {
    count('failed', ids.length);
    logToPosthog(ctx, env, request, {
      level: 'warn',
      message:
        'aeci.ownership_sync.enqueue failed; re-send with ops:backfill-ownership-sync (REVIEW_APP_PROMOTE_API.md §4d)',
      reason,
      vendor_ids: ids,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The post-commit hook every producer route calls after its batch commits. Runs the
 * enqueue inside `waitUntil`, so the response does not wait on the queue.
 */
export function dispatchOwnershipSync(
  c: OwnershipSyncProducerContext,
  vendorIds: string | readonly string[],
  reason: OwnershipSyncReason,
): void {
  const ids = typeof vendorIds === 'string' ? [vendorIds] : vendorIds;
  c.executionCtx.waitUntil(
    enqueueOwnershipSync({ env: c.env, ctx: c.executionCtx, request: c.req.raw }, ids, reason),
  );
}

/**
 * The proposal-accept hook (ruled 2026-10-20, D3): one message per OWNED vendor named
 * on the created product, so every owner's record lists it. The owned set is read
 * post-commit, inside `waitUntil`. `always` (the addressed owner, which the accept's
 * sentinel proved owned) is enqueued even if that read fails. One vendor is a
 * `send()`, several are one `sendBatch()` ({@link enqueueOwnershipSync}).
 */
export function dispatchOwnershipSyncToOwned(
  c: OwnershipSyncProducerContext,
  db: Db,
  vendorIds: readonly string[],
  always: string,
  reason: OwnershipSyncReason,
): void {
  const target = { env: c.env, ctx: c.executionCtx, request: c.req.raw };
  c.executionCtx.waitUntil(
    loadOwnedVendorIds(db, vendorIds)
      .then((owned) => [always, ...vendorIds.filter((id) => owned.has(id))])
      .catch((error: unknown) => {
        logToPosthog(c.executionCtx, c.env, c.req.raw, {
          level: 'warn',
          message:
            'aeci.ownership_sync: owned co-vendor read failed; enqueuing the addressed owner only',
          error: error instanceof Error ? error.message : String(error),
        });
        return [always];
      })
      .then((ids) => enqueueOwnershipSync(target, ids, reason)),
  );
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

function chunk<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += ID_CHUNK) out.push(items.slice(i, i + ID_CHUNK));
  return out;
}

/** Ids are lowercase UUIDs, so a binary compare is the order (ANGULAR_STYLE_GUIDE §20a). */
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Build the vendor's whole ownership record from D1. `null` when the vendor row is gone.
 *
 * - `products`: every product joined to the vendor (`product_vendors`), each with its
 *   own owner. A product is `vendor`-owned when ANY joined vendor is owned (Q3).
 * - `integrations`: every `integrations` row whose source or target is one of those
 *   products, and every `connector_evidenced_pairs` row whose `product_a` or
 *   `product_b` is (Q2). The connector side (`powered_by_product_id`,
 *   `connector_product_id`) does not count. Each is `vendor`-owned when either
 *   endpoint product is owned.
 * - `proposals`: every `product_proposals` row addressed to the vendor.
 */
export async function buildOwnershipRecord(
  db: Db,
  vendorId: string,
  reason: OwnershipSyncReason,
  now: Date,
): Promise<OwnershipRecord | null> {
  const vendor = await db.query.vendors.findFirst({
    columns: { id: true, ownedAt: true },
    where: eq(vendors.id, vendorId),
  });
  if (!vendor) return null;

  const [joined, proposalRows] = await Promise.all([
    db
      .select({ productId: productVendors.productId })
      .from(productVendors)
      .where(eq(productVendors.vendorId, vendorId)),
    db
      .select({
        id: productProposals.id,
        ref: productProposals.ref,
        decision: productProposals.decision,
        decidedAt: productProposals.decidedAt,
        createdProductId: productProposals.createdProductId,
      })
      .from(productProposals)
      .where(eq(productProposals.vendorId, vendorId)),
  ]);
  const productIds = [...new Set(joined.map((r) => r.productId))];

  type Edge = { id: string; table: OwnershipIntegration['table']; a: string; b: string };
  const edges = new Map<string, Edge>();
  for (const ids of chunk(productIds)) {
    const [direct, evidenced] = await Promise.all([
      db
        .select({
          id: integrations.id,
          a: integrations.sourceProductId,
          b: integrations.targetProductId,
        })
        .from(integrations)
        .where(
          or(
            inArray(integrations.sourceProductId, ids),
            inArray(integrations.targetProductId, ids),
          ),
        ),
      db
        .select({
          id: connectorEvidencedPairs.id,
          a: connectorEvidencedPairs.productAId,
          b: connectorEvidencedPairs.productBId,
        })
        .from(connectorEvidencedPairs)
        .where(
          or(
            inArray(connectorEvidencedPairs.productAId, ids),
            inArray(connectorEvidencedPairs.productBId, ids),
          ),
        ),
    ]);
    for (const r of direct) edges.set(r.id, { ...r, table: 'integrations' });
    for (const r of evidenced) edges.set(r.id, { ...r, table: 'connector_evidenced_pairs' });
  }

  const endpointIds = new Set<string>(productIds);
  for (const e of edges.values()) {
    endpointIds.add(e.a);
    endpointIds.add(e.b);
  }
  const ownedProducts = await loadOwnedProductIds(db, [...endpointIds]);
  const ownerOf = (ownedFlag: boolean): RecordOwner => (ownedFlag ? 'vendor' : 'aeci');

  const proposals: OwnershipProposal[] = proposalRows
    .map((p) => ({
      id: p.id,
      ref: p.ref,
      state: p.decision ?? ('open' as const),
      decidedAt: p.decidedAt,
      productId: p.createdProductId,
    }))
    .sort(byId);

  return {
    schemaVersion: OWNERSHIP_RECORD_SCHEMA_VERSION,
    vendorId,
    owner: ownerOf(vendor.ownedAt !== null),
    ownedAt: vendor.ownedAt,
    version: now.getTime(),
    asOf: now.toISOString(),
    reason,
    products: productIds.map((id) => ({ id, owner: ownerOf(ownedProducts.has(id)) })).sort(byId),
    integrations: [...edges.values()]
      .map((e) => ({
        id: e.id,
        table: e.table,
        owner: ownerOf(ownedProducts.has(e.a) || ownedProducts.has(e.b)),
      }))
      .sort(byId),
    proposals,
  };
}

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

export interface OwnershipDeliveryDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  dbFor?: DbFactory;
}

interface LedgerRow {
  vendorId: string;
  reason: string;
  messageId: string | null;
  attempt: number;
  outcome: OwnershipSyncOutcome;
  httpStatus?: number | null;
  record?: OwnershipRecord | null;
  error?: string | null;
  durationMs?: number | null;
}

/** One ledger row. Log-class: a plain INSERT outside any batch, and a failure to write
 *  it warns and never changes the delivery's ack or retry. */
async function recordDelivery(
  db: Db | null,
  row: LedgerRow,
  warn: (message: string) => void,
): Promise<void> {
  if (!db) return;
  try {
    await db.insert(ownershipSyncDeliveries).values({
      vendorId: row.vendorId,
      reason: row.reason,
      messageId: row.messageId,
      attempt: row.attempt,
      outcome: row.outcome,
      httpStatus: row.httpStatus ?? null,
      recordVersion: row.record?.version ?? null,
      owner: row.record?.owner ?? null,
      productCount: row.record?.products.length ?? null,
      integrationCount: row.record?.integrations.length ?? null,
      error: row.error ? row.error.slice(0, 500) : null,
      durationMs: row.durationMs ?? null,
    });
  } catch (error) {
    warn(
      `ownership_sync_deliveries insert failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Deliver one message. Acks or retries it itself, and never throws for an operational
 * reason. A D1 read failure is the one case with no ledger row: there is no record,
 * the message is retried, and the warn says why.
 */
export async function deliverOwnershipSync(
  env: Env,
  ctx: ExecutionContext,
  message: Message<unknown>,
  deps: OwnershipDeliveryDeps = {},
): Promise<void> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const dbFor = deps.dbFor ?? getDb;
  const request = new Request('https://aeci-api/queue/ownership-sync');
  const started = Date.now();
  const warn = (msg: string, extra: Record<string, unknown> = {}) =>
    logToPosthog(ctx, env, request, { level: 'warn', message: msg, ...extra });

  const parsed = OwnershipSyncMessageSchema.safeParse(message.body);
  if (!parsed.success) {
    submitCount(ctx, env, request, 'aeci.ownership_sync.delivery', 1, ['outcome:invalid']);
    warn('aeci.ownership_sync: dropped a message that is not an OwnershipSyncMessage', {
      issues: parsed.error.issues.map((i) => i.message),
    });
    message.ack();
    return;
  }
  const { vendorId, reason } = parsed.data;
  const base = {
    vendorId,
    reason,
    messageId: message.id ?? null,
    attempt: message.attempts,
  };
  const finish = async (row: Omit<LedgerRow, keyof typeof base>, db: Db | null) => {
    await recordDelivery(db, { ...base, ...row, durationMs: Date.now() - started }, (m) => warn(m));
    submitCount(ctx, env, request, 'aeci.ownership_sync.delivery', 1, [
      `outcome:${row.outcome}`,
      `reason:${reason}`,
    ]);
  };

  let db: Db | null = null;
  try {
    db = dbFor(env, { constraint: 'first-primary' }).db;
  } catch {
    db = null;
  }

  const url = env.REVIEW_APP_OWNERSHIP_URL?.trim();
  const token = env.REVIEW_APP_OWNERSHIP_TOKEN?.trim();
  if (!url || !token) {
    await finish(
      {
        outcome: 'unconfigured',
        error: !url ? 'REVIEW_APP_OWNERSHIP_URL unset' : 'REVIEW_APP_OWNERSHIP_TOKEN unset',
      },
      db,
    );
    warn(
      'aeci.ownership_sync: receiver not configured on this tier; record not sent (REVIEW_APP_PROMOTE_API.md §4d)',
      { vendor_id: vendorId, reason },
    );
    message.ack();
    return;
  }

  let record: OwnershipRecord | null;
  try {
    if (!db) throw new Error('D1 binding `DB` is not configured');
    record = await buildOwnershipRecord(db, vendorId, reason, now());
  } catch (error) {
    submitCount(ctx, env, request, 'aeci.ownership_sync.delivery', 1, [
      'outcome:read_failed',
      `reason:${reason}`,
    ]);
    // On the last allowed attempt the queue drops the message after this retry, so the
    // log is an error there: it is the only record that the vendor was never sent.
    const last = message.attempts > OWNERSHIP_SYNC_MAX_RETRIES;
    logToPosthog(ctx, env, request, {
      level: last ? 'error' : 'warn',
      message: last
        ? 'aeci.ownership_sync: D1 read failed on the last attempt; re-send with ops:backfill-ownership-sync'
        : 'aeci.ownership_sync: D1 read failed; retrying',
      vendor_id: vendorId,
      error: error instanceof Error ? error.message : String(error),
    });
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    return;
  }
  if (!record) {
    await finish({ outcome: 'vendor_missing', error: 'vendor row not found' }, db);
    warn('aeci.ownership_sync: vendor not found; nothing sent', { vendor_id: vendorId });
    message.ack();
    return;
  }

  const lastAttempt = message.attempts > OWNERSHIP_SYNC_MAX_RETRIES;
  const retryOrExhaust = async (httpStatus: number | null, error: string) => {
    if (lastAttempt) {
      await finish({ outcome: 'exhausted', httpStatus, record, error }, db);
      logToPosthog(ctx, env, request, {
        level: 'error',
        message:
          'aeci.ownership_sync: delivery exhausted its retries; re-send with ops:backfill-ownership-sync',
        vendor_id: vendorId,
        http_status: httpStatus,
        error,
      });
      message.ack();
      return;
    }
    await finish({ outcome: 'retry', httpStatus, record, error }, db);
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
  };

  let res: Response;
  try {
    res = await doFetch(ownershipRecordUrl(url, vendorId), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(OWNERSHIP_SYNC_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const cause =
      name === 'TimeoutError' || name === 'AbortError'
        ? `timeout after ${OWNERSHIP_SYNC_TIMEOUT_MS} ms`
        : `network: ${error instanceof Error ? error.message : String(error)}`;
    await retryOrExhaust(null, cause);
    return;
  }
  // The status is the whole answer. The body is never read, on any path.
  discardResponseBody(res);

  const outcome = classifyStatus(res.status);
  switch (outcome) {
    case 'delivered':
    case 'stale':
      await finish({ outcome, httpStatus: res.status, record }, db);
      message.ack();
      return;
    case 'retry':
      await retryOrExhaust(res.status, `HTTP ${res.status}`);
      return;
    case 'permanent':
      await finish({ outcome, httpStatus: res.status, record, error: `HTTP ${res.status}` }, db);
      warn('aeci.ownership_sync: receiver refused the record; not retried', {
        vendor_id: vendorId,
        http_status: res.status,
      });
      message.ack();
      return;
  }
}

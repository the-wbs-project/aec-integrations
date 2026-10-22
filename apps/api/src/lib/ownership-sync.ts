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
 *      state, and the receiver's `version` check drops anything older. The record is
 *      v1 (ids and owners) or, when `REVIEW_APP_MIRROR_SCHEMA` is `"2"`, v2 with the
 *      content of every vendor-owned record ({@link buildOwnershipRecordV2},
 *      AECI-1413, ADR 0044).
 *
 * Every attempt writes one `ownership_sync_deliveries` row (log-class, ADR 0022
 * 2026-10-20 amendment) and one `aeci.ownership_sync.delivery` count. Every response
 * body is released unread with `discardResponseBody`, on every path: the receiver's
 * status code is the whole answer.
 */

import {
  computeOwnershipRecordHash,
  OWNERSHIP_RECORD_SCHEMA_V1,
  OWNERSHIP_RECORD_SCHEMA_V2,
  OWNERSHIP_RECORD_SCHEMA_VERSION,
  OwnershipClaimSchema,
  ownershipClaimKey,
  OwnershipIntegrationContentSchema,
  OwnershipProductContentSchema,
  OwnershipRecordV2Schema,
  OwnershipSyncMessageSchema,
  OwnershipVendorContentSchema,
  ownershipRecordUrl,
  type OwnershipClaim,
  type OwnershipIntegration,
  type OwnershipIntegrationContent,
  type OwnershipProductContent,
  type OwnershipProposal,
  type OwnershipRecord,
  type OwnershipRecordSchemaVersion,
  type OwnershipRecordV2,
  type OwnershipSyncMessage,
  type OwnershipSyncReason,
  type OwnershipVendorContent,
  type RecordOwner,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { discardResponseBody } from '@aeci/shared/response-drain';
import { and, asc, eq, inArray, isNotNull, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import { getDb, type Db } from '../db/client';
import {
  attestations,
  claims,
  connectorEvidencedPairs,
  integrations,
  integrationVendorLinks,
  ownershipSyncDeliveries,
  productAudiences,
  productCategories,
  productPhases,
  productProposals,
  products,
  productTrades,
  productVendors,
  productVersions,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyDataObjects,
  taxonomyPhases,
  taxonomyTrades,
  vendors,
  type OwnershipSyncOutcome,
} from '../db/schema';
import type { Env } from '../env';
import { logToPosthog, submitCount } from '../posthog';
import { loadOwnedProductIds, loadOwnedVendorIds } from './claimed-vendors';
import type { BatchStmt, BatchTuple } from './audit';
import { VERSION_ORDER } from './drizzle-helpers';
import type { DbFactory } from './handler-utils';
import { projectRow } from './review-mirror-fields';

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

/**
 * The record schema this tier sends (AECI-1413). Read from the per-env wrangler var
 * `REVIEW_APP_MIRROR_SCHEMA`: exactly `"2"` selects v2, anything else (unset, `"1"`,
 * a typo) is v1. Failing to v1 is the safe direction: the live receiver accepts v1
 * and answers 400 to a shape it does not know, which the consumer drops as permanent.
 */
export function mirrorSchemaVersion(env: Pick<Env, 'REVIEW_APP_MIRROR_SCHEMA'>): 1 | 2 {
  return env.REVIEW_APP_MIRROR_SCHEMA?.trim() === '2' ? 2 : 1;
}

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
// The content-edit hook (AECI-1413)
// ---------------------------------------------------------------------------

/** Who made a content edit. Picks the message reason: `vendor_edit` or `admin_edit`. */
export type MirrorEditOrigin = 'vendor' | 'admin';

/** The ids a write's audit entries name, by kind. */
export interface MirrorTargets {
  vendorIds: string[];
  productIds: string[];
  /** `integrations` or `connector_evidenced_pairs` ids. Both tables are read for each. */
  edgeIds: string[];
}

function metadataIntegrationId(entry: AuditLogEntry): string | null {
  const meta = entry.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const value = (meta as { integrationId?: unknown }).integrationId;
  return typeof value === 'string' && value ? value : null;
}

/**
 * The records a write touched, read from its audit entries:
 *
 * - `vendor` names a vendor, `product` a product, `integration` and
 *   `connector_evidenced_pair` an edge.
 * - `product_version` names its product through the entry's `productId`.
 * - `claim` and `attestation` name their integration through `metadata.integrationId`.
 *   The v2 record carries versions and claims, so these edits change it too.
 *
 * Every other entity type (seats, licenses, notifications, reviews, proposals) is not
 * mirrored content and is ignored.
 */
export function mirrorTargets(entries: readonly AuditLogEntry[]): MirrorTargets {
  const vendorIds = new Set<string>();
  const productIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const entry of entries) {
    const entityId = entry.entityId ?? null;
    switch (entry.entityType) {
      case 'vendor':
        if (entityId) vendorIds.add(entityId);
        break;
      case 'product':
        if (entityId) productIds.add(entityId);
        break;
      case 'integration':
      case 'connector_evidenced_pair':
        if (entityId) edgeIds.add(entityId);
        break;
      case 'product_version':
        if (entry.productId) productIds.add(entry.productId);
        break;
      case 'claim':
      case 'attestation': {
        const integrationId = metadataIntegrationId(entry);
        if (integrationId) edgeIds.add(integrationId);
        break;
      }
      default:
        break;
    }
  }
  return { vendorIds: [...vendorIds], productIds: [...productIds], edgeIds: [...edgeIds] };
}

/** Edge ids per resolution read. Each chunk is bound four times, under D1's 100 cap. */
const MIRROR_EDGE_CHUNK = 20;

/**
 * Resolve the targets to the OWNED vendors whose record they sit in, in ONE D1 round
 * trip (a `db.batch` of reads):
 *
 * - a vendor id counts when that vendor is owned;
 * - a product id resolves to every owned vendor joined to it (`product_vendors`);
 * - an edge id resolves to every owned vendor joined to its source or target product
 *   (`integrations`), or to its `product_a` or `product_b`
 *   (`connector_evidenced_pairs`). The connector and `powered_by` products do not
 *   count, as in {@link buildOwnershipRecord}.
 */
export async function resolveMirrorVendorIds(db: Db, targets: MirrorTargets): Promise<string[]> {
  const ownedJoinedTo = (where: SQL | undefined) =>
    db
      .selectDistinct({ vendorId: productVendors.vendorId })
      .from(productVendors)
      .innerJoin(vendors, and(eq(vendors.id, productVendors.vendorId), isNotNull(vendors.ownedAt)))
      .where(where);

  const reads: BatchStmt[] = [];
  for (const ids of chunk(targets.vendorIds)) {
    reads.push(
      db
        .select({ vendorId: vendors.id })
        .from(vendors)
        .where(and(inArray(vendors.id, ids), isNotNull(vendors.ownedAt))),
    );
  }
  for (const ids of chunk(targets.productIds)) {
    reads.push(ownedJoinedTo(inArray(productVendors.productId, ids)));
  }
  for (let i = 0; i < targets.edgeIds.length; i += MIRROR_EDGE_CHUNK) {
    const ids = targets.edgeIds.slice(i, i + MIRROR_EDGE_CHUNK);
    const direct = (end: 'sourceProductId' | 'targetProductId') =>
      inArray(
        productVendors.productId,
        db
          .select({ id: integrations[end] })
          .from(integrations)
          .where(inArray(integrations.id, ids)),
      );
    const evidenced = (end: 'productAId' | 'productBId') =>
      inArray(
        productVendors.productId,
        db
          .select({ id: connectorEvidencedPairs[end] })
          .from(connectorEvidencedPairs)
          .where(inArray(connectorEvidencedPairs.id, ids)),
      );
    reads.push(
      ownedJoinedTo(
        or(
          direct('sourceProductId'),
          direct('targetProductId'),
          evidenced('productAId'),
          evidenced('productBId'),
        ),
      ),
    );
  }
  if (reads.length === 0) return [];
  const results = (await db.batch(reads as BatchTuple)) as { vendorId: string }[][];
  return [...new Set(results.flat().map((row) => row.vendorId))];
}

/**
 * The content-edit hook (AECI-1413). After a write commits, re-send the record of
 * every OWNED vendor the write touched, so the review app's read-only copy follows
 * the live edit. Runs inside `waitUntil` and never throws: the write already
 * committed, and the backfill (`ops:backfill-ownership-sync`) re-sends any vendor.
 *
 * Reason `vendor_edit` or `admin_edit`, per `origin`. The message is the same pointer
 * every producer sends. The consumer reads the whole record at delivery.
 *
 * `db` is the caller's request client when it has one. Without it the hook opens a
 * `first-primary` session, so the read sees the write that just committed.
 *
 * Skips without a D1 read when:
 *
 * - the tier sends v1 ({@link mirrorSchemaVersion}). The new reasons are not in the
 *   live receiver's v1 vocabulary, and a body it cannot parse is a 400, which the
 *   consumer drops as permanent. A v1 record carries no content either, so a v1 tier
 *   loses nothing by not sending. The hook goes live with the `"2"` flip.
 * - the write touched no mirrored entity.
 * - this Worker has no `OWNERSHIP_SYNC_QUEUE` binding. Every ownership producer
 *   already reports an unbound tier, and `wrangler-ownership-sync.spec.ts` gates it.
 */
export function dispatchMirrorSync(
  c: OwnershipSyncProducerContext,
  auditEntries: AuditLogEntry | readonly AuditLogEntry[],
  origin: MirrorEditOrigin,
  db?: Db,
): void {
  const entries: readonly AuditLogEntry[] = Array.isArray(auditEntries)
    ? auditEntries
    : [auditEntries as AuditLogEntry];
  const targets = mirrorTargets(entries);
  const empty = targets.vendorIds.length + targets.productIds.length + targets.edgeIds.length === 0;
  if (mirrorSchemaVersion(c.env) !== 2 || empty || !c.env.OWNERSHIP_SYNC_QUEUE) return;
  const reason: OwnershipSyncReason = origin === 'vendor' ? 'vendor_edit' : 'admin_edit';
  const target = { env: c.env, ctx: c.executionCtx, request: c.req.raw };
  c.executionCtx.waitUntil(
    (async () => {
      let vendorIds: string[];
      try {
        const client = db ?? getDb(c.env, { constraint: 'first-primary' }).db;
        vendorIds = await resolveMirrorVendorIds(client, targets);
      } catch (error) {
        logToPosthog(c.executionCtx, c.env, c.req.raw, {
          level: 'warn',
          message:
            'aeci.ownership_sync: owned-vendor read for a content edit failed; nothing enqueued (re-send with ops:backfill-ownership-sync)',
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      // Never rejects: a send failure is counted and warned inside.
      await enqueueOwnershipSync(target, vendorIds, reason);
    })(),
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

/** Binary string order: ids, slugs, enums and timestamps (ANGULAR_STYLE_GUIDE §20a). */
function compareBinary(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Ids are lowercase UUIDs, so a binary compare is the order (ANGULAR_STYLE_GUIDE §20a). */
const byId = (a: { id: string }, b: { id: string }) => compareBinary(a.id, b.id);

type Edge = { id: string; table: OwnershipIntegration['table']; a: string; b: string };

/** What both schema versions are built from: who owns what, without content. */
interface OwnershipSkeleton {
  ownedAt: string | null;
  /** Every product joined to the vendor, unsorted. */
  productIds: string[];
  /** Every edge whose source/target (or `product_a`/`product_b`) is one of them. */
  edges: Edge[];
  /** The owned subset of every product id above and every edge endpoint. */
  ownedProducts: Set<string>;
  proposals: OwnershipProposal[];
}

/**
 * Read the ownership skeleton both builders share. `null` when the vendor row is gone.
 * The sets are the ones {@link buildOwnershipRecord} documents.
 */
async function readOwnershipSkeleton(db: Db, vendorId: string): Promise<OwnershipSkeleton | null> {
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
    ownedAt: vendor.ownedAt,
    productIds,
    edges: [...edges.values()],
    ownedProducts,
    proposals,
  };
}

const ownerOf = (ownedFlag: boolean): RecordOwner => (ownedFlag ? 'vendor' : 'aeci');

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
 *
 * `schemaVersion` picks the shape (AECI-1413). The consumer passes
 * {@link mirrorSchemaVersion} of its env. 1, the default, is the frozen AECI-1418
 * record. 2 is {@link buildOwnershipRecordV2}: the same sets plus content.
 */
export async function buildOwnershipRecord(
  db: Db,
  vendorId: string,
  reason: OwnershipSyncReason,
  now: Date,
  schemaVersion: OwnershipRecordSchemaVersion = OWNERSHIP_RECORD_SCHEMA_V1,
): Promise<OwnershipRecord | null> {
  if (schemaVersion === OWNERSHIP_RECORD_SCHEMA_V2) {
    return buildOwnershipRecordV2(db, vendorId, reason, now);
  }
  const skel = await readOwnershipSkeleton(db, vendorId);
  if (!skel) return null;
  return {
    schemaVersion: OWNERSHIP_RECORD_SCHEMA_VERSION,
    vendorId,
    owner: ownerOf(skel.ownedAt !== null),
    ownedAt: skel.ownedAt,
    version: now.getTime(),
    asOf: now.toISOString(),
    reason,
    products: skel.productIds
      .map((id) => ({ id, owner: ownerOf(skel.ownedProducts.has(id)) }))
      .sort(byId),
    integrations: skel.edges
      .map((e) => ({
        id: e.id,
        table: e.table,
        owner: ownerOf(skel.ownedProducts.has(e.a) || skel.ownedProducts.has(e.b)),
      }))
      .sort(byId),
    proposals: skel.proposals,
  };
}

// ── v2 content (AECI-1413, ADR 0044) ─────────────────────────────────────────────

/** A placeholder that satisfies `RecordHashSchema` while the record is parsed, before
 *  its real hash is known. Never sent. */
const HASH_PLACEHOLDER = '0'.repeat(64);

/** Read one owned vendor's own fields through the field map. */
async function readVendorContent(db: Db, vendorId: string): Promise<OwnershipVendorContent> {
  const row = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) });
  if (!row) throw new Error(`ownership record v2: vendor ${vendorId} vanished mid-read`);
  return OwnershipVendorContentSchema.parse(projectRow('vendor', row));
}

/** Group `{ productId, slug }` rows into sorted slug lists per product. */
function slugsByProduct(rows: readonly { productId: string; slug: string }[]) {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r.productId) ?? [];
    list.push(r.slug);
    out.set(r.productId, list);
  }
  for (const list of out.values()) list.sort(compareBinary);
  return out;
}

/**
 * Read the content of the given products through the field map: the row, the four
 * taxonomy slug lists and the ordered versions. One `db.batch` per 40 ids. Throws when
 * a product row is gone, so the delivery retries and the next read is whole.
 */
async function readProductContent(
  db: Db,
  productIds: readonly string[],
): Promise<Map<string, OwnershipProductContent>> {
  const out = new Map<string, OwnershipProductContent>();
  for (const ids of chunk(productIds)) {
    const [rows, categories, audiences, phases, trades, versions] = await db.batch([
      db.select().from(products).where(inArray(products.id, ids)),
      db
        .select({ productId: productCategories.productId, slug: taxonomyCategories.slug })
        .from(productCategories)
        .innerJoin(taxonomyCategories, eq(taxonomyCategories.id, productCategories.categoryId))
        .where(inArray(productCategories.productId, ids)),
      db
        .select({ productId: productAudiences.productId, slug: taxonomyAudiences.slug })
        .from(productAudiences)
        .innerJoin(taxonomyAudiences, eq(taxonomyAudiences.id, productAudiences.audienceId))
        .where(inArray(productAudiences.productId, ids)),
      db
        .select({ productId: productPhases.productId, slug: taxonomyPhases.slug })
        .from(productPhases)
        .innerJoin(taxonomyPhases, eq(taxonomyPhases.id, productPhases.phaseId))
        .where(inArray(productPhases.productId, ids)),
      db
        .select({ productId: productTrades.productId, slug: taxonomyTrades.slug })
        .from(productTrades)
        .innerJoin(taxonomyTrades, eq(taxonomyTrades.id, productTrades.tradeId))
        .where(inArray(productTrades.productId, ids)),
      db
        .select({
          productId: productVersions.productId,
          label: productVersions.label,
          releasedAt: productVersions.releasedAt,
          sunsetAt: productVersions.sunsetAt,
        })
        .from(productVersions)
        .where(inArray(productVersions.productId, ids))
        .orderBy(asc(productVersions.productId), ...VERSION_ORDER),
    ]);
    const cats = slugsByProduct(categories);
    const auds = slugsByProduct(audiences);
    const phs = slugsByProduct(phases);
    const trs = slugsByProduct(trades);
    const vers = new Map<string, OwnershipProductContent['versions']>();
    for (const v of versions) {
      const list = vers.get(v.productId) ?? [];
      list.push({ label: v.label, releasedAt: v.releasedAt, sunsetAt: v.sunsetAt });
      vers.set(v.productId, list);
    }
    const byProduct = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const row = byProduct.get(id);
      if (!row) throw new Error(`ownership record v2: product ${id} vanished mid-read`);
      const projected = projectRow('product', {
        ...row,
        categories: cats.get(id) ?? [],
        audiences: auds.get(id) ?? [],
        phases: phs.get(id) ?? [],
        trades: trs.get(id) ?? [],
        versions: vers.get(id) ?? [],
      });
      out.set(id, OwnershipProductContentSchema.parse(projected));
    }
  }
  return out;
}

const introducedVersion = alias(productVersions, 'mirror_introduced_version');
const deprecatedVersion = alias(productVersions, 'mirror_deprecated_version');

/** Every attestation, live or retracted, on the claims anchored to `anchor IN ids`. */
function attestationRowsQuery(
  db: Db,
  anchor: typeof claims.integrationId | typeof claims.connectorEvidencedPairId,
  ids: string[],
) {
  return (
    db
      .select({
        anchorId: anchor,
        dataObject: taxonomyDataObjects.slug,
        direction: claims.direction,
        attestationId: attestations.id,
        source: attestations.source,
        asserted: attestations.asserted,
        note: attestations.note,
        introducedVersion: introducedVersion.label,
        deprecatedVersion: deprecatedVersion.label,
        retractedAt: attestations.retractedAt,
        createdAt: attestations.createdAt,
      })
      .from(attestations)
      .innerJoin(claims, eq(claims.id, attestations.claimId))
      .innerJoin(taxonomyDataObjects, eq(taxonomyDataObjects.id, claims.dataObjectId))
      .leftJoin(introducedVersion, eq(introducedVersion.id, attestations.introducedVersionId))
      .leftJoin(deprecatedVersion, eq(deprecatedVersion.id, attestations.deprecatedVersionId))
      // `anchor_id` leads `claims_identity_key`; the two anchor columns have no index of
      // their own. The `anchor` filter keeps a claim on the other table out.
      .where(and(inArray(claims.anchorId, ids), isNotNull(anchor)))
  );
}

type AttestationRow = Awaited<ReturnType<typeof attestationRowsQuery>>[number];

/**
 * True when `a` should stand for its slot over `b`: the live attestation always wins
 * (the partial unique index allows one), else the latest retraction. `created_at` then
 * `id` break a tie, binary, so the pick does not depend on row order.
 */
function standsOver(a: AttestationRow, b: AttestationRow): boolean {
  if ((a.retractedAt === null) !== (b.retractedAt === null)) return a.retractedAt === null;
  const keys: [string, string][] = [
    [a.retractedAt ?? '', b.retractedAt ?? ''],
    [a.createdAt, b.createdAt],
    [a.attestationId, b.attestationId],
  ];
  for (const [x, y] of keys) {
    const c = compareBinary(x, y);
    if (c !== 0) return c > 0;
  }
  return false;
}

/**
 * One claim slot per natural key `{ dataObject, direction, source }`, per anchor: the
 * slot's live attestation, or its latest retracted one when none is live. Sorted by
 * natural key, binary.
 */
function claimSlotsByAnchor(rows: readonly AttestationRow[]): Map<string, OwnershipClaim[]> {
  const slots = new Map<string, Map<string, AttestationRow>>();
  for (const row of rows) {
    if (row.anchorId === null) continue;
    const perAnchor = slots.get(row.anchorId) ?? new Map<string, AttestationRow>();
    slots.set(row.anchorId, perAnchor);
    const key = ownershipClaimKey({
      dataObject: row.dataObject,
      direction: row.direction as OwnershipClaim['direction'],
      source: row.source as OwnershipClaim['source'],
    });
    const held = perAnchor.get(key);
    if (!held || standsOver(row, held)) perAnchor.set(key, row);
  }
  const out = new Map<string, OwnershipClaim[]>();
  for (const [anchorId, perAnchor] of slots) {
    out.set(
      anchorId,
      [...perAnchor.entries()]
        .sort(([a], [b]) => compareBinary(a, b))
        .map(([, row]) => OwnershipClaimSchema.parse(projectRow('claim', row))),
    );
  }
  return out;
}

interface EdgeContent {
  content: OwnershipIntegrationContent;
  claims: OwnershipClaim[];
}

/**
 * Read the content and claim slots of the given owned edges through the field map.
 * One `db.batch` per 40 ids per table. A pair carries `vendorLinks: []`: the links
 * table references `integrations` rows only. Throws when an edge row is gone, so the
 * delivery retries and the next read is whole.
 */
async function readEdgeContent(db: Db, edges: readonly Edge[]): Promise<Map<string, EdgeContent>> {
  const out = new Map<string, EdgeContent>();
  const missing = (id: string) => new Error(`ownership record v2: edge ${id} vanished mid-read`);

  const integrationIds = edges.filter((e) => e.table === 'integrations').map((e) => e.id);
  for (const ids of chunk(integrationIds)) {
    const [rows, links, attested] = await db.batch([
      db.select().from(integrations).where(inArray(integrations.id, ids)),
      db
        .select({
          integrationId: integrationVendorLinks.integrationId,
          productId: integrationVendorLinks.productId,
          kind: integrationVendorLinks.kind,
          url: integrationVendorLinks.url,
        })
        .from(integrationVendorLinks)
        .where(inArray(integrationVendorLinks.integrationId, ids)),
      attestationRowsQuery(db, claims.integrationId, ids),
    ]);
    const linksBy = new Map<string, OwnershipIntegrationContent['vendorLinks']>();
    for (const l of links) {
      const list = linksBy.get(l.integrationId) ?? [];
      list.push({ productId: l.productId, kind: l.kind as 'listing' | 'docs', url: l.url });
      linksBy.set(l.integrationId, list);
    }
    for (const list of linksBy.values()) {
      list.sort((a, b) => compareBinary(a.productId, b.productId) || compareBinary(a.kind, b.kind));
    }
    const slots = claimSlotsByAnchor(attested);
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const row = rowsById.get(id);
      if (!row) throw missing(id);
      const projected = projectRow('integration', { ...row, vendorLinks: linksBy.get(id) ?? [] });
      out.set(id, {
        content: OwnershipIntegrationContentSchema.parse(projected),
        claims: slots.get(id) ?? [],
      });
    }
  }

  const pairIds = edges.filter((e) => e.table === 'connector_evidenced_pairs').map((e) => e.id);
  for (const ids of chunk(pairIds)) {
    const [rows, attested] = await db.batch([
      db.select().from(connectorEvidencedPairs).where(inArray(connectorEvidencedPairs.id, ids)),
      attestationRowsQuery(db, claims.connectorEvidencedPairId, ids),
    ]);
    const slots = claimSlotsByAnchor(attested);
    const rowsById = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const row = rowsById.get(id);
      if (!row) throw missing(id);
      const projected = projectRow('connector_evidenced_pair', { ...row, vendorLinks: [] });
      out.set(id, {
        content: OwnershipIntegrationContentSchema.parse(projected),
        claims: slots.get(id) ?? [],
      });
    }
  }
  return out;
}

/**
 * Build the vendor's v2 ownership record (AECI-1413, ADR 0044, §4d): the v1 sets and
 * owners, plus the content of every vendor-owned record, read through the field map
 * (`lib/review-mirror-fields.ts`). `null` when the vendor row is gone.
 *
 * - `vendor`: the vendor's own fields when it is owned, else `null`.
 * - `products[].content`: on every vendor-owned product. An AECi-owned one has none.
 * - `integrations[].content` and `claims`: on every vendor-owned edge. One claim per
 *   natural-key slot: the live attestation, or the latest retracted one.
 * - `recordHash`: `computeOwnershipRecordHash` of the parsed record. It ignores
 *   `reason`, `version` and `asOf`, so the drift check may pass any reason and time.
 *
 * Every entity is parsed through its v2 content schema, then the whole record through
 * `OwnershipRecordV2Schema`. A stored value the contract refuses throws, so the
 * consumer retries and its warn names the field, rather than sending a partial mirror.
 */
export async function buildOwnershipRecordV2(
  db: Db,
  vendorId: string,
  reason: OwnershipSyncReason,
  asOf: Date = new Date(),
): Promise<OwnershipRecordV2 | null> {
  const skel = await readOwnershipSkeleton(db, vendorId);
  if (!skel) return null;
  const vendorOwned = skel.ownedAt !== null;
  const edgeOwned = (e: Edge) => skel.ownedProducts.has(e.a) || skel.ownedProducts.has(e.b);

  const [vendorContent, productContent, edgeContent] = await Promise.all([
    vendorOwned ? readVendorContent(db, vendorId) : Promise.resolve(null),
    readProductContent(
      db,
      skel.productIds.filter((id) => skel.ownedProducts.has(id)),
    ),
    readEdgeContent(db, skel.edges.filter(edgeOwned)),
  ]);

  const parsed = OwnershipRecordV2Schema.parse({
    schemaVersion: OWNERSHIP_RECORD_SCHEMA_V2,
    vendorId,
    owner: ownerOf(vendorOwned),
    ownedAt: skel.ownedAt,
    version: asOf.getTime(),
    asOf: asOf.toISOString(),
    reason,
    vendor: vendorContent,
    products: skel.productIds
      .map((id) => {
        const content = productContent.get(id);
        return content ? { id, owner: ownerOf(true), content } : { id, owner: ownerOf(false) };
      })
      .sort(byId),
    integrations: skel.edges
      .map((e) => {
        const owned = edgeContent.get(e.id);
        return owned
          ? { id: e.id, table: e.table, owner: ownerOf(true), ...owned }
          : { id: e.id, table: e.table, owner: ownerOf(false) };
      })
      .sort(byId),
    proposals: skel.proposals,
    recordHash: HASH_PLACEHOLDER,
  });
  return { ...parsed, recordHash: await computeOwnershipRecordHash(parsed) };
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
      // AECI-1413: the schema of the record this attempt sent and, for v2, its hash.
      // Both null when no record was built. A v1 record has no hash.
      schemaVersion: row.record?.schemaVersion ?? null,
      recordHash:
        row.record?.schemaVersion === OWNERSHIP_RECORD_SCHEMA_V2 ? row.record.recordHash : null,
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
    record = await buildOwnershipRecord(db, vendorId, reason, now(), mirrorSchemaVersion(env));
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

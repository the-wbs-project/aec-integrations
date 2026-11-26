/**
 * A Sync Service's three curated facts (AECI-2046, ruling 15 on AECI-2035,
 * `docs/STAGE_1_5_SPEC.md` §13.13, `docs/ADMIN_PANEL_SPEC.md` §5.7).
 *
 *   PATCH /api/admin/products/:id/sync-facts — behind `requireAdmin()`, then
 *   `rateLimit('write')`.
 *
 * Sets or clears `products.sync_frequency`, `sync_support` and `sync_setup`: how often
 * the Sync Service syncs, who supports it, and how setup works. AECi curates them at
 * first, so only an AECi admin writes them. The vendor does not (a vendor-editable
 * version is a legal `decision` nobody has ruled on). The body carries all three; a
 * blank or `null` value clears one.
 *
 * Only a Sync Service carries them (`isSyncService`). Any other product, including a
 * connector with no kind or an Integration platform, is **409
 * `SYNC_FACTS_NOT_SYNC_SERVICE`** and nothing is written. A later kind change keeps the
 * stored values, and every reader shows them only while the product is a Sync Service
 * (`toSyncServiceBlock`), the way the kind itself survives a role change.
 *
 * Order: body (400) → 404 (unknown product) → 409 (not a Sync Service) → no-op when
 * every value is unchanged (200, `changed: false`, nothing written or purged) → one
 * `db.batch` with a sentinel, the UPDATE and its `product.updated` audit row →
 * post-commit purge and forward.
 *
 * The sentinel runs first in the batch and aborts it unless the product is still a
 * Sync Service, so a promote (role) or a kind write between the read and the batch
 * leaves nothing committed, and the caller gets the same 409 the read would have given.
 *
 * Purge: `product:{slug}`. The facts render on the product page only, which carries
 * that tag. They are on no card, no list and no Algolia record, so neither
 * `index:products` nor a search sync is needed. Promote never writes or clears them:
 * the promote payload has no field for them.
 */

import {
  AdminSetSyncFactsResponseSchema,
  AdminSetSyncFactsSchema,
  ApiErrorCode,
  isSyncService,
  type AdminSetSyncFactsResponse,
  type AuditLogEntry,
  type SyncFacts,
} from '@aeci/shared';
import { and, eq, sql } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { products } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert } from '../lib/audit';
import { productAuditStamp } from '../lib/audit-vendor';
import { auditActorType } from '../lib/authz';
import { isSentinelJsonAbort } from '../lib/field-overrides';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { ONE_ROW } from '../lib/integration-claims';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { parseJsonBody, purgeTags, type VendorContext } from './vendor-shared';

/** The audit `source` facet and forward tag. */
export const SYNC_FACTS_AUDIT_SOURCE = 'admin-panel';

/** The roles `isSyncService` accepts, for the in-batch sentinel. */
const SYNC_SERVICE_ROLES = ['connector', 'hybrid'] as const;

/**
 * A batch statement that ABORTS the batch unless the product is still a Sync Service.
 * The same `json()` abort every sentinel uses: SQLite has no `RAISE()` outside
 * triggers. Selected FROM a one-row constant so it is evaluated exactly once.
 */
function stillSyncServiceSentinel(db: Db, id: string) {
  const roles = sql.join(
    SYNC_SERVICE_ROLES.map((role) => sql`${role}`),
    sql`, `,
  );
  return db
    .select({
      guard: sql`CASE WHEN NOT EXISTS (SELECT 1 FROM ${products}
        WHERE ${and(eq(products.id, id), eq(products.connectorKind, 'sync_service'))}
          AND ${products.productRole} IN (${roles}))
        THEN json('sync-facts-not-sync-service') END`,
    })
    .from(ONE_ROW);
}

function notSyncServiceError(role: string, kind: string | null): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.SYNC_FACTS_NOT_SYNC_SERVICE,
    'Only a Sync Service carries sync facts. Set its connector kind to Sync Service first. Nothing was changed.',
    { details: { product_role: role, connector_kind: kind } },
  );
}

export function createAdminSetSyncFactsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const id = c.req.param('id');
    if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing product id', { field: 'id' });
    const input = await parseJsonBody(c, AdminSetSyncFactsSchema);
    const { db } = writeDb(c, dbFor);

    const [[before], stamp] = await Promise.all([
      db
        .select({
          slug: products.slug,
          productRole: products.productRole,
          connectorKind: products.connectorKind,
          syncFrequency: products.syncFrequency,
          syncSupport: products.syncSupport,
          syncSetup: products.syncSetup,
          syncFactsSourceUrl: products.syncFactsSourceUrl,
          syncFactsRecordedAt: products.syncFactsRecordedAt,
        })
        .from(products)
        .where(eq(products.id, id)),
      productAuditStamp(db, id),
    ]);
    if (!before) throw notFoundError('product', { id });
    if (!isSyncService(before.productRole, before.connectorKind)) {
      throw notSyncServiceError(before.productRole, before.connectorKind ?? null);
    }

    type Written = Omit<SyncFacts, 'recorded_at'>;
    const prior: Written = {
      sync_frequency: before.syncFrequency ?? null,
      sync_support: before.syncSupport ?? null,
      sync_setup: before.syncSetup ?? null,
      source_url: before.syncFactsSourceUrl ?? null,
    };
    const next: Written = {
      sync_frequency: input.sync_frequency,
      sync_support: input.sync_support,
      sync_setup: input.sync_setup,
      source_url: input.source_url,
    };
    const fields = (Object.keys(next) as (keyof Written)[]).filter(
      (key) => prior[key] !== next[key],
    );
    if (fields.length === 0) {
      return respond(c, {
        id,
        ...next,
        recorded_at: before.syncFactsRecordedAt ?? null,
        changed: false,
      });
    }

    const session = c.get('auth');
    const at = new Date().toISOString();
    // The date the facts were last recorded, for the "marked as ours, with its source
    // and date" line. It clears with the last fact.
    const anyFact = !!(next.sync_frequency || next.sync_support || next.sync_setup);
    const recordedAt = anyFact ? at : null;
    const entry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: 'product.updated',
      entityType: 'product',
      entityId: id,
      ...stamp,
      productId: id,
      beforeState: Object.fromEntries(fields.map((key) => [key, prior[key]])),
      afterState: Object.fromEntries(fields.map((key) => [key, next[key]])),
      metadata: { source: SYNC_FACTS_AUDIT_SOURCE, fields },
    };
    try {
      await db.batch([
        stillSyncServiceSentinel(db, id),
        db
          .update(products)
          .set({
            syncFrequency: next.sync_frequency,
            syncSupport: next.sync_support,
            syncSetup: next.sync_setup,
            syncFactsSourceUrl: next.source_url,
            syncFactsRecordedAt: recordedAt,
            updatedAt: at,
          })
          .where(eq(products.id, id)),
        auditInsert(db, entry),
      ]);
    } catch (error) {
      // Nothing committed: a promote or a kind write moved the product off Sync Service
      // between the read and the batch. Re-read and refuse as the read would have.
      if (isSentinelJsonAbort(error)) {
        const [now] = await db
          .select({ productRole: products.productRole, connectorKind: products.connectorKind })
          .from(products)
          .where(eq(products.id, id));
        throw notSyncServiceError(
          now?.productRole ?? before.productRole,
          now?.connectorKind ?? null,
        );
      }
      throw error;
    }

    c.executionCtx.waitUntil(purgeTags(c, [`product:${before.slug}`], 'moderation'));
    forwardAuditBatch(c, [entry], [], SYNC_FACTS_AUDIT_SOURCE);
    return respond(c, { id, ...next, recorded_at: recordedAt, changed: true });
  };
}

function respond(c: VendorContext, body: AdminSetSyncFactsResponse): Response {
  validateResponseInDev(c.env, () => {
    AdminSetSyncFactsResponseSchema.parse(body);
  });
  return json(body);
}

/**
 * The connector kind write (AECI-2036, `docs/STAGE_1_5_SPEC.md` §13.13,
 * `docs/ADMIN_PANEL_SPEC.md` §5.7).
 *
 *   PATCH /api/admin/products/:id/connector-kind — behind `requireAdmin()`, then
 *   `rateLimit('write')`.
 *
 * Sets or clears `products.connector_kind`: Integration platform or Sync Service
 * (AECI-2035 rulings 1 and 3). Only a `connector` or `hybrid` product takes a kind.
 * An `application` is **409 `CONNECTOR_KIND_NOT_CONNECTOR`** and nothing is written.
 *
 * Order: body (400) → 404 (unknown product) → 409 (wrong role) → no-op when the value
 * is unchanged (200, `changed: false`, nothing written or purged) → 409
 * `CONNECTOR_KIND_SUBSCRIBED` → one `db.batch` with the UPDATE and its
 * `product.updated` audit row → post-commit purge and forward.
 *
 * ── A SUBSCRIBED PRODUCT KEEPS A KIND THAT CAN HOLD IT (AECI-2044, ruling 6) ──
 * A Sync Service may hold a Managed subscription. An Integration platform, or a
 * connector with no kind, may not (`productTakesSubscription`). A change that would
 * take a product from may-hold to may-not while a live subscription sits on it (any
 * vendor's) is refused with **409 `CONNECTOR_KIND_SUBSCRIBED`** and nothing is written.
 * The operator moves or ends the subscription first. A hybrid is never refused, because
 * every hybrid may hold one. A change between two kinds that both refuse is allowed: it
 * moves no product across the line, and a subscription that predates the rule stays.
 * When the check applies, {@link noLiveSubscriptionSentinel} also runs in the batch, so
 * an assign that commits after the read aborts the change.
 *
 * A promote can move the product to `application` between the read and the batch.
 * {@link roleStillTakesKindSentinel} runs first in the batch and aborts it in that
 * case, so neither the UPDATE nor its audit row commits, and the caller gets the same
 * 409 the read would have given.
 *
 * Purge: `product:{slug}` and `index:products`, the logo PATCH's set. Every page that
 * shows the product (its page, browse grids, the vendor page, pair pages and the
 * connector hub) already embeds `product:{slug}` (`CACHE_STRATEGY.md` §3 rule 2).
 *
 * Search (AECI-1662): the product's Algolia record carries the kind, for the
 * "Connector type" filter and the card chip. So the write re-indexes that one record by
 * id after commit, behind promote's `dispatchHook` watchdog, as the field-override
 * write does. A failed sync is logged and the 08:00 UTC sync is the backstop: the
 * UPDATE stamps `updated_at`, so the record is in that night's window.
 *
 * Not done here on purpose: no review-app mirror (the review app does not carry the
 * kind), no vendor notice (the kind is AECi's classification, not a vendor value it
 * overwrites).
 */

import {
  AdminSetConnectorKindResponseSchema,
  AdminSetConnectorKindSchema,
  ApiErrorCode,
  CONNECTOR_KIND_ROLES,
  productTakesSubscription,
  roleTakesConnectorKind,
  type AdminSetConnectorKindResponse,
  type AuditLogEntry,
} from '@aeci/shared';
import { eq, sql } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { products } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert } from '../lib/audit';
import { productAuditStamp } from '../lib/audit-vendor';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { isSentinelJsonAbort } from '../lib/field-overrides';
import { ONE_ROW } from '../lib/integration-claims';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { liveSubscriptionOn, noLiveSubscriptionSentinel } from '../lib/subscribable-products';
import { dispatchOwnerWriteSearch, syncOwnerWriteSearch } from './integration-retire-write';
import { parseJsonBody, purgeTags, type VendorContext } from './vendor-shared';

/** The audit `source` facet and forward tag. */
export const CONNECTOR_KIND_AUDIT_SOURCE = 'admin-panel';

/** The post-commit hook that re-indexes the product's search record (AECI-1662). */
export const CONNECTOR_KIND_ALGOLIA_HOOK = 'admin-connector-kind-algolia';

/**
 * A batch statement that ABORTS the batch unless the product still has a role that
 * takes a kind. The same `json()` abort every sentinel uses (`fieldsUnlockedSentinel`):
 * SQLite has no `RAISE()` outside triggers. Selected FROM a one-row constant so it is
 * evaluated exactly once.
 */
function roleStillTakesKindSentinel(db: Db, id: string) {
  const roles = sql.join(
    CONNECTOR_KIND_ROLES.map((role) => sql`${role}`),
    sql`, `,
  );
  return db
    .select({
      guard: sql`CASE WHEN NOT EXISTS (SELECT 1 FROM ${products}
        WHERE ${products.id} = ${id} AND ${products.productRole} IN (${roles}))
        THEN json('connector-kind-role-changed') END`,
    })
    .from(ONE_ROW);
}

function subscribedError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.CONNECTOR_KIND_SUBSCRIBED,
    'This product holds a live Managed subscription, and that kind cannot hold one. Move or end the subscription first. Nothing was changed.',
  );
}

function notConnectorError(role: string): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.CONNECTOR_KIND_NOT_CONNECTOR,
    'Only a connector or hybrid product has a connector kind.',
    { details: { product_role: role } },
  );
}

export function createAdminSetConnectorKindHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const id = c.req.param('id');
    if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing product id', { field: 'id' });
    const input = await parseJsonBody(c, AdminSetConnectorKindSchema);
    const { db } = writeDb(c, dbFor);

    const [[before], stamp] = await Promise.all([
      db
        .select({
          slug: products.slug,
          productRole: products.productRole,
          connectorKind: products.connectorKind,
        })
        .from(products)
        .where(eq(products.id, id)),
      productAuditStamp(db, id),
    ]);
    if (!before) throw notFoundError('product', { id });
    if (!roleTakesConnectorKind(before.productRole)) throw notConnectorError(before.productRole);

    const next = input.connector_kind;
    if ((before.connectorKind ?? null) === next) {
      return respond(c, { id, connector_kind: next, changed: false });
    }

    // AECI-2044: only a change across the line needs the subscription check.
    const leavesSubscribable =
      productTakesSubscription(before.productRole, before.connectorKind) &&
      !productTakesSubscription(before.productRole, next);
    if (leavesSubscribable && (await liveSubscriptionOn(db, id))) throw subscribedError();

    const session = c.get('auth');
    const at = new Date().toISOString();
    const entry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: 'product.updated',
      entityType: 'product',
      entityId: id,
      ...stamp,
      productId: id,
      beforeState: { connectorKind: before.connectorKind ?? null },
      afterState: { connectorKind: next },
      metadata: { source: CONNECTOR_KIND_AUDIT_SOURCE, fields: ['connector_kind'] },
    };
    try {
      await db.batch([
        roleStillTakesKindSentinel(db, id),
        ...(leavesSubscribable ? [noLiveSubscriptionSentinel(db, id)] : []),
        db.update(products).set({ connectorKind: next, updatedAt: at }).where(eq(products.id, id)),
        auditInsert(db, entry),
      ]);
    } catch (error) {
      // Nothing committed. Either a promote moved the product off a connector role, or
      // (AECI-2044) a subscription landed on it, between the read and the batch. Both
      // sentinels abort the same way, so re-read and refuse as the read would have.
      if (isSentinelJsonAbort(error)) {
        if (leavesSubscribable && (await liveSubscriptionOn(db, id))) throw subscribedError();
        throw notConnectorError('application');
      }
      throw error;
    }

    const tags = [`product:${before.slug}`, 'index:products'];
    c.executionCtx.waitUntil(purgeTags(c, tags, 'moderation'));
    dispatchOwnerWriteSearch(
      c,
      CONNECTOR_KIND_ALGOLIA_HOOK,
      syncOwnerWriteSearch(
        c,
        db,
        { products: [id], vendors: [], integrations: [] },
        'aeci.api.admin.connector_kind_algolia_sync_failed',
      ),
    );
    forwardAuditBatch(c, [entry], [], CONNECTOR_KIND_AUDIT_SOURCE);
    return respond(c, { id, connector_kind: next, changed: true });
  };
}

function respond(c: VendorContext, body: AdminSetConnectorKindResponse): Response {
  validateResponseInDev(c.env, () => {
    AdminSetConnectorKindResponseSchema.parse(body);
  });
  return json(body);
}

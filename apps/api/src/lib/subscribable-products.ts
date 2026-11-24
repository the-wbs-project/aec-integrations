/**
 * Which products may hold a Managed subscription (AECI-2044, ruling 6 on AECI-2035,
 * `STAGE_2_SPEC.md` §8.8, `STAGE_2_PAID_TIERS_SPEC.md` §13.14).
 *
 * An `application` or a `hybrid` may. A `connector` may only when its kind is
 * `sync_service`. An Integration platform, or a connector with no kind, may not, for
 * now. `productTakesSubscription` in `@aeci/shared` is the rule in TypeScript; this
 * module is the same rule in SQL, plus the refusals the write paths share.
 *
 * ── NEW ASSIGNMENTS ONLY ─────────────────────────────────────────────────────
 * The rule refuses a subscription going onto a product. It never ends, moves or
 * strands one that is already there:
 *  - the vendor assign route refuses (`PRODUCT_NOT_SUBSCRIBABLE`);
 *  - the Billing tab's product list and the purchase routes' unused count leave
 *    such products out (`assignableProductsWhere` in `routes/vendor-billing-stripe.ts`);
 *  - checkout, add and the admin grant refuse a vendor that owns products and none
 *    that may hold one (`NO_SUBSCRIBABLE_PRODUCT`). Those three put subscriptions in
 *    the pool, never on a product, so this is the only refusal that fits them;
 *  - the Stripe webhook, the daily reconcile, the lapse and their carry-over keep or
 *    move a product that ALREADY holds a subscription. They are unchanged, so nothing
 *    is stranded or silently dropped;
 *  - the ban-term grant restores the assignment a termination cut, so it is unchanged;
 *  - a promote that changes a licensed product's role leaves its subscription alone;
 *  - the admin kind change is refused when it would take a product that holds a live
 *    subscription from may-hold to may-not (`CONNECTOR_KIND_SUBSCRIBED`,
 *    `routes/admin-connector-kind.ts`).
 */

import { ApiErrorCode } from '@aeci/shared';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { licenses, products, productVendors } from '../db/schema';
import { ApiError } from '../errors';
import type { BatchStmt } from './audit';
import { ONE_ROW } from './integration-claims';

/** The rule as a `WHERE` fragment on `products`. Keep it in step with
 *  `productTakesSubscription`: `subscribable-products.spec.ts` checks the two agree. */
export function subscribableProductSql(): SQL {
  return or(
    inArray(products.productRole, ['application', 'hybrid']),
    and(eq(products.productRole, 'connector'), eq(products.connectorKind, 'sync_service')),
  )!;
}

/** `409 PRODUCT_NOT_SUBSCRIBABLE` for a product the rule refuses. */
export function productNotSubscribableError(
  productRole: string,
  connectorKind: string | null,
): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.PRODUCT_NOT_SUBSCRIBABLE,
    'Managed is not offered for this product. An application, a hybrid or a Sync Service can hold a subscription.',
    { details: { product_role: productRole, connector_kind: connectorKind } },
  );
}

/** `409 NO_SUBSCRIBABLE_PRODUCT`: nothing this vendor owns could hold what it would buy. */
export function noSubscribableProductError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.NO_SUBSCRIBABLE_PRODUCT,
    "None of this company's products can hold a Managed subscription. Nothing was bought or granted.",
  );
}

/**
 * `true` when the vendor owns at least one product and none of them may hold a
 * subscription. A vendor that owns no product at all answers `false`: that is not this
 * rule's case, and the purchase routes' unused-subscriptions warning already covers it.
 */
export async function ownsOnlyUnsubscribableProducts(db: Db, vendorId: string): Promise<boolean> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      subscribable:
        sql<number>`sum(case when ${subscribableProductSql()} then 1 else 0 end)`.mapWith(Number),
    })
    .from(productVendors)
    .innerJoin(products, eq(products.id, productVendors.productId))
    .where(eq(productVendors.vendorId, vendorId));
  const total = row?.total ?? 0;
  return total > 0 && (row?.subscribable ?? 0) === 0;
}

/**
 * A batch statement that ABORTS the batch unless the product may still hold a
 * subscription at that point in the batch. It catches an admin kind change that commits
 * between the assign route's read and its batch. The `json()` abort every sentinel uses;
 * the caller re-reads to tell it from the other sentinels in the same batch.
 */
export function productStillSubscribableSentinel(db: Db, productId: string): BatchStmt {
  return db
    .select({
      guard: sql`CASE WHEN NOT EXISTS (SELECT 1 FROM ${products}
        WHERE ${products.id} = ${productId} AND (${subscribableProductSql()}))
        THEN json('product-not-subscribable') END`,
    })
    .from(ONE_ROW);
}

/**
 * A batch statement that ABORTS the batch when a live subscription sits on the product.
 * The kind change puts it first when its new kind would refuse a subscription, so an
 * assign that commits between the kind route's read and its batch blocks the change.
 */
export function noLiveSubscriptionSentinel(db: Db, productId: string): BatchStmt {
  return db
    .select({
      guard: sql`CASE WHEN EXISTS (SELECT 1 FROM ${licenses}
        WHERE ${licenses.assignedProductId} = ${productId} AND ${isNull(licenses.endedAt)})
        THEN json('product-subscribed') END`,
    })
    .from(ONE_ROW);
}

/** The live subscription on a product, if any (any vendor's, a co-owner's included). */
export async function liveSubscriptionOn(db: Db, productId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: licenses.id })
    .from(licenses)
    .where(and(eq(licenses.assignedProductId, productId), isNull(licenses.endedAt)))
    .limit(1);
  return row !== undefined;
}

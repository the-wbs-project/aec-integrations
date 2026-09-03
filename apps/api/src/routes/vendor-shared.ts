/**
 * The pieces every `/api/vendor/*` handler needs, extracted so more than one
 * route module can share them (AECI-607; `routes/vendor.ts` was the sole home
 * until the version CRUD landed, and §5/AECI-301 adds four more endpoints).
 *
 * `routes/vendor.ts` keeps the full narrative of the surface's invariants in its
 * header — read that first. The short version, because everything here exists to
 * serve it: there is **no RLS on app tables** (ADR 0016), so `requireVendor()`
 * plus a `vendor_id` filter in every query IS the authorization. `vendorId` comes
 * from `c.get('auth')` and never from the request; the one client-supplied id on
 * the surface is a product id, whose ownership is proven **before** anything else
 * is read or written; and a miss is a **404, not a 403**.
 */

import { type AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, inArray, or, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import type { Db } from '../db/client';
import { productVendors, products, profiles, vendorRequests, vendors } from '../db/schema';
import { logBatchToPosthog, logToPosthog, type PosthogLogEvent } from '../posthog';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { VENDOR_ADMIN_ROLE } from '../lib/claimed-vendors';

export type VendorContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

export type VendorRow = typeof vendors.$inferSelect;
export type ProductRow = typeof products.$inferSelect;

/** `metadata.source` on every audit row the vendor portal writes. Distinguishes a
 *  vendor's self-service edit from the AECi-side `product.updated` /
 *  `vendor.updated` that `POST /api/promote` and the admin surfaces emit — the
 *  actor_type is `'user'` for both a reviewer and a vendor admin, so this tag is
 *  what makes the audit trail legible. */
export const AUDIT_SOURCE = 'vendor-portal';

/** The session's vendor id. `requireVendor()` guarantees it is non-null, so a
 *  miss here means the guard was not mounted — fail loudly rather than fall
 *  back to something that would read another vendor's rows. */
export function sessionVendorId(c: VendorContext): string {
  const vendorId = c.get('auth').vendorId;
  if (!vendorId) {
    throw new ApiError(403, 'FORBIDDEN', 'Vendor account is not linked to a vendor');
  }
  return vendorId;
}

/**
 * The §26.5 log envelope for one vendor-portal `audit_log` row. A pure mapper
 * rather than the old `AuditLogForwarder` closure so a write's whole entry set
 * can be posted in ONE request per vendor — see {@link afterVendorWrite}.
 */
export function vendorAuditLogEvent(entry: Omit<AuditLogEntry, 'metadata'>): PosthogLogEvent {
  return {
    level: 'info',
    message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
    action: entry.action,
    entity_type: entry.entityType ?? undefined,
    entity_id: entry.entityId ?? undefined,
    source: AUDIT_SOURCE,
  };
}

export async function parseJsonBody<T>(c: VendorContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  return schema.parse(raw);
}

/**
 * Enqueue the Cache-Tag purge for an edited entity (WC-5 / ADR 0020 §3). The SSR
 * consumer issues the actual `ctx.cache.purge()`. Best-effort by design: no-ops
 * without the queue binding (local / PR preview) and a `queue.send` rejection is
 * logged and swallowed — a cache miss must never fail a committed edit.
 */
export async function purgeTags(c: VendorContext, tags: readonly string[]): Promise<void> {
  const queue = c.env.CACHE_PURGE_QUEUE;
  if (!queue || tags.length === 0) return;
  try {
    await queue.send({ tags: [...tags], source: 'vendor' });
  } catch (error) {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: `Cache purge enqueue failed for ${tags.join(',')}`,
      outcome: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The post-commit tail every vendor write shares: purge, then forward to
 * PostHog. Both best-effort, both outside the batch.
 *
 * `entries` takes an array as well as a single entry because a write may emit
 * more than one `audit_log` row — AECI-301's `POST /api/vendor/claims` writes a
 * `claim.created` plus one `attestation.created` per owned slot, and §26.5 wants
 * every row forwarded, not just the headline one.
 */
export function afterVendorWrite(
  c: VendorContext,
  tags: readonly string[],
  entries: AuditLogEntry | readonly AuditLogEntry[],
): void {
  const list = Array.isArray(entries) ? entries : [entries as AuditLogEntry];
  // ONE request per vendor for the whole entry set, not one per entry
  // (AECI-666). This used to be `Promise.all([purge, ...list.map(forward)])`,
  // and since the §3.1 dual-run fires both legs from the same call site, a claim
  // create — `claim.created` plus one `attestation.created` per owned slot —
  // opened 2N simultaneous connections *alongside* the queue send in the same
  // array. Past the per-invocation connection limit the runtime cancels the
  // stalled responses into `fetch` promises that never settle, so the forwards
  // are lost with no error at all. Each leg self-gates on its own key.
  logBatchToPosthog(c.executionCtx, c.env, c.req.raw, list.map(vendorAuditLogEvent));
  c.executionCtx.waitUntil(purgeTags(c, tags));
}

// ─── Scoping predicates shared by a handler and its freshness cursor ─────────
//
// AECI-627 added `GET /api/vendor/updates`, whose whole job is to report "has
// anything in scope X moved?". That only works if each cursor query reuses the
// scoping predicate of the handler it is a cursor for — a cursor that scopes
// differently from its payload either goes permanently stale (the client never
// learns to refetch) or moves on a row the caller may not see. So the predicates
// below are defined ONCE and imported by both sides rather than retyped.
// The integration-grain equivalent lives in `lib/attestation-authority.ts`
// (`ownedEndpointJoin`), which already owned that rule.

/**
 * The caller's owned product ids, as a **subquery** rather than a fetched list.
 *
 * `createVendorMeHandler` materialises the same set, because it needs `is_primary`
 * alongside the ids and reuses them to hydrate the products payload. The cursor
 * cannot: it has to answer in ONE D1 round trip, and a pre-read to collect ids
 * would double that. Both express `product_vendors WHERE vendor_id = ?`; this is
 * the form that composes into another statement.
 */
/**
 * "The seats on this vendor" — a granted vendor-portal seat is a `profiles` row
 * with BOTH `vendor_id = <vendor>` and `role = 'vendor_admin'`. Shared by the
 * dashboard's `seat_count`, the portal roster and the admin vendor page so the
 * three can never disagree: a `reviewer` profile that happens to carry a
 * `vendor_id` is not a seat.
 *
 * **Banned seats are included** — a ban is a per-seat lock, not a removal, and
 * every one of these surfaces needs to show WHY a colleague cannot sign in.
 * `loadExistingSeats` in `admin-claims.ts` deliberately excludes them instead,
 * because its question is narrower ("does this vendor already have working
 * admins?" — a first-claim vs second-seat signal), not "who is on this account".
 */
export function seatsOf(vendorId: string): SQL | undefined {
  return and(eq(profiles.vendorId, vendorId), eq(profiles.role, VENDOR_ADMIN_ROLE));
}

export function ownedProductIds(db: Db, vendorId: string) {
  return db
    .select({ productId: productVendors.productId })
    .from(productVendors)
    .where(eq(productVendors.vendorId, vendorId));
}

/**
 * The `vendor_requests` scoping predicate: requests targeting the caller's vendor
 * itself, plus those targeting any product it owns.
 *
 * `ownedProducts` takes either form of the owned-product set — the materialised
 * array `GET /api/vendor/me` already holds, or the {@link ownedProductIds}
 * subquery the cursor composes in. An **empty array** drops the product arm
 * entirely (Drizzle emits degenerate SQL for `inArray(col, [])`); a subquery
 * never can be "empty" at build time, and an empty result set matches nothing on
 * its own, so it needs no such guard.
 */
export function vendorRequestsWhere(
  vendorId: string,
  ownedProducts: readonly string[] | SQLWrapper,
): SQL | undefined {
  const noProducts = Array.isArray(ownedProducts) && ownedProducts.length === 0;
  return or(
    and(eq(vendorRequests.targetType, 'vendor'), eq(vendorRequests.targetId, vendorId)),
    noProducts
      ? undefined
      : and(
          eq(vendorRequests.targetType, 'product'),
          inArray(vendorRequests.targetId, ownedProducts),
        ),
  );
}

/** What `requireOwnedProduct` proves: the product row, whether the caller is its
 *  primary vendor, and the caller's own vendor row (for the capability gate). */
export interface OwnedProduct {
  product: ProductRow;
  isPrimary: boolean;
  vendor: VendorRow;
}

/**
 * Prove the session's vendor owns `productId`, and load what a write needs.
 *
 * **Runs in its own wave, before any other read or write on the request**, and a
 * miss is a **404, not a 403** — a vendor must not be able to probe for the
 * existence of another vendor's product. Folding this into a wider `Promise.all`
 * would let a validation error (a 400 naming a bad slug, say) win the race and
 * answer a request that should have been a flat 404.
 *
 * This is the PRODUCT-grain counterpart to `lib/attestation-authority.ts`'s
 * integration-grain `resolveAttestationSlots`: same `product_vendors` source,
 * same 404-never-403 property, different question. Neither re-derives the other.
 *
 * The caller's `vendors` row rides along because `assertVerifiedVendor` needs it
 * and a second round-trip on the Worker for one boolean is not worth it. The
 * three reads go in one wave and are then checked **in order** — ownership
 * first, so a non-owner gets a 404 rather than learning it is merely unverified.
 */
export async function requireOwnedProduct(
  db: Db,
  vendorId: string,
  productId: string,
): Promise<OwnedProduct> {
  const [ownership, product, vendor] = await Promise.all([
    db.query.productVendors.findFirst({
      where: and(eq(productVendors.productId, productId), eq(productVendors.vendorId, vendorId)),
    }),
    db.query.products.findFirst({ where: eq(products.id, productId) }),
    db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) }),
  ]);
  if (!ownership || !product) throw notFoundError('product', { id: productId });
  // A granted seat whose vendor row has since been deleted. `GET /api/vendor/me`
  // answers 404 for the same state; do the same here rather than 500.
  if (!vendor) throw notFoundError('vendor', { id: vendorId });
  return { product, isPrimary: ownership.isPrimary, vendor };
}

/**
 * ⚠️ **PLACEHOLDER** — the `aeci-514`-local stand-in for
 * `requireCapability('attestation.author')`.
 *
 * Attestation authoring, and the product-version model that exists only to stamp
 * attestations, is a **Verified-vendor capability**
 * (`STAGE_2_ATTESTATIONS_SPEC.md` §1; `STAGE_2_SPEC.md` §8.1(3)), with
 * `vendors.verified` as the launch entitlement bit. AECI-610 has already shipped
 * the real registry on the `aeci-515` branch — `@aeci/shared/entitlements`
 * declares the `'attestation.author'` capability id — and AECI-611 adds the guard
 * that loads a tier onto the session. Neither is reachable from this branch, so
 * this is deliberately ONE function with ONE call site per handler: swapping it
 * for `requireCapability` at the `aeci-514`/`aeci-515` → `stage-2` merge is a
 * mechanical edit, not an audit.
 *
 * It **reads** `vendors.verified` and never writes it. On `aeci-515` an ESLint
 * rule makes the entitlement-mirror module the only writer of that column;
 * nothing here should give a future editor a reason to break that.
 *
 * The 403 copy points at the claim/verification flow and **never at ranking or
 * placement** — verification gates capability only (no pay-for-placement).
 */
export function assertVerifiedVendor(vendor: Pick<VendorRow, 'verified'>): void {
  if (!vendor.verified) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'This action requires a verified vendor account. Claim your company profile to get verified.',
    );
  }
}

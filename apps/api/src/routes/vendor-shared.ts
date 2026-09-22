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

import type { CachePurgeSource } from '@aeci/shared';
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, inArray, or, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import type { Db } from '../db/client';
import { productVendors, products, profiles, vendorRequests, vendors } from '../db/schema';
import { logBatchToPosthog, logToPosthog, submitCount, type PosthogLogEvent } from '../posthog';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import type { BatchStmt } from '../lib/audit';
import type { AuthzVariables } from '../lib/authz';
import { VENDOR_ADMIN_ROLE } from '../lib/claimed-vendors';
import type { GscRecrawlEntry } from '../lib/gsc-recrawl-priority';
import { enqueueGscRecrawl } from '../lib/gsc-recrawl-queue';
import { enqueueIndexNowUrls } from '../lib/indexnow-queue';
import { publicSiteBase } from '../lib/public-urls';

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
export function vendorAuditLogEvent(
  entry: Omit<AuditLogEntry, 'metadata'>,
  source: string = AUDIT_SOURCE,
): PosthogLogEvent {
  return {
    level: 'info',
    message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
    action: entry.action,
    entity_type: entry.entityType ?? undefined,
    entity_id: entry.entityId ?? undefined,
    source,
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
export async function purgeTags(
  c: VendorContext,
  tags: readonly string[],
  source: CachePurgeSource = 'vendor',
): Promise<void> {
  const queue = c.env.CACHE_PURGE_QUEUE;
  if (!queue || tags.length === 0) return;
  try {
    await queue.send({ tags: [...tags], source });
  } catch (error) {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: `Cache purge enqueue failed for ${tags.join(',')}`,
      outcome: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Whether this environment should buffer re-crawl URLs at all.
 *
 * **Gated on `INDEXNOW_KEY` AND `PUBLIC_SITE_URL`, including for the Google
 * queue, which has nothing to do with IndexNow.** That reuse is deliberate and
 * worth stating, because it looks wrong. The API Worker has no `ALLOW_INDEXING`
 * var; that lives on the SSR Worker. `INDEXNOW_KEY` is provisioned *only* on the
 * environment where `ALLOW_INDEXING="true"` (`env.ts` §INDEXNOW_KEY), so within
 * this Worker it is the only available signal for "this environment is public
 * and indexable". Inventing a second env var to express the same fact would mean
 * five more wrangler blocks to keep in sync and a new way for them to drift.
 *
 * Exported so a handler can skip DERIVING the URLs on a gated environment — the
 * product edit resolves the trade publication floor with a D1 read, and running
 * it to feed a buffer that will not be written is pure waste on every preview
 * and every local request.
 */
export function recrawlEnabled(env: Pick<Env, 'INDEXNOW_KEY' | 'PUBLIC_SITE_URL'>): boolean {
  return Boolean(env.INDEXNOW_KEY) && publicSiteBase(env) !== null;
}

/**
 * What a vendor write asks the search engines to re-fetch (AECI-944 / AECI-945).
 *
 * Two lists rather than one, because the two channels have opposite economics.
 * `indexNow` is free, batched and unranked, so it takes everything the edit
 * touched including hub pages. `gsc` is quota-capped and worked by a human, so
 * it takes entity detail pages only, each carrying the reason that ranks it. See
 * `lib/gsc-recrawl-priority.ts` for why the Google list is ordered rather than
 * filtered.
 *
 * Optional on {@link afterVendorWrite}: its remaining five call sites are
 * seat-invite and membership writes that change no public page at all, and they
 * pass nothing. The test for a new writer is the tag list, not the handler's
 * name — anything that purges a `product:` / `vendor:` / `pair:` tag is changing
 * a page a crawler can see and must name that page here too.
 */
export interface VendorRecrawl {
  indexNow: readonly string[];
  gsc: readonly GscRecrawlEntry[];
}

/**
 * Buffer a vendor write's affected URLs into the two re-crawl queues.
 *
 * Gated by {@link recrawlEnabled} — see there for why a Google queue keys off an
 * IndexNow secret.
 *
 * Best-effort in both halves, and independently so: these are post-commit hooks
 * on an already-committed edit, and a missed buffer costs discovery latency
 * rather than correctness. The sitemap's `<lastmod>` — which a vendor edit *does*
 * move, because every vendor write stamps `products.updated_at` — remains the
 * passive discovery path underneath both (§20.5 step 5).
 *
 * No `audit_log` row: both tables' INSERTs are ADR 0022 log-class, exactly as the
 * promote path's are.
 *
 * Deliberately NOT wrapped in promote's `dispatchHook` watchdog. That helper
 * takes a `PromoteRunCtx` rather than a Hono `Context`, and its 20-second timer
 * exists to contain a wedged outbound `fetch`. These are local D1 inserts on a
 * binding, with no connection to exhaust (AECI-666).
 */
async function bufferVendorRecrawl(
  c: VendorContext,
  db: Db,
  pending: VendorRecrawl | Promise<VendorRecrawl>,
): Promise<void> {
  // Re-checked here as well as at the call site. The call-site check exists so a
  // handler never does the WORK of deriving URLs on a gated environment; this one
  // is the actual guard, so a future caller that forgets the first check still
  // cannot write rows on a `noindex` tier.
  if (!recrawlEnabled(c.env)) return;

  // Awaited HERE rather than at the call site. A caller whose URL set depends on
  // a post-commit read (the product handler's trade publication floor) hands the
  // promise straight over, so the read never delays the response — it settles
  // inside `waitUntil` alongside the inserts it feeds.
  const recrawl = await pending;

  if (recrawl.indexNow.length > 0) {
    try {
      const queued = await enqueueIndexNowUrls(db, recrawl.indexNow, 'vendor');
      // Tagged `source:vendor` so the series splits by arm. Without this the
      // metric would measure the promote arm alone while the table quietly
      // filled from two writers — a rate that under-reports by an unknown factor
      // is worse than no rate at all.
      submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.indexnow.queued', queued, [
        'source:vendor',
      ]);
    } catch (error) {
      logToPosthog(c.executionCtx, c.env, c.req.raw, {
        level: 'warn',
        message: 'aeci.api.vendor.indexnow_failed',
        outcome: error instanceof Error ? error.message : String(error),
        urls_count: recrawl.indexNow.length,
      });
    }
  }

  if (recrawl.gsc.length > 0) {
    try {
      const touched = await enqueueGscRecrawl(db, recrawl.gsc, 'vendor');
      submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.gsc_recrawl.queued', touched, [
        'source:vendor',
      ]);
    } catch (error) {
      logToPosthog(c.executionCtx, c.env, c.req.raw, {
        level: 'warn',
        message: 'aeci.api.vendor.gsc_recrawl_failed',
        outcome: error instanceof Error ? error.message : String(error),
        urls_count: recrawl.gsc.length,
      });
    }
  }
}

/**
 * The post-commit tail every vendor write shares: purge, forward to PostHog, and
 * — since AECI-944 — buffer the affected URLs for re-crawl. All best-effort, all
 * outside the batch.
 *
 * `entries` takes an array as well as a single entry because a write may emit
 * more than one `audit_log` row — AECI-301's `POST /api/vendor/claims` writes a
 * `claim.created` plus one `attestation.created` per owned slot, and §26.5 wants
 * every row forwarded, not just the headline one.
 *
 * **`recrawl` is the AECI-944 reversal.** Until then this tail deliberately did
 * not ping a crawler: the comment on `productEditTags` said a vendor edit
 * "repaints the edge but does not ask a crawler to re-fetch; the next promote
 * touching that trade does". That was defensible while no vendor held a seat.
 * It stops being defensible the moment a vendor can change a public page that no
 * promote will touch again for weeks. Putting it HERE rather than at each call
 * site means every present and future vendor write inherits it by default, and a
 * writer that genuinely changes no public page opts out by passing nothing.
 */
export function afterVendorWrite(
  c: VendorContext,
  tags: readonly string[],
  entries: AuditLogEntry | readonly AuditLogEntry[],
  recrawl?: VendorRecrawl | Promise<VendorRecrawl>,
  db?: Db,
  // AECI-1046: an AECi admin write that shares a vendor write's tail (the admin
  // retire) labels its forward and its purge as AECi-initiated.
  origin: { auditSource: string; purgeSource: CachePurgeSource } = {
    auditSource: AUDIT_SOURCE,
    purgeSource: 'vendor',
  },
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
  logBatchToPosthog(
    c.executionCtx,
    c.env,
    c.req.raw,
    list.map((entry) => vendorAuditLogEvent(entry, origin.auditSource)),
  );
  c.executionCtx.waitUntil(purgeTags(c, tags, origin.purgeSource));
  if (recrawl && db) c.executionCtx.waitUntil(bufferVendorRecrawl(c, db, recrawl));
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
 * The AECI-981 maintenance transfer.
 *
 * A vendor-authorized catalog write puts the record on the vendor's name and
 * records the save as a review: `maintained_by = 'vendor'` plus a fresh
 * `last_reviewed_at`. Both are unconditional, extending the rule
 * `STAGE_2_ATTESTATIONS_SPEC.md` §13.4 already ships for attestations — *"even a
 * repeat assertion IS a review — that is the event the date records"* — to the
 * rest of the vendor write surface. The vendor branch of the marker renders
 * `Vendor-maintained · Updated <date>`, so "Updated" is exactly what a save is.
 *
 * **Per row, never transitive.** A vendor editing its company profile does not
 * flip its products, and a product edit does not flip the vendor: each row's
 * marker answers "who is on the hook for THIS page" (§13.9).
 *
 * **One-way for now.** Nothing hands a record back to `'aeci'`; the seat-revoke
 * case is a named deferral in §13.9. `last_reviewed_at` is never cleared, on the
 * same reasoning §13.4 gives for retraction — withdrawing an assertion does not
 * un-happen the review.
 *
 * Caller keeps these OUT of the audit row's before/after diff, exactly as
 * `updated_at` is kept out, so that diff stays a record of what the vendor sent.
 * {@link maintenanceTransferAudit} is how a transfer stays greppable.
 */
export function maintenanceTransferColumns(now: string): {
  maintainedBy: 'vendor';
  lastReviewedAt: string;
} {
  return { maintainedBy: 'vendor', lastReviewedAt: now };
}

/** True when this write is the moment a record changes hands, rather than one of
 *  the many later saves by a vendor that already holds it. Only the transition is
 *  marked in the audit metadata — marking every save would make the flag useless
 *  for finding the ones that mattered. */
export function isMaintenanceTransfer(before: { maintainedBy: string }): boolean {
  return before.maintainedBy !== 'vendor';
}

/**
 * The transfer as its own statement + audit row, for a batch that has no write to
 * the parent row to fold into — the three `product_versions` handlers, whose own
 * audit rows are `product_version.*` on a different entity.
 *
 * Shaped after `vendorMaintainedFlip` in `routes/vendor-attestations.ts`, and it
 * reuses that path's `metadata.reason` so one grep finds every maintenance flip in
 * the audit log regardless of which surface caused it (§13.8).
 *
 * Unlike the attestation flip there is no no-op case to suppress: `last_reviewed_at`
 * advances on every save by definition, so the statement always changes something
 * and the audit row is never a lie.
 *
 * Sets no `updated_at` of its own. The column still moves, because `updatedAt()`
 * is `.$onUpdate(...)` and this is an UPDATE — see the note in
 * `vendor-product-versions.ts` for why that redundant Algolia resync is accepted
 * rather than suppressed.
 */
export function productMaintenanceTransfer(
  db: Db,
  session: { userId: string },
  actorType: AuditLogEntry['actorType'],
  before: ProductRow,
  now: string,
  context: { vendorId: string },
): { stmt: BatchStmt; audit: AuditLogEntry } {
  return {
    stmt: db
      .update(products)
      .set(maintenanceTransferColumns(now))
      .where(eq(products.id, before.id)),
    audit: {
      actorId: session.userId,
      actorType,
      action: 'product.updated',
      entityType: 'product',
      entityId: before.id,
      beforeState: {
        maintained_by: before.maintainedBy,
        last_reviewed_at: before.lastReviewedAt,
      },
      afterState: { maintained_by: 'vendor', last_reviewed_at: now },
      metadata: {
        source: AUDIT_SOURCE,
        vendorId: context.vendorId,
        reason: 'maintenance-marker',
        // Present ONLY on the transition, never as `false`. Same encoding as the
        // two PATCH handlers in `vendor.ts`, so one key-presence query over
        // `audit_log.metadata` finds the hand-changing saves on every surface.
        ...(isMaintenanceTransfer(before) ? { maintenanceTransfer: true } : {}),
      },
    },
  };
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

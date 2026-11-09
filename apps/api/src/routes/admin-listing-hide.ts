/**
 * The admin listing hide and restore (AECI-1238, ADR 0052,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.6, `ADMIN_PANEL_SPEC.md` §5.7).
 *
 *   POST /api/admin/vendors/:id/hide      — take a company and every joined product
 *                                           off the public site (200).
 *   POST /api/admin/vendors/:id/restore   — put it back, with exactly the products
 *                                           its hide covered (200).
 *   POST /api/admin/products/:id/hide     — take one product off (200).
 *   POST /api/admin/products/:id/restore  — put it back (200).
 *
 * Why it exists: the Listing Accuracy Policy promises "when we remove a listing, we
 * hide it", and counsel's removal-request table (`docs/RUNBOOKS.md`) needs an
 * interim hide while a complaint is reviewed. Before this nothing could be hidden:
 * every D1 row was public, and `promotion_status` cannot serve because promote
 * resets it.
 *
 * Rules (the batch rules are `lib/listing-hide.ts`):
 *
 * 1. **Admin only, rate-limited after the guard.** `requireAdmin()` then
 *    `rateLimit('write')` at registration. The body is `AdminListingHideBodySchema`:
 *    a kind, a vendor-visible reason, an optional internal note, the date AECi
 *    received the request, and the public source (required for a complaint).
 * 2. **Any record, held or not.** Unlike a field correction, a hide is not limited to
 *    vendor-held records: a lawful order or a defunct company applies to an AECi-held
 *    listing too. Promote never writes `hidden_*`, so the hide holds.
 * 3. **Refusals, all 409.** `LISTING_HIDDEN` (already hidden), `LISTING_NOT_HIDDEN`
 *    (nothing to restore), `LISTING_HIDDEN_WITH_VENDOR` (a product hidden with its
 *    company, or joined to a hidden company), `LISTING_CHANGED_WHILE_SAVING` (a lost
 *    race; every guarded UPDATE has a sentinel).
 * 4. **Everyone holding an affected record is told.** One `aeci_override` notice per
 *    recipient and record: the company itself when claimed, and every other claimed
 *    vendor of each affected product. No email (§11d.3).
 * 5. **After commit.** A by-id Algolia sync of every changed record behind promote's
 *    watchdog (never left to the capped orphan sweep), the cache purge in chunks of
 *    1,000 tags with `source: 'moderation'`, the re-crawl of the removed or restored
 *    URLs, a home-stats refresh, and the audit forward.
 */

import {
  AdminListingHideBodySchema,
  AdminListingHideResponseSchema,
  AdminListingRestoreBodySchema,
  type AdminListingHideResponse,
  type ListingHideEntityType,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';

import { getDb, type Db } from '../db/client';
import { notFoundError } from '../errors';
import { json } from '../http';
import { type BatchTuple } from '../lib/audit';
import { productHolderVendorId, vendorAuditStamp } from '../lib/audit-vendor';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { requestHomeStatsRefresh } from '../lib/home-stats-refresh';
import {
  buildHideBatch,
  buildRestoreBatch,
  isListingHideRaceError,
  listingChangedError,
  listingHiddenError,
  listingHiddenWithVendorError,
  listingNotHiddenError,
  loadChildHides,
  loadClaimedVendorsOf,
  loadHideRow,
  loadListingFootprint,
  loadOtherHiddenVendorsOf,
  loadProductRecord,
  loadVendorProducts,
  loadVendorRecord,
  loadVendorSlugs,
  loadVendorsOfProducts,
  toAdminListingHide,
  type ListingBatch,
  type ListingFootprint,
  type ListingHideMode,
  type ListingRecord,
} from '../lib/listing-hide';
import { pairUrl, productUrl, publicSiteBase, vendorUrl } from '../lib/public-urls';
import { dispatchOwnerWriteSearch, syncOwnerWriteSearch } from './integration-retire-write';
import { logToPosthog } from '../posthog';
import { pairCacheTag } from './promote-pair';
import { loadTaxonomySlugs } from './vendor';
import {
  afterVendorWrite,
  parseJsonBody,
  purgeTags,
  recrawlEnabled,
  type VendorContext,
  type VendorRecrawl,
} from './vendor-shared';

const ADMIN_ORIGIN = { auditSource: 'admin-moderation', purgeSource: 'moderation' } as const;

/** Tags per purge message (`CACHE_STRATEGY.md` §3). */
export const LISTING_PURGE_TAG_CHUNK = 1000;

/** Ids per by-id Algolia sync: inside D1's 100-parameter cap on each `IN (…)`. */
const SYNC_ID_CHUNK = 80;

export function createAdminHideListingHandler(
  entityType: ListingHideEntityType,
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return handlerFor(entityType, 'hide', dbFor);
}

export function createAdminRestoreListingHandler(
  entityType: ListingHideEntityType,
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return handlerFor(entityType, 'restore', dbFor);
}

function loadRecord(db: Db, entityType: ListingHideEntityType, id: string) {
  return entityType === 'vendor' ? loadVendorRecord(db, id) : loadProductRecord(db, id);
}

/** The claimed recipients per record: the company (when claimed) for itself, and the
 *  other claimed vendors of each product. */
async function recipientsFor(
  db: Db,
  root: { entityType: ListingHideEntityType; record: ListingRecord },
  productIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const vendorId = root.entityType === 'vendor' ? root.record.id : null;
  if (vendorId && root.record.claimed) out.set(vendorId, [vendorId]);
  const pairs = await loadClaimedVendorsOf(db, productIds, vendorId);
  for (const { productId, vendorId: recipient } of pairs) {
    const list = out.get(productId) ?? [];
    list.push(recipient);
    out.set(productId, list);
  }
  return out;
}

function handlerFor(
  entityType: ListingHideEntityType,
  mode: ListingHideMode,
  dbFor: DbFactory,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = c.req.param('id') ?? '';
    const { db } = writeDb(c, dbFor);
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const now = new Date().toISOString();

    const hideBody =
      mode === 'hide' ? await parseJsonBody(c, AdminListingHideBodySchema) : undefined;
    const restoreBody =
      mode === 'restore' ? await parseJsonBody(c, AdminListingRestoreBodySchema) : undefined;

    const record = await loadRecord(db, entityType, id);
    if (!record) throw notFoundError(entityType, { id });
    const root = { entityType, record };

    let batch: ListingBatch;
    let footprint: ListingFootprint;
    let changedProducts: ListingRecord[];
    if (mode === 'hide') {
      if (record.hiddenAt) throw listingHiddenError();
      const cascade =
        entityType === 'vendor'
          ? (await loadVendorProducts(db, record.id)).filter((p) => !p.hiddenAt)
          : [];
      changedProducts = entityType === 'product' ? [record] : cascade;
      const productIds = changedProducts.map((p) => p.id);
      const [fp, recipients, stamp] = await Promise.all([
        loadListingFootprint(db, productIds),
        recipientsFor(db, root, productIds),
        vendorAuditStamp(
          db,
          entityType === 'vendor' ? record.id : await productHolderVendorId(db, record.id),
        ),
      ]);
      footprint = fp;
      batch = buildHideBatch(db, {
        now,
        actor,
        body: hideBody!,
        root,
        cascade,
        stamp,
        recipients,
        recountProductIds: fp.productIds,
      });
    } else {
      if (!record.hiddenAt) throw listingNotHiddenError();
      const rootHide = await loadHideRow(db, record.hiddenHideId);
      if (!rootHide || rootHide.restoredAt) throw listingChangedError();
      if (entityType === 'product') {
        // A product under a company hide, or joined to any hidden company, comes
        // back only with its company.
        if (rootHide.parentId) throw listingHiddenWithVendorError();
        if ((await loadOtherHiddenVendorsOf(db, [record.id], null)).size > 0) {
          throw listingHiddenWithVendorError();
        }
      }
      const children = entityType === 'vendor' ? await loadChildHides(db, rootHide.id) : [];
      const others = await loadOtherHiddenVendorsOf(
        db,
        children.map((child) => child.product.id),
        record.id,
      );
      const rehome = new Map<
        string,
        {
          vendorId: string;
          hideId: string;
          hide: NonNullable<Awaited<ReturnType<typeof loadHideRow>>>;
        }
      >();
      for (const [productId, other] of others) {
        const hide = await loadHideRow(db, other.hideId);
        if (hide && !hide.restoredAt) rehome.set(productId, { ...other, hide });
      }
      changedProducts =
        entityType === 'product'
          ? [record]
          : children.map((child) => child.product).filter((p) => !rehome.has(p.id));
      const productIds = changedProducts.map((p) => p.id);
      const [fp, recipients, stamp] = await Promise.all([
        loadListingFootprint(db, productIds),
        recipientsFor(db, root, productIds),
        vendorAuditStamp(
          db,
          entityType === 'vendor' ? record.id : await productHolderVendorId(db, record.id),
        ),
      ]);
      footprint = fp;
      batch = buildRestoreBatch(db, {
        now,
        actor,
        reason: restoreBody!.reason,
        internalNote: restoreBody!.internalNote,
        root,
        rootHide,
        children,
        rehome,
        stamp,
        recipients,
        recountProductIds: fp.productIds,
      });
    }

    try {
      await db.batch(batch.stmts as BatchTuple);
    } catch (error) {
      if (!isListingHideRaceError(error)) throw error;
      const current = await loadRecord(db, entityType, id);
      if (!current) throw notFoundError(entityType, { id });
      if (mode === 'hide' && current.hiddenAt) throw listingHiddenError();
      if (mode === 'restore' && !current.hiddenAt) throw listingNotHiddenError();
      throw listingChangedError();
    }

    // The batch has committed: a failed post-commit read must not answer 500 for a
    // write that landed. It is logged, and the nightly sync, sweep and purge TTLs
    // are the backstop.
    try {
      await afterListingCommit(c, db, {
        mode,
        root,
        changedProducts,
        footprint,
        audits: batch.audits,
      });
    } catch (error) {
      logToPosthog(c.executionCtx, c.env, c.req.raw, {
        level: 'error',
        message: 'aeci.api.admin.listing_hide_after_commit_failed',
        entity: entityType,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const hide = mode === 'hide' ? await loadHideRow(db, batch.rootHideId) : undefined;
    const body: AdminListingHideResponse = {
      entity_type: entityType,
      entity_id: record.id,
      hidden_at: mode === 'hide' ? now : null,
      hide: hide ? toAdminListingHide(hide) : null,
      product_ids: batch.productIds,
    };
    validateResponseInDev(c.env, () => AdminListingHideResponseSchema.parse(body));
    return json(body);
  };
}

/**
 * Everything a committed hide or restore does next. The reads it needs ran before the
 * batch (`footprint`), because after a hide the live predicate no longer sees the
 * rows. Never throws past the handler: each leg logs its own failure.
 */
async function afterListingCommit(
  c: VendorContext,
  db: Db,
  input: {
    mode: ListingHideMode;
    root: { entityType: ListingHideEntityType; record: ListingRecord };
    changedProducts: readonly ListingRecord[];
    footprint: ListingFootprint;
    audits: AuditLogEntry[];
  },
): Promise<void> {
  const { root, changedProducts, footprint } = input;
  const changedIds = changedProducts.map((p) => p.id);
  const [joinedVendors, builderSlugs, taxonomy] = await Promise.all([
    loadVendorsOfProducts(db, changedIds),
    loadVendorSlugs(db, footprint.builderVendorIds),
    loadTaxonomySlugs(db, changedIds),
  ]);
  const vendorIds = new Set<string>([
    ...(root.entityType === 'vendor' ? [root.record.id] : []),
    ...joinedVendors.map((v) => v.id),
    ...footprint.builderVendorIds,
  ]);

  // Search: every record whose membership or count moved, by id, in chunks. The
  // sync is membership-aware, so a hidden record becomes a delete and a restored
  // one an upsert. Never left to the orphan sweep: its 50-delete cap would refuse
  // a large company.
  const targets = {
    vendors: [...vendorIds],
    products: [...new Set([...changedIds, ...footprint.productIds])],
    integrations: footprint.integrationIds,
  };
  dispatchOwnerWriteSearch(
    c,
    'admin-listing-hide-algolia',
    (async () => {
      const longest = Math.max(
        targets.vendors.length,
        targets.products.length,
        targets.integrations.length,
      );
      for (let i = 0; i < longest; i += SYNC_ID_CHUNK) {
        await syncOwnerWriteSearch(
          c,
          db,
          {
            vendors: targets.vendors.slice(i, i + SYNC_ID_CHUNK),
            products: targets.products.slice(i, i + SYNC_ID_CHUNK),
            integrations: targets.integrations.slice(i, i + SYNC_ID_CHUNK),
          },
          'aeci.api.admin.listing_hide_algolia_sync_failed',
        );
      }
    })(),
  );

  const tags = listingPurgeTags({
    vendorSlugs: [
      ...(root.entityType === 'vendor' ? [root.record.slug] : []),
      ...joinedVendors.map((v) => v.slug),
      ...builderSlugs,
    ],
    productSlugs: [...changedProducts.map((p) => p.slug), ...footprint.productSlugs],
    pairSlugs: footprint.pairSlugs,
    taxonomy: [...taxonomy.values()],
  });
  const [first, ...rest] = chunkTags(tags);
  // The first chunk rides the shared tail with the audit forward and the re-crawl.
  // The rest go straight to the queue.
  afterVendorWrite(
    c,
    first ?? [],
    input.audits,
    listingRecrawl(c, root, changedProducts, footprint),
    db,
    ADMIN_ORIGIN,
  );
  for (const chunk of rest) c.executionCtx.waitUntil(purgeTags(c, chunk, 'moderation'));

  // The home stats count products, vendors and integrations.
  c.executionCtx.waitUntil(
    requestHomeStatsRefresh(
      { env: c.env, waitUntil: (p) => c.executionCtx.waitUntil(p), request: c.req.raw },
      db,
    ),
  );
}

/**
 * Every cache tag a hide or restore must purge (`CACHE_STRATEGY.md` §3): each
 * changed company and product page, every pair page through them, the counterpart
 * and connector product pages whose counts moved, the companies that embed or build
 * them, the product index, the home page, the taxonomy pages and term tags, and the
 * sitemap.
 */
export function listingPurgeTags(input: {
  vendorSlugs: readonly string[];
  productSlugs: readonly string[];
  pairSlugs: readonly (readonly [string, string])[];
  taxonomy: readonly {
    categories: readonly string[];
    audiences: readonly string[];
    phases: readonly string[];
    trades: readonly string[];
  }[];
}): string[] {
  const tags = new Set<string>();
  for (const slug of input.vendorSlugs) tags.add(`vendor:${slug}`);
  for (const slug of input.productSlugs) tags.add(`product:${slug}`);
  for (const [a, b] of input.pairSlugs) tags.add(pairCacheTag(a, b));
  for (const terms of input.taxonomy) {
    for (const slug of terms.categories) tags.add(`category:${slug}`);
    for (const slug of terms.audiences) tags.add(`audience:${slug}`);
    for (const slug of terms.phases) tags.add(`phase:${slug}`);
    for (const slug of terms.trades) tags.add(`trade:${slug}`);
  }
  tags.add('index:products');
  tags.add('index:home');
  tags.add('index:trades');
  tags.add('taxonomy');
  tags.add('sitemap');
  return [...tags];
}

/** Split tags into queue messages of at most {@link LISTING_PURGE_TAG_CHUNK}. The
 *  `sitemap` tag stays in the first chunk, which marks the sitemap dirty. */
export function chunkTags(tags: readonly string[]): string[][] {
  const ordered = [...tags.filter((t) => t === 'sitemap'), ...tags.filter((t) => t !== 'sitemap')];
  const out: string[][] = [];
  for (let i = 0; i < ordered.length; i += LISTING_PURGE_TAG_CHUNK) {
    out.push(ordered.slice(i, i + LISTING_PURGE_TAG_CHUNK));
  }
  return out;
}

/**
 * The URLs a crawler should re-fetch: the hidden or restored company and product
 * pages, and every pair page through them. A removed page answers 404, which is how
 * the crawler learns it is gone.
 */
function listingRecrawl(
  c: VendorContext,
  root: { entityType: ListingHideEntityType; record: ListingRecord },
  changedProducts: readonly ListingRecord[],
  footprint: ListingFootprint,
): VendorRecrawl | undefined {
  const base = publicSiteBase(c.env);
  if (!base || !recrawlEnabled(c.env)) return undefined;
  const vendorPages = root.entityType === 'vendor' ? [vendorUrl(base, root.record.slug)] : [];
  const productPages = changedProducts.map((p) => productUrl(base, p.slug));
  const pairPages = footprint.pairSlugs.map(([a, b]) => pairUrl(base, a, b));
  return {
    indexNow: [...new Set([...vendorPages, ...productPages, ...pairPages])],
    gsc: [
      ...vendorPages.map((url) => ({ url, reason: 'vendor.updated' as const })),
      ...productPages.map((url) => ({ url, reason: 'product.updated' as const })),
      ...pairPages.map((url) => ({ url, reason: 'pair.updated' as const })),
    ],
    productId: null,
  };
}

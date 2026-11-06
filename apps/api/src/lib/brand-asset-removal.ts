/**
 * Removing a vendor's brand assets after its claim ends (AECI-1618, `STAGE_2_5_SPEC.md`
 * §11, ADR 0042). Vendor Terms promise this within 14 days of the claim ending.
 *
 * The daily job's shape, per company, in order:
 *
 *  1. One batch. A guarded update puts the retained AECi logo back on every row with
 *     `logo_source = 'vendor'`, and one `vendor.brand_assets_removed` audit row lists them.
 *     The batch opens by re-testing `claim_ended_at` and every update re-tests it, so a
 *     re-seat wins. A co-owned product another claimed vendor holds is skipped: we cannot
 *     tell which vendor wrote its logo. `logo_source = 'admin'` is AECi's and stays.
 *  2. R2. Hashes come from those rows and from the vendor's audit history, because a
 *     replaced upload stays readable. Only `/api/logos/<hash>` paths touch R2, and a hash
 *     goes only when no stored logo references it. An unsaved draft has no record, so it
 *     cannot be attributed and stays. It was never shown publicly.
 *  3. The purges and the ownership messages, for the whole run.
 *  4. `brand_assets_removed_at`, last, so a failure at any step leaves the company due.
 *
 * A hold delays the job, never past the limit. The promise is "within 14 days" and the job
 * runs once a day, so the override starts 13 days after the claim end. That makes the last
 * run before the limit act, whatever the hour the claim ended.
 */

import { LogoPathSchema } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { mapWithConcurrency, WORKER_CONNECTION_LIMIT } from '@aeci/shared/concurrency';
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { auditLog, productProposals, products, productVendors, vendors } from '../db/schema';
import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import { vendorAuditStamp } from './audit-vendor';
import { loadProductsClaimedByAnother } from './claimed-vendors';
import { ONE_ROW } from './integration-claims';

export const BRAND_ASSET_REMOVAL_RUN_METRIC = 'aeci.brand_assets.removal.run';
export const BRAND_ASSET_REMOVAL_SOURCE = 'brand-asset-removal';

/** `audit_log.action` values. The registry is `@aeci/shared/audit-vendor-actions`. */
export const BRAND_ASSETS_REMOVED_ACTION = 'vendor.brand_assets_removed';
export const BRAND_ASSETS_REMOVAL_COMPLETED_ACTION = 'vendor.brand_assets_removal_completed';

const DAY_MS = 86_400_000;
export const BRAND_ASSET_LIMIT_DAYS = 14;
/** The last daily run before the limit is the one that overrides a hold. */
const HOLD_OVERRIDE_DAYS = BRAND_ASSET_LIMIT_DAYS - 1;
/** The UTC hour of `BRAND_ASSET_REMOVAL_CRON`. `brand-asset-removal.spec.ts` pins the two. */
export const BRAND_ASSET_RUN_HOUR_UTC = 16;
/** Companies per run. The oldest go first, and the rest stay due for tomorrow. */
export const BRAND_ASSET_RUN_CAP = 100;
/** `sendBatch` takes at most 100 messages. */
const QUEUE_BATCH_MAX = 100;
/** D1 caps bound parameters per query at 100. */
const ID_CHUNK = 80;

const RACED_TOKEN = 'brand-assets-raced';

function chunk<T>(items: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The R2 key of a stored logo path, or null for a linked URL or nothing. */
export function logoKeyOf(url: string | null | undefined): string | null {
  if (!url || !LogoPathSchema.safeParse(url).success) return null;
  return url.slice('/api/logos/'.length);
}

/**
 * The retained-logo column on a local logo write: the AECi logo is kept when this save is
 * the first to overwrite it. `logo_source IS NULL` means promote owns the logo.
 */
export function retainSourcedLogo(table: typeof vendors | typeof products): SQL<string | null> {
  return sql<
    string | null
  >`CASE WHEN ${table.logoSource} IS NULL THEN ${table.logoUrl} ELSE ${table.sourcedLogoUrl} END`;
}

/** When the promise runs out. */
export function brandAssetLimitAt(claimEndedAt: string): string {
  return new Date(Date.parse(claimEndedAt) + BRAND_ASSET_LIMIT_DAYS * DAY_MS).toISOString();
}

/** The first daily run at or after `from`. */
function nextDailyRun(from: Date): Date {
  const run = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      BRAND_ASSET_RUN_HOUR_UTC,
    ),
  );
  return run.getTime() >= from.getTime() ? run : new Date(run.getTime() + DAY_MS);
}

/** The run that will act on a pending company. A hold waits for the override. */
export function brandAssetNextRunAt(
  claimEndedAt: string,
  holdAt: string | null,
  now: Date,
): string {
  const override = Date.parse(claimEndedAt) + HOLD_OVERRIDE_DAYS * DAY_MS;
  const from = holdAt && override > now.getTime() ? new Date(override) : now;
  return nextDailyRun(from).toISOString();
}

/** Due: the claim ended, nothing stamped, and no hold or the hold has run out. */
export function brandAssetsDueWhere(now: Date): SQL | undefined {
  const override = new Date(now.getTime() - HOLD_OVERRIDE_DAYS * DAY_MS).toISOString();
  return and(
    isNotNull(vendors.claimEndedAt),
    isNull(vendors.brandAssetsRemovedAt),
    or(isNull(vendors.brandAssetsHoldAt), lte(vendors.claimEndedAt, override)),
  );
}

export interface BrandAssetRowPlan {
  entityType: 'vendor' | 'product';
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  sourcedLogoUrl: string | null;
}

export interface BrandAssetPlan {
  rows: BrandAssetRowPlan[];
  /** Every product of this vendor the job may act on, co-owned ones excluded. */
  productSlugs: { id: string; slug: string }[];
  skippedProductIds: string[];
}

/** What a run would clear for one company. The admin list shows the same plan. */
export async function planBrandAssetRows(
  db: Db,
  vendor: {
    id: string;
    slug: string;
    companyName: string;
    logoUrl: string | null;
    logoSource: string | null;
    sourcedLogoUrl: string | null;
  },
): Promise<BrandAssetPlan> {
  const held = await db
    .select({
      id: products.id,
      slug: products.slug,
      name: products.name,
      logoUrl: products.logoUrl,
      logoSource: products.logoSource,
      sourcedLogoUrl: products.sourcedLogoUrl,
    })
    .from(productVendors)
    .innerJoin(products, eq(products.id, productVendors.productId))
    .where(eq(productVendors.vendorId, vendor.id))
    .orderBy(asc(products.id));
  const coClaimed = await loadProductsClaimedByAnother(
    db,
    vendor.id,
    held.map((row) => row.id),
  );
  const mine = held.filter((row) => !coClaimed.has(row.id));
  const rows: BrandAssetRowPlan[] = [];
  if (vendor.logoSource === 'vendor') {
    rows.push({
      entityType: 'vendor',
      id: vendor.id,
      slug: vendor.slug,
      name: vendor.companyName,
      logoUrl: vendor.logoUrl,
      sourcedLogoUrl: vendor.sourcedLogoUrl,
    });
  }
  for (const row of mine) {
    if (row.logoSource !== 'vendor') continue;
    rows.push({
      entityType: 'product',
      id: row.id,
      slug: row.slug,
      name: row.name,
      logoUrl: row.logoUrl,
      sourcedLogoUrl: row.sourcedLogoUrl,
    });
  }
  return {
    rows,
    productSlugs: mine.map((row) => ({ id: row.id, slug: row.slug })),
    skippedProductIds: held.filter((row) => coClaimed.has(row.id)).map((row) => row.id),
  };
}

/** Which of these logo paths some stored record still needs. */
export async function referencedLogoPaths(db: Db, paths: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const part of chunk(paths)) {
    const [v, vs, p, ps] = await Promise.all([
      db.select({ url: vendors.logoUrl }).from(vendors).where(inArray(vendors.logoUrl, part)),
      db
        .select({ url: vendors.sourcedLogoUrl })
        .from(vendors)
        .where(inArray(vendors.sourcedLogoUrl, part)),
      db.select({ url: products.logoUrl }).from(products).where(inArray(products.logoUrl, part)),
      db
        .select({ url: products.sourcedLogoUrl })
        .from(products)
        .where(inArray(products.sourcedLogoUrl, part)),
    ]);
    for (const row of [...v, ...vs, ...p, ...ps]) if (row.url) found.add(row.url);
  }
  // An open product proposal carries its own logo in its payload, and an accept would
  // store it. A LIKE per path: the payload is JSON, and a proposal logo is rare.
  for (const path of paths) {
    const open = await db
      .select({ id: productProposals.id })
      .from(productProposals)
      .where(
        and(
          isNull(productProposals.decision),
          sql`${productProposals.payload} LIKE ${`%${path}%`}`,
        ),
      )
      .limit(1);
    if (open.length > 0) found.add(path);
  }
  return found;
}

/**
 * Delete the objects behind these paths that nothing references. Rejects when any delete
 * failed, so the caller can leave its stamp unset. Returns how many were deleted.
 */
export async function deleteUnreferencedLogos(
  db: Db,
  bucket: Pick<R2Bucket, 'delete'> | undefined,
  urls: readonly (string | null | undefined)[],
): Promise<number> {
  const paths = [...new Set(urls.filter((url) => logoKeyOf(url) !== null))] as string[];
  if (paths.length === 0) return 0;
  const referenced = await referencedLogoPaths(db, paths);
  const keys = paths.filter((path) => !referenced.has(path)).map((path) => logoKeyOf(path)!);
  if (keys.length === 0) return 0;
  if (!bucket) throw new Error('UPLOADS is not bound, so stored logos cannot be deleted');
  const settled = await mapWithConcurrency(keys, WORKER_CONNECTION_LIMIT, (key) =>
    bucket.delete(key),
  );
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return keys.length;
}

/** Stored logos this vendor set, from its audit history, plus whether an earlier run of
 *  this job already cleared rows (its purges may still be owed). */
async function vendorLogoHistory(
  db: Db,
  vendorId: string,
  productIds: readonly string[],
): Promise<{ urls: string[]; priorRemoval: boolean }> {
  const hasLogo = sql`(json_extract(${auditLog.afterState}, '$.logoUrl') LIKE '/api/logos/%' OR json_extract(${auditLog.beforeState}, '$.logoUrl') LIKE '/api/logos/%')`;
  const edits = and(
    eq(auditLog.actorType, 'user'),
    inArray(auditLog.action, ['vendor.updated', 'product.updated']),
    hasLogo,
  );
  const select = () => ({ before: auditLog.beforeState, after: auditLog.afterState });
  const rows = (
    await Promise.all([
      db
        .select(select())
        .from(auditLog)
        .where(and(eq(auditLog.entityType, 'vendor'), eq(auditLog.entityId, vendorId), edits)),
      ...chunk(productIds).map((ids) =>
        db
          .select(select())
          .from(auditLog)
          .where(and(eq(auditLog.entityType, 'product'), inArray(auditLog.entityId, ids), edits)),
      ),
    ])
  ).flat();
  const urls: string[] = [];
  for (const row of rows) {
    const after = row.after as { logoUrl?: unknown } | null;
    const before = row.before as { logoUrl?: unknown; logoSource?: unknown } | null;
    if (typeof after?.logoUrl === 'string') urls.push(after.logoUrl);
    // A before-state is the vendor's only when the vendor had set it.
    if (before?.logoSource === 'vendor' && typeof before.logoUrl === 'string') {
      urls.push(before.logoUrl);
    }
  }
  // A retry's rows are clean already, so what it cleared comes from its own audit row.
  const removals = await db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, 'vendor'),
        eq(auditLog.entityId, vendorId),
        eq(auditLog.action, BRAND_ASSETS_REMOVED_ACTION),
      ),
    );
  for (const row of removals) {
    const listed = (row.metadata as { rows?: { logo_url?: unknown }[] } | null)?.rows ?? [];
    for (const item of listed) if (typeof item.logo_url === 'string') urls.push(item.logo_url);
  }
  return { urls, priorRemoval: removals.length > 0 };
}

function raceGuard(db: Db, vendorId: string, claimEndedAt: string): BatchStmt {
  const current = sql`EXISTS (SELECT 1 FROM ${vendors} WHERE ${vendors.id} = ${vendorId} AND ${vendors.claimEndedAt} = ${claimEndedAt} AND ${vendors.brandAssetsRemovedAt} IS NULL)`;
  return db
    .select({ guard: sql`CASE WHEN NOT ${current} THEN json(${RACED_TOKEN}) END` })
    .from(ONE_ROW);
}

function isRaceAbort(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/malformed JSON/i.test(text) || text.includes(RACED_TOKEN)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface BrandAssetRemovalCounts {
  due: number;
  completed: number;
  rowsCleared: number;
  objectsDeleted: number;
  /** A re-seat or an edit beat the batch. Nothing was written for that company. */
  raced: number;
  /** R2, D1 or the purge send failed. No stamp, so the company stays due. */
  failed: number;
  /** Co-owned products left because another claimed vendor holds them. */
  coOwnedSkipped: number;
  /** 1 when more companies were due than one run takes. */
  capped: number;
}

export interface BrandAssetRemovalDeps {
  bucket: Pick<R2Bucket, 'delete'> | undefined;
  now: Date;
  purgeQueue: Pick<Queue, 'sendBatch'> | undefined;
  /** Reason `admin_edit`, so the review-app mirror follows. It never rejects. */
  syncOwnership: (vendorIds: readonly string[]) => Promise<void>;
  forwardAudits: (entries: readonly AuditLogEntry[]) => void;
}

export async function runBrandAssetRemoval(
  db: Db,
  deps: BrandAssetRemovalDeps,
): Promise<BrandAssetRemovalCounts> {
  const now = deps.now.toISOString();
  const due = await db
    .select({
      id: vendors.id,
      slug: vendors.slug,
      companyName: vendors.companyName,
      logoUrl: vendors.logoUrl,
      logoSource: vendors.logoSource,
      sourcedLogoUrl: vendors.sourcedLogoUrl,
      claimEndedAt: vendors.claimEndedAt,
    })
    .from(vendors)
    .where(brandAssetsDueWhere(deps.now))
    .orderBy(asc(vendors.claimEndedAt), asc(vendors.id))
    .limit(BRAND_ASSET_RUN_CAP + 1);
  const counts: BrandAssetRemovalCounts = {
    due: Math.min(due.length, BRAND_ASSET_RUN_CAP),
    completed: 0,
    rowsCleared: 0,
    objectsDeleted: 0,
    raced: 0,
    failed: 0,
    coOwnedSkipped: 0,
    capped: due.length > BRAND_ASSET_RUN_CAP ? 1 : 0,
  };
  const audits: AuditLogEntry[] = [];
  const toStamp: { vendorId: string; claimEndedAt: string; objects: number }[] = [];
  const purges: { body: { tags: string[]; source: 'scheduled' } }[] = [];
  const toSync: string[] = [];

  for (const vendor of due.slice(0, BRAND_ASSET_RUN_CAP)) {
    const claimEndedAt = vendor.claimEndedAt!;
    try {
      const plan = await planBrandAssetRows(db, vendor);
      counts.coOwnedSkipped += plan.skippedProductIds.length;
      const history = await vendorLogoHistory(
        db,
        vendor.id,
        plan.productSlugs.map((row) => row.id),
      );
      if (plan.rows.length > 0) {
        const entry: AuditLogEntry = {
          actorId: null,
          actorType: 'system',
          action: BRAND_ASSETS_REMOVED_ACTION,
          entityType: 'vendor',
          entityId: vendor.id,
          ...(await vendorAuditStamp(db, vendor.id, now)),
          beforeState: { claim_ended_at: claimEndedAt },
          afterState: { rows_cleared: plan.rows.length },
          metadata: {
            source: BRAND_ASSET_REMOVAL_SOURCE,
            vendorId: vendor.id,
            rows: plan.rows.map((row) => ({
              entity_type: row.entityType,
              id: row.id,
              slug: row.slug,
              logo_url: row.logoUrl,
              restored_logo_url: row.sourcedLogoUrl,
            })),
            skipped_product_ids: plan.skippedProductIds,
          },
        };
        await db.batch([
          raceGuard(db, vendor.id, claimEndedAt),
          ...plan.rows.flatMap((row) => clearRowStatements(db, row, vendor.id, claimEndedAt, now)),
          auditInsert(db, entry),
        ] as BatchTuple);
        audits.push(entry);
        counts.rowsCleared += plan.rows.length;
      }
      const objects = await deleteUnreferencedLogos(db, deps.bucket, [
        ...plan.rows.map((row) => row.logoUrl),
        ...history.urls,
      ]);
      counts.objectsDeleted += objects;
      if (plan.rows.length > 0 || history.priorRemoval) {
        purges.push({
          body: {
            tags: [
              `vendor:${vendor.slug}`,
              ...plan.productSlugs.map((row) => `product:${row.slug}`),
              'index:products',
            ],
            source: 'scheduled',
          },
        });
        toSync.push(vendor.id);
      }
      toStamp.push({ vendorId: vendor.id, claimEndedAt, objects });
    } catch (error) {
      if (isRaceAbort(error)) counts.raced += 1;
      else {
        counts.failed += 1;
        console.warn('brand asset removal failed', vendor.id, error);
      }
    }
  }

  // The purges go before any stamp. A failed send leaves every company due, and the retry
  // re-sends them because `priorRemoval` is then true.
  try {
    if (deps.purgeQueue) {
      for (const part of chunk(purges, QUEUE_BATCH_MAX)) await deps.purgeQueue.sendBatch(part);
    }
    await deps.syncOwnership(toSync);
  } catch (error) {
    console.warn('brand asset removal purge failed', error);
    counts.failed += toStamp.length;
    toStamp.length = 0;
  }

  for (const item of toStamp) {
    try {
      const entry: AuditLogEntry = {
        actorId: null,
        actorType: 'system',
        action: BRAND_ASSETS_REMOVAL_COMPLETED_ACTION,
        entityType: 'vendor',
        entityId: item.vendorId,
        ...(await vendorAuditStamp(db, item.vendorId, now)),
        beforeState: { brand_assets_removed_at: null },
        afterState: { brand_assets_removed_at: now },
        metadata: {
          source: BRAND_ASSET_REMOVAL_SOURCE,
          vendorId: item.vendorId,
          objects_deleted: item.objects,
        },
      };
      await db.batch([
        raceGuard(db, item.vendorId, item.claimEndedAt),
        db
          .update(vendors)
          .set({ brandAssetsRemovedAt: now, updatedAt: sql`${vendors.updatedAt}` })
          .where(
            and(
              eq(vendors.id, item.vendorId),
              eq(vendors.claimEndedAt, item.claimEndedAt),
              isNull(vendors.brandAssetsRemovedAt),
            ),
          ),
        auditInsert(db, entry),
      ] as BatchTuple);
      audits.push(entry);
      counts.completed += 1;
    } catch (error) {
      if (isRaceAbort(error)) counts.raced += 1;
      else {
        counts.failed += 1;
        console.warn('brand asset removal stamp failed', item.vendorId, error);
      }
    }
  }
  if (audits.length > 0) deps.forwardAudits(audits);
  return counts;
}

/** The guarded clear of one row, then an abort if it matched nothing, so the audit row
 *  can never list a write that did not happen. */
function clearRowStatements(
  db: Db,
  row: BrandAssetRowPlan,
  vendorId: string,
  claimEndedAt: string,
  now: string,
): BatchStmt[] {
  const changed = db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json(${RACED_TOKEN}) END` })
    .from(ONE_ROW);
  if (row.entityType === 'vendor') {
    return [
      db
        .update(vendors)
        .set({
          logoUrl: sql`${vendors.sourcedLogoUrl}`,
          logoSource: null,
          sourcedLogoUrl: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(vendors.id, vendorId),
            eq(vendors.logoSource, 'vendor'),
            eq(vendors.claimEndedAt, claimEndedAt),
          ),
        ),
      changed,
    ];
  }
  const claimStillEnded = sql`EXISTS (SELECT 1 FROM ${vendors} WHERE ${vendors.id} = ${vendorId} AND ${vendors.claimEndedAt} = ${claimEndedAt})`;
  const coClaimed = sql`EXISTS (SELECT 1 FROM ${productVendors} INNER JOIN ${vendors} ON ${vendors.id} = ${productVendors.vendorId} WHERE ${productVendors.productId} = ${row.id} AND ${productVendors.vendorId} <> ${vendorId} AND ${vendors.ownedAt} IS NOT NULL AND ${vendors.claimEndedAt} IS NULL)`;
  return [
    db
      .update(products)
      .set({
        logoUrl: sql`${products.sourcedLogoUrl}`,
        logoSource: null,
        sourcedLogoUrl: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(products.id, row.id),
          eq(products.logoSource, 'vendor'),
          claimStillEnded,
          sql`NOT ${coClaimed}`,
        ),
      ),
    changed,
  ];
}

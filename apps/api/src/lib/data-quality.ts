/**
 * The §23.1 daily data-quality suite (AECI-241 / Phase 7.6).
 *
 * Eleven read-only integrity checks over the D1 catalog, run from the 04:00 UTC cron
 * (`scheduled.ts`) and summarised in the email digest (`data-quality-email.ts`).
 * **Report-only** — no auto-remediation; the digest + the per-check Datadog gauge
 * are how humans triage (§23.1).
 *
 * Each check is a pure async fn over an injected surface (the Drizzle `Db`, plus
 * an injected `fetch` for the logo probe and an injected closure for the reused
 * AECI-140 Algolia-drift count), so every check unit-tests against the in-memory
 * D1 harness (`test/d1.ts`) with no network. The orchestrator
 * `runDataQualityChecks` runs all eleven best-effort: a check that throws becomes an
 * `error` result rather than aborting the run.
 *
 * Two checks are interpreted against D1 reality (documented inline):
 *   - #2 "ready >30d" is **structurally dead** — nothing in this repo ever writes
 *     `promotion_status = 'ready'` to D1 (it is the review app's lifecycle stage,
 *     not ours), so the check can only ever return zero rows. It is unreachable,
 *     not an approximation. Replacing it with a promotion-status invariant guard
 *     is AECI-592. Note `products.promoted_at` DOES now exist (AECI-581, migration
 *     `0011`) — the older note here claiming otherwise was wrong — but adding the
 *     column does not revive the check, which is why §13 D6 withdrew that claim.
 *   - #3 "broken integration refs" — the `source/target_product_id` FKs are
 *     enforced with `ON DELETE CASCADE`, so a *dangling* row is impossible; the
 *     real defect is an integration still pointing at a product that was pulled
 *     from the directory (`promotion_status` retracted/rejected).
 */

import { mapWithConcurrency, WORKER_CONNECTION_LIMIT } from '@aeci/shared/concurrency';
import { discardResponseBody } from '@aeci/shared/response-drain';

import type { AlgoliaIndexDrift } from './algolia-drift';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import type { Db } from '../db/client';
import {
  integrations,
  products,
  productVendors,
  reviews,
  statsCache,
  vendorEntitlements,
  vendors,
} from '../db/schema';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Number of days a product may sit `promotion_status='ready'` before it's flagged. */
const READY_STALE_DAYS = 30;
/** A `stats_cache` row older than this signals a stalled stats pipeline. */
const STATS_STALE_HOURS = 48;
/** Default number of logo URLs probed per run (sample check, not exhaustive). */
const DEFAULT_LOGO_SAMPLE = 20;
/** Per-logo HTTP timeout so a slow/hung CDN can't stall the cron. */
const LOGO_FETCH_TIMEOUT_MS = 5_000;
/** Max sample lines surfaced per check in the digest (the full count is exact). */
export const SAMPLE_LIMIT = 10;
/** `promotion_status` values that mean a product was pulled from the directory. */
const REMOVED_STATUSES = ['retracted', 'rejected'] as const;

export type DataQualitySeverity = 'error' | 'warn' | 'info';

/** The raw finding a single check returns (before id/label/severity are attached). */
export interface CheckFinding {
  /** One human-readable line per offending row/group (full set; the orchestrator
   *  caps the digest sample). */
  lines: string[];
  /** Optional context for the digest (e.g. "sampled 20 of 120 logos"). */
  note?: string;
  /** True when the check was deliberately not run (e.g. drift with no creds). */
  skipped?: boolean;
}

/** A single check's outcome, ready for the digest + the `aeci.data_quality.check` gauge. */
export interface DataQualityCheckResult {
  /** Stable id — the Datadog `check:` tag and the digest anchor. */
  id: string;
  label: string;
  severity: DataQualitySeverity;
  /** Offending rows/groups found (0 = clean; 0 when `skipped`). */
  count: number;
  /** Up to {@link SAMPLE_LIMIT} sample lines. */
  sample: string[];
  note?: string;
  skipped?: boolean;
  /** Set when the check itself threw — distinct from a clean `count: 0`. */
  error?: string;
}

export interface DataQualityDeps {
  db: Db;
  now: Date;
  /** Injected for the logo-404 probe (default: global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Max logo URLs to probe (default {@link DEFAULT_LOGO_SAMPLE}). */
  logoSampleSize?: number;
  /** Reuse of the AECI-140 drift count (`findAlgoliaIndexDrift`). `undefined` →
   *  check #10 is skipped (no Algolia creds — the local/preview default). */
  runDrift?: () => Promise<AlgoliaIndexDrift[]>;
}

// ───────────────────────────── individual checks ─────────────────────────────
// Each returns a CheckFinding so it unit-tests in isolation; the CHECKS registry
// below attaches the id/label/severity and the orchestrator builds the result.

/** #1 — products with no row in `product_vendors`. */
export async function checkProductsWithoutVendor(db: Db): Promise<CheckFinding> {
  const withVendor = db.select({ id: productVendors.productId }).from(productVendors);
  const rows = await db
    .select({ slug: products.slug, name: products.name })
    .from(products)
    .where(notInArray(products.id, withVendor))
    .orderBy(asc(products.name));
  return { lines: rows.map((r) => `${r.name} (${r.slug})`) };
}

/** #2 — products stuck `promotion_status='ready'` longer than {@link READY_STALE_DAYS}.
 *  Keyed off `updated_at`, so an edit resets the clock — but that is moot: **no code
 *  path writes `'ready'` to D1**, so this returns zero rows always. Unreachable, not
 *  a proxy (AECI-592 replaces it). `products.promoted_at` exists as of AECI-581 and
 *  is not the fix. Left as-is deliberately; changing the query is AECI-592's call. */
export async function checkStaleReadyProducts(db: Db, now: Date): Promise<CheckFinding> {
  const cutoff = new Date(now.getTime() - READY_STALE_DAYS * DAY_MS).toISOString();
  const rows = await db
    .select({ slug: products.slug, name: products.name, updatedAt: products.updatedAt })
    .from(products)
    .where(and(eq(products.promotionStatus, 'ready'), lt(products.updatedAt, cutoff)))
    .orderBy(asc(products.updatedAt));
  return { lines: rows.map((r) => `${r.name} (${r.slug}) — unchanged since ${r.updatedAt}`) };
}

/** #3 — integrations pointing at a source/target product that was pulled from the
 *  directory (`promotion_status` retracted/rejected). FK cascade makes a truly
 *  dangling ref impossible, so this is the real "broken reference" defect. */
export async function checkBrokenIntegrationRefs(db: Db): Promise<CheckFinding> {
  const src = alias(products, 'src');
  const tgt = alias(products, 'tgt');
  const rows = await db
    .select({
      id: integrations.id,
      name: integrations.name,
      srcName: src.name,
      srcStatus: src.promotionStatus,
      tgtName: tgt.name,
      tgtStatus: tgt.promotionStatus,
    })
    .from(integrations)
    .innerJoin(src, eq(integrations.sourceProductId, src.id))
    .innerJoin(tgt, eq(integrations.targetProductId, tgt.id))
    .where(
      or(
        inArray(src.promotionStatus, [...REMOVED_STATUSES]),
        inArray(tgt.promotionStatus, [...REMOVED_STATUSES]),
      ),
    );
  return {
    lines: rows.map(
      (r) =>
        `${r.name ?? r.id}: source "${r.srcName}" (${r.srcStatus}), target "${r.tgtName}" (${r.tgtStatus})`,
    ),
  };
}

/** #4 — vendors with no row in `product_vendors`. */
export async function checkVendorsWithoutProducts(db: Db): Promise<CheckFinding> {
  const withProduct = db.select({ id: productVendors.vendorId }).from(productVendors);
  const rows = await db
    .select({ slug: vendors.slug, name: vendors.companyName })
    .from(vendors)
    .where(notInArray(vendors.id, withProduct))
    .orderBy(asc(vendors.companyName));
  return { lines: rows.map((r) => `${r.name} (${r.slug})`) };
}

/** #5 — anonymized reviews (`reviewer_id IS NULL`) missing their `anonymized_at`
 *  stamp (AECI-241 added the column + GDPR write; this guards the invariant). */
export async function checkReviewsMissingAnonymizedAt(db: Db): Promise<CheckFinding> {
  const rows = await db
    .select({ id: reviews.id, productId: reviews.productId, createdAt: reviews.createdAt })
    .from(reviews)
    .where(and(isNull(reviews.reviewerId), isNull(reviews.anonymizedAt)))
    .orderBy(asc(reviews.createdAt));
  return {
    lines: rows.map((r) => `review ${r.id} (product ${r.productId}, created ${r.createdAt})`),
  };
}

/** #6 — `stats_cache` rows older than {@link STATS_STALE_HOURS} (stalled pipeline). */
export async function checkStaleStatsCache(db: Db, now: Date): Promise<CheckFinding> {
  const cutoff = new Date(now.getTime() - STATS_STALE_HOURS * HOUR_MS).toISOString();
  const rows = await db
    .select({ key: statsCache.key, computedAt: statsCache.computedAt })
    .from(statsCache)
    .where(lt(statsCache.computedAt, cutoff))
    .orderBy(asc(statsCache.computedAt));
  return { lines: rows.map((r) => `${r.key} — last computed ${r.computedAt}`) };
}

/** #7 — duplicate vendor candidates: same `company_name` ignoring case + whitespace. */
export async function checkDuplicateVendors(db: Db): Promise<CheckFinding> {
  // Lower-case + strip spaces/tabs/newlines, so "Acme Co" == "acmeco".
  const norm = sql<string>`lower(replace(replace(replace(${vendors.companyName}, ' ', ''), char(9), ''), char(10), ''))`;
  const rows = await db
    .select({
      n: count().as('n'),
      names: sql<string>`group_concat(${vendors.companyName}, ' | ')`.as('names'),
    })
    .from(vendors)
    .groupBy(norm)
    .having(sql`count(*) > 1`);
  return { lines: rows.map((r) => `${r.names} (${r.n}×)`) };
}

/** #8 — duplicate product candidates: same `name` within one vendor. */
export async function checkDuplicateProducts(db: Db): Promise<CheckFinding> {
  const norm = sql<string>`lower(trim(${products.name}))`;
  const rows = await db
    .select({
      vendorName: vendors.companyName,
      n: count().as('n'),
      names: sql<string>`group_concat(${products.name}, ' | ')`.as('names'),
    })
    .from(products)
    .innerJoin(productVendors, eq(productVendors.productId, products.id))
    .innerJoin(vendors, eq(vendors.id, productVendors.vendorId))
    .groupBy(productVendors.vendorId, norm)
    .having(sql`count(*) > 1`);
  return { lines: rows.map((r) => `${r.vendorName}: ${r.names} (${r.n}×)`) };
}

/** #9 — sample of Brandfetch logo URLs (products + vendors) returning HTTP 404.
 *  Sampled, not exhaustive (§23.1). Network/timeout errors are NOT counted — only
 *  a definitive 404 is a "broken logo"; transient failures would be false alarms. */
export async function checkLogo404Sample(
  db: Db,
  fetchImpl: typeof fetch,
  sampleSize: number,
): Promise<CheckFinding> {
  const half = Math.max(1, Math.ceil(sampleSize / 2));
  const [productLogos, vendorLogos] = await Promise.all([
    db
      .select({ url: products.logoUrl, label: products.name })
      .from(products)
      .where(isNotNull(products.logoUrl))
      .orderBy(desc(products.updatedAt))
      .limit(half),
    db
      .select({ url: vendors.logoUrl, label: vendors.companyName })
      .from(vendors)
      .where(isNotNull(vendors.logoUrl))
      .orderBy(desc(vendors.updatedAt))
      .limit(half),
  ]);
  const candidates = [...productLogos, ...vendorLogos]
    .filter(
      (c): c is { url: string; label: string } => typeof c.url === 'string' && c.url.length > 0,
    )
    .slice(0, sampleSize);

  // Bounded, not a bare `Promise.all` (AECI-666): `sampleSize` defaults to 20,
  // more than three times what a Worker invocation may hold open at once. The
  // probes still all run — six at a time — so the sample is unchanged; only the
  // burst is. Each response is drained too: only `res.status` is inspected, and
  // an unread body holds its connection open.
  const probes = await mapWithConcurrency(candidates, WORKER_CONNECTION_LIMIT, async (c) => {
    try {
      const res = await fetchImpl(c.url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS),
      });
      discardResponseBody(res);
      return res.status === 404 ? `${c.label}: ${c.url} → 404` : null;
    } catch {
      // Network error / timeout — not a definitive 404, so don't flag it.
      return null;
    }
  });

  return {
    // `mapWithConcurrency` never rejects, so a settled result is always
    // `fulfilled` here — the callback swallows its own failures.
    lines: probes
      .map((p) => (p.status === 'fulfilled' ? p.value : null))
      .filter((line): line is string => line !== null),
    note: `sampled ${candidates.length} logo URL(s)`,
  };
}

/** #10 — Algolia ↔ D1 index drift. Reuses the AECI-140 count
 *  (`findAlgoliaIndexDrift`), injected as `runDrift`; absent → skipped (no creds). */
export async function checkAlgoliaDrift(
  runDrift?: () => Promise<AlgoliaIndexDrift[]>,
): Promise<CheckFinding> {
  if (!runDrift) {
    return { lines: [], skipped: true, note: 'skipped — Algolia credentials not configured' };
  }
  const rows = await runDrift();
  const drifted = rows.filter((r) => r.drift !== 0);
  return {
    lines: drifted.map(
      (r) =>
        `${r.indexName}: database ${r.database} vs algolia ${r.algolia} (${r.drift > 0 ? '+' : ''}${r.drift})`,
    ),
  };
}

/**
 * #11 — the §2.1 MIRROR INVARIANT: `vendors.verified = 1` XOR an `active`
 * `vendor_entitlements` row (AECI-609 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §2.1).
 *
 * Guard 2 of the mirror. Guard 1 is the sole-writer ESLint rule; this is the one that
 * catches what lint structurally cannot: hand-written D1 SQL against a tier, the
 * `apps/datatool` worker (which binds all four tiers and can write prod D1), and — the
 * likely one — a backfill (§2.4) that ran on staging but not demo. Without it, "the
 * badge is missing on demo" is invisible until a human notices.
 *
 * A LEFT JOIN, not two subqueries: `vendor_entitlements_vendor_key` is UNIQUE, so
 * there is at most one row per vendor and no row multiplication — and joining
 * UNFILTERED (rather than `AND status = 'active'`) carries the offending status into
 * the digest line, which is what makes the finding triageable rather than just a count.
 *
 * ⚠️ SQL nuance: `status <> 'active'` is NULL — i.e. NOT true — when there is no row,
 * so the `isNull(id)` disjunct is REQUIRED. Drop it and the check silently misses the
 * "no entitlement row at all" case, which is precisely the backfill-did-not-run case
 * this exists to catch.
 */
export async function checkEntitlementMirrorDrift(db: Db): Promise<CheckFinding> {
  const rows = await db
    .select({
      slug: vendors.slug,
      name: vendors.companyName,
      verified: vendors.verified,
      status: vendorEntitlements.status,
      entitlementId: vendorEntitlements.id,
    })
    .from(vendors)
    .leftJoin(vendorEntitlements, eq(vendorEntitlements.vendorId, vendors.id))
    .where(
      or(
        // Verified, but no active entitlement backs it.
        and(
          eq(vendors.verified, true),
          or(isNull(vendorEntitlements.id), ne(vendorEntitlements.status, 'active')),
        ),
        // An active entitlement exists, but the mirror was never flipped.
        and(eq(vendors.verified, false), eq(vendorEntitlements.status, 'active')),
      ),
    )
    .orderBy(asc(vendors.companyName));

  return {
    lines: rows.map((r) => {
      const state =
        r.entitlementId === null ? 'no entitlement row' : `entitlement is '${r.status}'`;
      return `${r.name} (${r.slug}) — verified=${r.verified ? 1 : 0}, ${state}`;
    }),
  };
}

// ───────────────────────────── registry + orchestrator ───────────────────────

interface CheckSpec {
  id: string;
  label: string;
  severity: DataQualitySeverity;
  run: (deps: DataQualityDeps) => Promise<CheckFinding>;
}

/** The eleven checks in digest order (§23.1, plus the AECI-609 mirror guard).
 *  Severity drives the digest grouping and is informational on the gauge. */
export const CHECKS: CheckSpec[] = [
  {
    id: 'products_without_vendor',
    label: 'Products with no associated vendor',
    severity: 'warn',
    run: ({ db }) => checkProductsWithoutVendor(db),
  },
  {
    id: 'ready_products_unpromoted',
    label: `Products 'ready' >${READY_STALE_DAYS}d without promotion`,
    severity: 'warn',
    run: ({ db, now }) => checkStaleReadyProducts(db, now),
  },
  {
    id: 'broken_integration_refs',
    label: 'Integrations referencing a pulled (retracted/rejected) product',
    severity: 'error',
    run: ({ db }) => checkBrokenIntegrationRefs(db),
  },
  {
    id: 'vendors_without_products',
    label: 'Vendors with no products',
    severity: 'warn',
    run: ({ db }) => checkVendorsWithoutProducts(db),
  },
  {
    id: 'reviews_missing_anonymized_at',
    label: 'Anonymized reviews missing `anonymized_at`',
    severity: 'error',
    run: ({ db }) => checkReviewsMissingAnonymizedAt(db),
  },
  {
    id: 'stale_stats_cache',
    label: `Stale stats_cache rows (>${STATS_STALE_HOURS}h)`,
    severity: 'warn',
    run: ({ db, now }) => checkStaleStatsCache(db, now),
  },
  {
    id: 'duplicate_vendors',
    label: 'Duplicate vendor candidates (case/space-insensitive name)',
    severity: 'warn',
    run: ({ db }) => checkDuplicateVendors(db),
  },
  {
    id: 'duplicate_products',
    label: 'Duplicate product candidates (same name per vendor)',
    severity: 'warn',
    run: ({ db }) => checkDuplicateProducts(db),
  },
  {
    id: 'logo_404',
    label: 'Brandfetch logo URLs returning 404 (sample)',
    severity: 'warn',
    run: ({ db, fetchImpl, logoSampleSize }) =>
      checkLogo404Sample(db, fetchImpl ?? fetch, logoSampleSize ?? DEFAULT_LOGO_SAMPLE),
  },
  {
    id: 'algolia_index_drift',
    label: 'Algolia index drift (Supabase ≠ Algolia)',
    severity: 'warn',
    run: ({ runDrift }) => checkAlgoliaDrift(runDrift),
  },
  {
    id: 'entitlement_mirror_drift',
    label: 'Vendors whose `verified` flag disagrees with their entitlement',
    severity: 'error',
    run: ({ db }) => checkEntitlementMirrorDrift(db),
  },
];

/**
 * Run every §23.1 check, best-effort. A check that throws is captured as an
 * `error` result (severity `error`, `count: 0`) so one failure never aborts the
 * rest — the digest + the job's `outcome:failed` metric surface it.
 */
export async function runDataQualityChecks(
  deps: DataQualityDeps,
): Promise<DataQualityCheckResult[]> {
  const results: DataQualityCheckResult[] = [];
  for (const spec of CHECKS) {
    try {
      const { lines, note, skipped } = await spec.run(deps);
      results.push({
        id: spec.id,
        label: spec.label,
        severity: spec.severity,
        count: skipped ? 0 : lines.length,
        sample: lines.slice(0, SAMPLE_LIMIT),
        ...(note ? { note } : {}),
        ...(skipped ? { skipped } : {}),
      });
    } catch (error) {
      results.push({
        id: spec.id,
        label: spec.label,
        severity: 'error',
        count: 0,
        sample: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** True when the run found any defect or a check errored — drives `outcome` + the
 *  digest subject. Skipped checks (no creds) don't count as issues. */
export function hasFindings(results: DataQualityCheckResult[]): boolean {
  return results.some((r) => r.error !== undefined || r.count > 0);
}

/** True when any check threw — the run's `outcome:failed` signal. */
export function hasErrors(results: DataQualityCheckResult[]): boolean {
  return results.some((r) => r.error !== undefined);
}

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
 * All but one check the *catalog*. `arrival_cf_coverage` (AECI-868) checks the *telemetry
 * pipeline* that feeds every traffic figure, which is a deliberate widening of what
 * this suite is for: the four-day arrival-metadata outage it guards produced no
 * error, no alert and no visibly wrong number, so nothing but a nightly ratio could
 * have caught it. See `arrival-coverage.ts` for the full argument.
 *
 * **AECI-592 retired two checks and replaced them with one.** The original §23.1
 * roster carried "products stuck `promotion_status='ready'` >30d" and "integrations
 * referencing a pulled (retracted/rejected) product". Both were **structurally
 * dead**: nothing in this repo writes `'ready'`, `'retracted'` or `'rejected'` to
 * D1 — they are the review app's lifecycle stages, not ours — so both could only
 * ever return zero rows. Silently passing reads as coverage, which is worse than
 * failing. #2 `promotion_status_invariant` now asserts the invariant that made
 * them dead, so the day it stops holding is the day the suite says so.
 */

import { mapWithConcurrency, WORKER_CONNECTION_LIMIT } from '@aeci/shared/concurrency';
import { discardResponseBody } from '@aeci/shared/response-drain';

import type { AlgoliaIndexDrift } from './algolia-drift';
import { ARRIVAL_CF_COVERAGE_MIN, readArrivalCfCoverage } from './arrival-coverage';
import { textAsc } from './collation';
import {
  and,
  asc,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  products,
  productVendors,
  reviews,
  statsCache,
  vendorEntitlements,
  vendors,
} from '../db/schema';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The one `promotion_status` value any AECi code path writes — see check #2. */
const PROMOTED = 'promoted';
/** A `stats_cache` row older than this signals a stalled stats pipeline. */
const STATS_STALE_HOURS = 48;
/** Default number of logo URLs probed per run (sample check, not exhaustive). */
const DEFAULT_LOGO_SAMPLE = 20;
/** Per-logo HTTP timeout so a slow/hung CDN can't stall the cron. */
const LOGO_FETCH_TIMEOUT_MS = 5_000;
/** Max sample lines surfaced per check in the digest (the full count is exact). */
export const SAMPLE_LIMIT = 10;
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
   *  `algolia_index_drift` is skipped (no Algolia creds — the local/preview default). */
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
    .orderBy(textAsc(products.name));
  return { lines: rows.map((r) => `${r.name} (${r.slug})`) };
}

/**
 * #2 — every `products` and `vendors` row must read `promotion_status='promoted'`.
 *
 * **This is an invariant guard, not a coverage report** (AECI-592). It replaced two
 * checks that were structurally unreachable: "products stuck `'ready'` >30d" and
 * "integrations referencing a pulled (retracted/rejected) product". `POST /api/promote`
 * is D1's only INSERT path into either table and hard-codes `'promoted'` on all four
 * of its branches (`routes/promote.ts`); the wire payload carries no status field, so
 * a caller cannot supply one; and retraction is a hard DELETE (`lib/retract-product.ts`),
 * not a status transition. So the other four CHECK values live in the review app, never
 * here — which is exactly why both retired checks returned zero rows on every run.
 *
 * Four shipped code paths reason from that invariant, and every one of them fails
 * **silently** if it stops holding:
 *   - `ADMIN_PANEL_SPEC.md` §13 D6 — `products.created_at` is the exact first-promote
 *     timestamp, which is what makes the catalog counts-over-time series exact;
 *   - `lib/metrics-snapshot.ts` — the `catalog.products_promoted` / `_vendors_promoted`
 *     daily keys;
 *   - `lib/metrics-backfill.ts` — the historical reconstruction of those keys;
 *   - `db/schema.ts` — the `promotedAt` set-once rationale.
 *
 * A Tier-1 retract endpoint writing `'retracted'` instead of hard-deleting is the
 * obvious way that happens, and there is no lint rule on this column. `error` severity
 * because the failure mode is wrong numbers that still render, not a broken page.
 *
 * Deliberate trade from folding the old #3 in: this names the offending **catalog row**,
 * not the integrations that point at it. Once a product is off-`promoted`, finding its
 * edges is a follow-up query, not a second daily check.
 */
export async function checkPromotionStatusInvariant(db: Db): Promise<CheckFinding> {
  const [badProducts, badVendors] = await Promise.all([
    db
      .select({ slug: products.slug, name: products.name, status: products.promotionStatus })
      .from(products)
      .where(ne(products.promotionStatus, PROMOTED))
      .orderBy(textAsc(products.name)),
    db
      .select({ slug: vendors.slug, name: vendors.companyName, status: vendors.promotionStatus })
      .from(vendors)
      .where(ne(vendors.promotionStatus, PROMOTED))
      .orderBy(textAsc(vendors.companyName)),
  ]);
  return {
    lines: [
      ...badProducts.map((r) => `product "${r.name}" (${r.slug}) — ${r.status}`),
      ...badVendors.map((r) => `vendor "${r.name}" (${r.slug}) — ${r.status}`),
    ],
  };
}

/** #4 — vendors with no row in `product_vendors`. */
export async function checkVendorsWithoutProducts(db: Db): Promise<CheckFinding> {
  const withProduct = db.select({ id: productVendors.vendorId }).from(productVendors);
  const rows = await db
    .select({ slug: vendors.slug, name: vendors.companyName })
    .from(vendors)
    .where(notInArray(vendors.id, withProduct))
    .orderBy(textAsc(vendors.companyName));
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
    .orderBy(textAsc(vendors.companyName));

  return {
    lines: rows.map((r) => {
      const state =
        r.entitlementId === null ? 'no entitlement row' : `entitlement is '${r.status}'`;
      return `${r.name} (${r.slug}) — verified=${r.verified ? 1 : 0}, ${state}`;
    }),
  };
}

/**
 * #12 — arrival network-metadata coverage over the last 24 h (AECI-868).
 *
 * The one check in this suite that watches the telemetry pipeline rather than the
 * catalog. Fails when full-document arrivals exist and fewer than
 * {@link ARRIVAL_CF_COVERAGE_MIN} of them carry a `cf_asn`; passes when there were
 * no arrivals at all, because an empty night is not a defect.
 *
 * ⚠️ Its `count` is **1 when tripped, not a row count** — unlike every other check
 * here, whose `count` is "how many offending rows". One summary line is the point:
 * the finding is a *ratio*, and emitting a line per NULL row would put thousands of
 * identical lines in the digest and set the `aeci.data_quality.check` gauge to a
 * number that tracks traffic volume rather than severity. The numbers live in the
 * line and the note, where they are read, not in the gauge, where they would be
 * misinterpreted.
 *
 * Severity is `error` in {@link CHECKS}: a warn would land in the digest's clean-ish
 * tail, and the defect it guards ran four days on production while every figure
 * built on it kept rendering.
 */
export async function checkArrivalCfCoverage(db: Db, now: Date): Promise<CheckFinding> {
  const endIso = now.toISOString();
  const startIso = new Date(now.getTime() - DAY_MS).toISOString();
  const { arrivals, arrivalsWithAsn, coverage } = await readArrivalCfCoverage(db, startIso, endIso);

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  if (arrivals === 0) {
    return { lines: [], note: 'no full-document arrivals in the last 24h — nothing to measure' };
  }
  const observed = `${arrivalsWithAsn}/${arrivals} arrivals carry cf_asn (${pct(coverage)}, floor ${pct(ARRIVAL_CF_COVERAGE_MIN)})`;
  if (coverage >= ARRIVAL_CF_COVERAGE_MIN) return { lines: [], note: observed };
  return {
    lines: [
      `${arrivals - arrivalsWithAsn} of ${arrivals} full-document arrivals have a NULL cf_asn — ` +
        `coverage ${pct(coverage)} is below the ${pct(ARRIVAL_CF_COVERAGE_MIN)} floor. ` +
        `The SSR arrival write lost request.cf; check the cache gateway's cf merge (AECI-868).`,
    ],
    note: observed,
  };
}

// ───────────────────────────── registry + orchestrator ───────────────────────

interface CheckSpec {
  id: string;
  label: string;
  severity: DataQualitySeverity;
  run: (deps: DataQualityDeps) => Promise<CheckFinding>;
}

/** The eleven checks in digest order (§23.1, less the two AECI-592 retired, plus the
 *  AECI-609 mirror guard and the AECI-868 telemetry tripwire). Severity drives the
 *  digest grouping and is informational on the gauge. */
export const CHECKS: CheckSpec[] = [
  {
    id: 'products_without_vendor',
    label: 'Products with no associated vendor',
    severity: 'warn',
    run: ({ db }) => checkProductsWithoutVendor(db),
  },
  {
    id: 'promotion_status_invariant',
    label: `Catalog rows not at promotion_status='${PROMOTED}'`,
    severity: 'error',
    run: ({ db }) => checkPromotionStatusInvariant(db),
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
  {
    id: 'arrival_cf_coverage',
    label: 'Full-document arrivals missing their network metadata (`cf_asn`)',
    severity: 'error',
    run: ({ db, now }) => checkArrivalCfCoverage(db, now),
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

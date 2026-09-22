/**
 * The §23.1 daily data-quality suite (AECI-241 / Phase 7.6).
 *
 * Read-only integrity checks over the D1 catalog, run from the 04:00 UTC cron
 * (`scheduled.ts`) and summarised in the email digest (`data-quality-email.ts`).
 * **Report-only** — no auto-remediation; the digest + the per-check Datadog gauge
 * are how humans triage (§23.1).
 *
 * Each check is a pure async fn over an injected surface (the Drizzle `Db`, plus
 * an injected `fetch` for the logo probe and an injected closure for the reused
 * AECI-140 Algolia-drift count), so every check unit-tests against the in-memory
 * D1 harness (`test/d1.ts`) with no network. The orchestrator
 * `runDataQualityChecks` runs them all best-effort: a check that throws becomes an
 * `error` result rather than aborting the run.
 *
 * All but **two** check the *catalog*. `arrival_cf_coverage` (AECI-868) and
 * `landing_cf_coverage` (AECI-876) check the *telemetry pipeline* instead, which is a
 * deliberate widening of what this suite is for: the four-day arrival-metadata outage
 * the first one guards produced no error, no alert and no visibly wrong number, so
 * nothing but a nightly ratio could have caught it. See `arrival-coverage.ts` for the
 * full argument.
 *
 * The two are siblings, not duplicates — Cloudflare context reaches D1 down two
 * independent paths, and each watches one. `arrival_cf_coverage` watches the SSR
 * arrival write into `page_views` (`PAGE_VIEW_CF_HEADERS`, a GET); `landing_cf_coverage`
 * watches the lead-capture write into `mailing_list` (`LANDING_CF_HEADERS`, a POST).
 * They differ in severity, window and floor for reasons recorded on each function, and
 * those differences are load-bearing rather than drift.
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
  gte,
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
  integrations,
  mailingList,
  products,
  productVendors,
  reviews,
  statsCache,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyDataObjects,
  taxonomyPhases,
  taxonomyTrades,
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

/**
 * The window `landing_cf_coverage` measures over (AECI-876).
 *
 * Thirty days, not the arrival check's twenty-four hours, because the two
 * populations differ by orders of magnitude. `mailing_list` is deduplicated by
 * email, so a row is a *new subscriber*; a day's worth of them is not a
 * denominator a ratio can be built on.
 */
const LANDING_CF_WINDOW_DAYS = 30;

/**
 * The minimum share of windowed signups that must carry an `asn` before
 * `landing_cf_coverage` fails (AECI-876).
 *
 * **Read this together with {@link LANDING_CF_COVERAGE_MIN_ROWS} — the two were
 * chosen as a pair and neither is meaningful alone.** For a single legitimate
 * NULL to be survivable, the denominator has to satisfy `N >= 1 / (1 - floor)`.
 * At `0.9` that is ten rows, which is the minimum below. Raising this floor to
 * the arrival check's `0.95` without also raising the minimum to twenty would
 * make one odd row a failing run.
 */
export const LANDING_CF_COVERAGE_MIN = 0.9;

/**
 * Below this many signups in the window, `landing_cf_coverage` reports "nothing
 * to measure" and passes (AECI-876).
 *
 * The same argument as the arrival check passing on an empty night, one step
 * further: an empty window is not a telemetry defect, and neither is a window too
 * small to support a ratio. Ten is the value that makes
 * {@link LANDING_CF_COVERAGE_MIN} survive one legitimate NULL — see there.
 */
export const LANDING_CF_COVERAGE_MIN_ROWS = 10;

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
 * #13 — a LIVE taxonomy term with no description (AECI-962).
 *
 * ── WHY THIS IS NOT DEAD CODE ───────────────────────────────────────────────────
 * AECI-592 retired two checks for being structurally unreachable, and the obvious
 * reading of this one is that `seed/taxonomy.sql` populates all 73 terms so it can
 * only ever return zero. That reading is wrong, and the distinction is the whole
 * point: the seed is not the only writer. `resolveTaxonomy` (`routes/promote.ts`)
 * resolves categories, audiences and phases FIND-OR-CREATE, and its mint writes
 * `{ id, slug, name }` alone — no `description`, no `display_order`. So a promote
 * whose incoming label does not slugify to a seeded slug silently creates a real
 * term, with a real public browse URL, and no description.
 *
 * That is not hypothetical either. It is exactly how production came to hold a
 * duplicate `Reality Capture (Scan-to-BIM)` category for weeks (AECI-926), found by
 * eye in a screenshot rather than by any check.
 *
 * `severity: 'error'` because the string is not decoration: it is the paragraph on
 * the browse page AND that page's meta description, so a null one puts an indexable
 * page on the site-wide default.
 *
 * The seed half is guarded separately, at build time, by
 * `src/test/taxonomy-seed-slugs.spec.ts`. Trades and data objects are included here
 * even though they resolve find-only and cannot be minted — they are cheap, and the
 * check is about the rendered page, not about who wrote the row. Note that
 * `taxonomy_trades.description` is NOT NULL, so a trade can only ever fail on the
 * blank-string arm; that arm is why the predicate is not a bare `IS NULL`.
 */
export async function checkTaxonomyMissingDescription(db: Db): Promise<CheckFinding> {
  const tables = [
    ['category', taxonomyCategories],
    ['audience', taxonomyAudiences],
    ['phase', taxonomyPhases],
    ['trade', taxonomyTrades],
    ['data_object', taxonomyDataObjects],
  ] as const;

  const lines: string[] = [];
  for (const [kind, table] of tables) {
    const rows = await db
      .select({ slug: table.slug, name: table.name })
      .from(table)
      .where(or(isNull(table.description), eq(sql`trim(${table.description})`, '')))
      .orderBy(textAsc(table.name));
    lines.push(...rows.map((r) => `${r.name} (${kind}/${r.slug})`));
  }
  return { lines };
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
 * #14 — a retired integration its owner never claimed (AECI-1010).
 *
 * Only the owner can retire, and only after a claim, so `retired_at IS NOT NULL`
 * implies `claimed_at IS NOT NULL`. That cannot be a CHECK constraint: adding one to
 * `integrations` makes drizzle-kit recreate the table, and a recreate cascades away
 * its claims and attestations (`docs/migrations.md` §3.3a). So it is checked here.
 *
 * A finding means some writer other than the retire route set `retired_at`. Promote
 * never writes the column. The row is hidden from every public read, and no owner can
 * restore it, because nobody holds the claim. `error` severity: it is a row that has
 * fallen out of the catalogue with nobody able to bring it back. No seed writes
 * `retired_at`, so a clean environment reports zero.
 */
export async function checkRetiredIntegrationsUnclaimed(db: Db): Promise<CheckFinding> {
  const rows = await db
    .select({ id: integrations.id, name: integrations.name, retiredAt: integrations.retiredAt })
    .from(integrations)
    .where(and(isNotNull(integrations.retiredAt), isNull(integrations.claimedAt)))
    .orderBy(asc(integrations.id));
  return {
    lines: rows.map((r) => `${r.name ?? '(unnamed)'} (${r.id}) retired ${r.retiredAt}, unclaimed`),
  };
}

/**
 * #15 — a vendor-created integration nobody holds a claim on (AECI-1011).
 *
 * A vendor create is born claimed. The one path that clears `claimed_at` is an AECi
 * admin accept of an `owner` contest that reassigns the row to another vendor or to
 * "neither" (`planAcceptWrites` in `routes/admin-contests.ts`). For a promote-seeded
 * row that is fine: promote writes it again. A vendor-created row has no upstream
 * record, so promote never will, and until the new owner claims it nobody can edit or
 * retire it. `warn`, not `error`: the row is still public and correct as it stands,
 * and the fix is a claim by the new owner, or a `REVIEW - ` issue when the accept said
 * "neither". No seed writes `origin = 'vendor'`, so a clean environment reports zero.
 */
export async function checkVendorIntegrationsUnclaimed(db: Db): Promise<CheckFinding> {
  const rows = await db
    .select({
      id: integrations.id,
      name: integrations.name,
      builtByVendorId: integrations.builtByVendorId,
    })
    .from(integrations)
    .where(and(eq(integrations.origin, 'vendor'), isNull(integrations.claimedAt)))
    .orderBy(asc(integrations.id));
  return {
    lines: rows.map(
      (r) =>
        `${r.name ?? '(unnamed)'} (${r.id}) vendor-created, unclaimed, owner ${r.builtByVendorId ?? 'none'}`,
    ),
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

/**
 * Lead-capture network-metadata coverage over the last 30 days (AECI-876), last
 * in digest order.
 *
 * Deliberately not given a `#N` label: the numbering in the comments above is
 * addition order, not registry order, and `#13` is already taken by
 * `checkTaxonomyMissingDescription` even though that one runs second.
 *
 * The second check here that watches the telemetry pipeline rather than the
 * catalog, and the sibling of {@link checkArrivalCfCoverage} on the *other* path
 * Cloudflare context travels.
 *
 * ─── What it measures ──────────────────────────────────────────────────────
 *
 * `POST /api/subscribe` stores seven CF fields on `mailing_list`. They do not
 * come from the request body — the browser cannot read `request.cf` — but from
 * the trusted `LANDING_CF_HEADERS` the SSR Worker sets in
 * `withForwardedLandingCf` (`apps/web/src/server-runtime.ts`) and the API parses
 * back in `readLandingCfFromHeaders` (`routes/landing-forms.ts`). If that hop
 * stops carrying them, every field on every new row goes NULL, nothing errors,
 * and the signup count stays normal. Exactly the AECI-868 defect class, on a
 * path nothing was watching.
 *
 * ─── Scope decisions ───────────────────────────────────────────────────────
 *
 * - **`mailing_list.asn` is the only probe, and that is sufficient for both
 *   tables.** `feedback` stores no `asn` / `as_organization` / `metro_code`
 *   column at all, so it cannot exhibit the failure — but both tables are filled
 *   from the *same* `readLandingCfFromHeaders` call on the same hop, so a break
 *   NULLs them together. A second probe over `feedback.country` would add a
 *   second tiny denominator and no detection power. `asn` is an integer, so
 *   "present" is unambiguous — the same reason `cf_asn` is the arrival probe.
 * - **No population filter.** A signup is a signup. This asks about the
 *   pipeline, not the audience.
 * - **Read-only, and unaudited.** `mailing_list` is log-class under ADR 0022
 *   (exemption EX-002 lists `routes/landing-forms.ts`), and this is a `SELECT`.
 *
 * ─── Two ways it differs from the arrival check, both deliberate ────────────
 *
 * - **Severity `warn`, not `error`.** The arrival check is `error` because a
 *   failing day invalidates every traffic figure on the dashboard — the ASN is
 *   an input to `DATACENTER_ASNS`, both swarm groupings and the visitor
 *   definition. `mailing_list.asn` has one reader — the `/admin/audience` ASN
 *   breakdown (`audienceAsnBreakdown`, `lib/admin-audience.ts`), a descriptive
 *   split that no other figure is built on. A failure here is a lost attribute,
 *   not an invalidated number, and `warn` routes it to the
 *   dashboard and the digest rather than to an alert
 *   (`POST_LAUNCH_MONITORING.md` §1 row 5a). It still shows as *failing* on
 *   `GET /api/admin/system`, which is what AECI-876 asked for: `admin-status.ts`
 *   keys "failing" on `count > 0`, not on severity.
 * - **Thirty days and a minimum denominator**, per
 *   {@link LANDING_CF_COVERAGE_MIN} and {@link LANDING_CF_COVERAGE_MIN_ROWS}.
 *   **The consequence is honest latency: this cannot detect a break "within a
 *   day".** At a few signups a day a total loss takes roughly three to five days
 *   to pull the window under the floor. A ratio needs a denominator, and there is
 *   no threshold that gives both low-volume stability and same-day detection.
 *
 * ⚠️ Like the arrival check, its `count` is **1 when tripped, not a row count**.
 * The finding is a ratio; a per-row line would set the `aeci.data_quality.check`
 * gauge to a number that tracks signup volume instead of severity.
 */
export async function checkLandingCfCoverage(db: Db, now: Date): Promise<CheckFinding> {
  const startIso = new Date(now.getTime() - LANDING_CF_WINDOW_DAYS * DAY_MS).toISOString();
  const endIso = now.toISOString();

  // One SELECT with a conditional SUM rather than two queries, matching
  // `readArrivalCfCoverage`: a single scan guarantees the numerator can never be
  // measured against a denominator read at a different instant.
  const [row] = await db
    .select({
      signups: count(),
      // SUM over zero rows is NULL in SQLite, so this is coerced below rather
      // than trusted.
      signupsWithAsn: sql<
        number | null
      >`sum(case when ${mailingList.asn} is not null then 1 else 0 end)`,
    })
    .from(mailingList)
    .where(and(gte(mailingList.createdAt, startIso), lt(mailingList.createdAt, endIso)));

  const signups = Number(row?.signups ?? 0);
  const signupsWithAsn = Number(row?.signupsWithAsn ?? 0);

  if (signups < LANDING_CF_COVERAGE_MIN_ROWS) {
    return {
      lines: [],
      note:
        `${signups} signups in the last ${LANDING_CF_WINDOW_DAYS}d, below the ` +
        `${LANDING_CF_COVERAGE_MIN_ROWS}-row minimum — nothing to measure`,
    };
  }

  const coverage = signupsWithAsn / signups;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const observed =
    `${signupsWithAsn}/${signups} signups carry an asn ` +
    `(${pct(coverage)}, floor ${pct(LANDING_CF_COVERAGE_MIN)}, ${LANDING_CF_WINDOW_DAYS}d)`;
  if (coverage >= LANDING_CF_COVERAGE_MIN) return { lines: [], note: observed };

  return {
    lines: [
      `${signups - signupsWithAsn} of ${signups} mailing_list signups in the last ` +
        `${LANDING_CF_WINDOW_DAYS}d have a NULL asn — coverage ${pct(coverage)} is below the ` +
        `${pct(LANDING_CF_COVERAGE_MIN)} floor. The landing write lost request.cf; check ` +
        `withForwardedLandingCf on the SSR /api/* passthrough (AECI-876). This path is a POST, ` +
        `so the AECI-868 cache-gateway cf override is NOT the cause.`,
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

/** The checks in digest order (§23.1, less the two AECI-592 retired, plus the
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
    id: 'taxonomy_missing_description',
    label: 'Live taxonomy terms with no description',
    severity: 'error',
    run: ({ db }) => checkTaxonomyMissingDescription(db),
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
  {
    id: 'retired_integration_unclaimed',
    label: 'Retired integrations with no owner claim',
    severity: 'error',
    run: ({ db }) => checkRetiredIntegrationsUnclaimed(db),
  },
  {
    id: 'vendor_integration_unclaimed',
    label: 'Vendor-created integrations with no owner claim',
    severity: 'warn',
    run: ({ db }) => checkVendorIntegrationsUnclaimed(db),
  },
  {
    id: 'landing_cf_coverage',
    label: 'Mailing-list signups missing their network metadata (`asn`)',
    severity: 'warn',
    run: ({ db, now }) => checkLandingCfCoverage(db, now),
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

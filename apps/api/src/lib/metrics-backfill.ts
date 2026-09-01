/**
 * The `metrics_daily` historical backfill (AECI-581 / `ADMIN_PANEL_SPEC.md` §7.1).
 *
 * The snapshot cron (`./metrics-snapshot`) can only tell the truth from the day it
 * starts running. This module reconstructs the segment before it, from the two
 * row stores that survived: `page_views` and the `audit_log` event stream — plus
 * `products.created_at`, which §4's correction shows is the one exactly
 * recoverable catalog series.
 *
 * It is the tested **SQL-building core**; `scripts/backfill-metrics-daily.ts` is
 * the Node shell that runs the statements through `wrangler d1 execute` (same
 * split as `retract-product.ts` / `reconcile-product-counts.ts`). SQL rather than
 * Drizzle because a backfill has to run against a *deployed* D1 from a laptop,
 * where there is no Worker and no `DB` binding.
 *
 * ─── What is honest to reconstruct, and what is not ──────────────────────────
 *
 * **Flows only.** Every series here counts events inside a day from a durable
 * per-row timestamp. The `metrics_daily` *stock* metrics (catalog totals, queue
 * depths, subscriber counts) are deliberately **not** backfilled: §4 shows a past
 * total cannot be recovered — 827 `integration.created` events back 496 live rows
 * — so a cumulative sum would not be an approximation, it would be wrong. Those
 * series simply begin at the first cron run.
 *
 * **`measured` vs `reconstructed`.** Three of the eight are approximate and say
 * so; five are exact and say that:
 *
 * | series | source | why |
 * |---|---|---|
 * | `traffic.*` | measured | re-aggregates the same `page_views` rows the live endpoint reads — flagging one and not the other would be incoherent |
 * | `accounts.sign_ins_new` | measured | `profiles.created_at`, a durable per-row stamp |
 * | `catalog.products_created` | measured | §4's exception — `products.created_at` IS the first-promote timestamp, and it is *better* than the audit log (which covers 131 of 171 rows) |
 * | `catalog.{integrations,vendors,claims}_created` | reconstructed | `audit_log` `*.created` events, which outlive the rows they describe |
 *
 * The traffic label carries a precondition the shell enforces: `is_bot IS NULL`
 * rows read as human (AECI-582), so backfilling a range containing them would
 * freeze the wrong human/bot split into the long memory permanently. The script
 * refuses such a range without `--force`.
 *
 * ─── Precedence, which is what makes a re-run safe ───────────────────────────
 *
 * A `measured` write always wins; a `reconstructed` write applies only over an
 * absent or already-`reconstructed` row. So:
 *
 *   - the zero-fill pass is `DO NOTHING` — a placeholder never overwrites anything;
 *   - `measured` series upsert unconditionally (they are as good as the cron's);
 *   - `reconstructed` series upsert `WHERE metrics_daily.source = 'reconstructed'`,
 *     so a real same-day snapshot is never downgraded to an approximation.
 *
 * ─── Why zero-fill at all ────────────────────────────────────────────────────
 *
 * §7.4 forbids the future pruning cron from deleting raw `page_views` for a day
 * `metrics_daily` has not captured. A quiet day that produced no rows would
 * otherwise have no snapshot at all and block pruning forever — so the range is
 * filled edge to edge and the aggregate pass overwrites the days that had data.
 */

import {
  ADMIN_METRIC_KEYS,
  UNTRACKED_ROUTE_PREFIXES,
  type AdminMetricKey,
  type AdminSnapshotSource,
} from '@aeci/shared';

import { shiftDay } from './admin-analytics';
import { OPERATOR_PAIR_LOOKBACK_DAYS } from './page-view-predicates';

/** Rows per multi-VALUES `INSERT`. Small enough to keep each statement well
 *  inside D1's per-statement limits, large enough that a 400-day range is ~16
 *  statements rather than 3,200. */
const ZERO_FILL_CHUNK = 200;

export interface BackfillRange {
  /** First UTC day to reconstruct, `YYYY-MM-DD` (inclusive). */
  fromDay: string;
  /** Last UTC day to reconstruct, `YYYY-MM-DD` (inclusive). */
  toDay: string;
  /** `computed_at` stamped on every row this run writes. */
  computedAt: string;
}

/** SQL string literal with the one escape SQLite needs. Every value reaching
 *  here is repo-controlled (a validated day label, an ISO instant, a metric key
 *  from the shared const), so this is belt-and-braces rather than the guard. */
function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Half-open `[start, end)` ISO bounds for the inclusive day range — the same
 *  window shape `lib/admin-analytics.ts` builds, so the reconstructed values land
 *  in exactly the buckets the live path would compute. */
export function isoBounds(range: BackfillRange): { startIso: string; endIso: string } {
  return {
    startIso: `${range.fromDay}T00:00:00.000Z`,
    endIso: `${shiftDay(range.toDay, 1)}T00:00:00.000Z`,
  };
}

/** Every `YYYY-MM-DD` in the inclusive range. */
export function daysInRange(range: BackfillRange): string[] {
  const out: string[] = [];
  for (let day = range.fromDay; day <= range.toDay; day = shiftDay(day, 1)) out.push(day);
  return out;
}

/**
 * Raw-SQL restatement of `analytics-digest.ts`'s `NOT_INTERNAL`, for the ops
 * script's hand-built statements. All three halves.
 *
 * This is the one place in the codebase that cannot import the Drizzle predicate
 * — the backfill emits SQL text for `wrangler d1 execute` — so it is also the one
 * place that can silently drift, and it HAD drifted: it carried only the §9.6
 * path exclusion and none of the `is_operator` half, from the day §13 D13 shipped
 * (2026-08-19) until AECI-683. Any range re-backfilled in that period would have
 * written operator traffic into `metrics_daily`, which is retained indefinitely.
 *
 * `metrics-backfill.spec.ts` now asserts every clause is present. If you add a
 * fourth half to `NOT_INTERNAL`, add it here in the same change.
 *
 * The `NOT EXISTS` retro-join (AECI-683) is reproduced verbatim rather than
 * approximated: on rows predating D13 `is_operator` is NULL everywhere, so the
 * pair join is the ONLY half that can reach the operator's historical public
 * browsing at all — which is exactly the population
 * `scripts/ops/2026-08-operator-page-view-backfill/` was written to flag by hand.
 */
function notInternalSql(): string {
  const paths = UNTRACKED_ROUTE_PREFIXES.flatMap((prefix) => [
    `"path" NOT LIKE ${q(prefix)}`,
    `"path" NOT LIKE ${q(`${prefix}/%`)}`,
  ]);
  return [
    ...paths,
    `("is_operator" IS NULL OR "is_operator" = 0)`,
    `NOT EXISTS (SELECT 1 FROM page_views AS op WHERE op."is_operator" = 1 ` +
      `AND op."user_agent_hash" = page_views."user_agent_hash" ` +
      `AND op."cf_asn" = page_views."cf_asn" ` +
      `AND op."created_at" >= strftime('%Y-%m-%dT%H:%M:%fZ', page_views."created_at", ${q(`-${OPERATOR_PAIR_LOOKBACK_DAYS} days`)}) ` +
      `AND op."created_at" <= strftime('%Y-%m-%dT%H:%M:%fZ', page_views."created_at", ${q(`+${OPERATOR_PAIR_LOOKBACK_DAYS} days`)}))`,
  ].join(' AND ');
}

/** `is_bot IS NOT 1`, the digest's NULL-safe human predicate — pre-classification
 *  rows count as human rather than vanishing. Mirrors `HUMAN` in
 *  `analytics-digest.ts`; `bot` is its complement. */
function populationSql(population: 'human' | 'bot'): string {
  return population === 'human' ? '"is_bot" IS NOT 1' : '"is_bot" = 1';
}

export interface BackfillSeries {
  metric: AdminMetricKey;
  source: AdminSnapshotSource;
  /** Why this series carries that source — surfaced by the script's dry run so an
   *  operator sees the honesty call before applying it. */
  rationale: string;
  /** `SELECT <day>, <value>` grouped by day over the range. */
  select(range: BackfillRange): string;
}

function pageViewsSeries(
  metric: AdminMetricKey,
  population: 'human' | 'bot',
  valueExpr: string,
  rationale: string,
): BackfillSeries {
  return {
    metric,
    source: 'measured',
    rationale,
    select: (range) => {
      const { startIso, endIso } = isoBounds(range);
      return (
        `SELECT substr("created_at", 1, 10) AS day, ${valueExpr} AS value FROM page_views ` +
        `WHERE "created_at" >= ${q(startIso)} AND "created_at" < ${q(endIso)} ` +
        `AND ${populationSql(population)} AND ${notInternalSql()} ` +
        `GROUP BY 1`
      );
    },
  };
}

function countByCreatedAt(
  metric: AdminMetricKey,
  table: string,
  source: AdminSnapshotSource,
  rationale: string,
  extraWhere?: string,
): BackfillSeries {
  return {
    metric,
    source,
    rationale,
    select: (range) => {
      const { startIso, endIso } = isoBounds(range);
      return (
        `SELECT substr("created_at", 1, 10) AS day, count(*) AS value FROM ${table} ` +
        `WHERE "created_at" >= ${q(startIso)} AND "created_at" < ${q(endIso)}` +
        `${extraWhere ? ` AND ${extraWhere}` : ''} ` +
        `GROUP BY 1`
      );
    },
  };
}

function auditSeries(metric: AdminMetricKey, action: string, entity: string): BackfillSeries {
  return countByCreatedAt(
    metric,
    'audit_log',
    'reconstructed',
    `${action} events outlive the rows they describe (§4), so this is an upper bound on ${entity} that existed`,
    `"action" = ${q(action)}`,
  );
}

/**
 * Flow series that a single grouped SELECT can reconstruct, in
 * `ADMIN_METRIC_KEYS` order.
 *
 * **`traffic.page_views_human_after_automation` is deliberately NOT here**
 * (AECI-745), and that is a correctness decision rather than an omission. This
 * module reconstructs a series by emitting ONE SQL statement per series and
 * handing it to `wrangler d1 execute`; the automation filter is not one
 * statement. `detectSwarms` groups candidates, applies a cross-day recurrence
 * lookback, and then counts the UNION of three shapes — expressing that as a
 * generated SELECT would put a SECOND definition of "flagged" in the codebase,
 * which is exactly the divergence AECI-745 was opened to close, and the copy
 * would drift the first time a threshold moved.
 *
 * So that series fills FORWARD from the day the 00:15 cron first writes it, and
 * the read path reports the days it does not cover as absent rather than zero
 * (`metricIsSnapshotOnly` in `admin-analytics.ts`). A gap that says "not measured"
 * is honest; a reconstructed number computed by a near-copy of the detector is
 * not.
 *
 * `traffic.unique_visitors` uses §9.8's visitor definition verbatim —
 * `DISTINCT (user_agent_hash, cf_asn)` with `coalesce` so a NULL component gets a
 * stable bucket instead of dropping the row. Note it does not sum across days;
 * each bucket is its own aggregate, which is exactly what a per-day snapshot row
 * should hold.
 */
export const BACKFILL_SERIES: readonly BackfillSeries[] = [
  pageViewsSeries(
    'traffic.page_views_human',
    'human',
    'count(*)',
    'the same page_views rows the live endpoint aggregates',
  ),
  pageViewsSeries(
    'traffic.page_views_bot',
    'bot',
    'count(*)',
    'the same page_views rows the live endpoint aggregates',
  ),
  pageViewsSeries(
    'traffic.unique_visitors',
    'human',
    `count(distinct coalesce("user_agent_hash", '') || '|' || coalesce("cf_asn", ''))`,
    'the same page_views rows the live endpoint aggregates',
  ),
  // §4's exception (§13 D6): promote is D1's only INSERT path into `products`,
  // nothing ever writes 'ready'/'pending', and retraction hard-deletes — so
  // `created_at` IS the first-promote timestamp. This is not just as good as the
  // audit log, it is better: `product.created` covers 131 of 171 rows.
  countByCreatedAt(
    'catalog.products_created',
    'products',
    'measured',
    'products.created_at is the exact first-promote timestamp (§4 correction / D6)',
  ),
  auditSeries('catalog.integrations_created', 'integration.created', 'integrations'),
  auditSeries('catalog.vendors_created', 'vendor.created', 'vendors'),
  auditSeries('catalog.claims_created', 'claim.created', 'claims'),
  countByCreatedAt(
    'accounts.sign_ins_new',
    'profiles',
    'measured',
    'profiles.created_at is a durable per-row stamp',
  ),
];

/**
 * Flow metrics with no SQL-reconstructable form, excluded from the guard below.
 *
 * Named as a list rather than a count so adding a metric still trips the guard:
 * the failure this protects against is a new key silently going un-backfilled,
 * and "the numbers still add up" must not be a way to pass.
 */
const NOT_BACKFILLABLE: readonly AdminMetricKey[] = ['traffic.page_views_human_after_automation'];

/* c8 ignore start -- a compile-time completeness guard, not a runtime branch. */
{
  const expected = ADMIN_METRIC_KEYS.length - NOT_BACKFILLABLE.length;
  if (BACKFILL_SERIES.length !== expected) {
    throw new Error(
      `BACKFILL_SERIES covers ${BACKFILL_SERIES.length} of ${expected} backfillable flow metrics ` +
        `(${ADMIN_METRIC_KEYS.length} total, ${NOT_BACKFILLABLE.length} excluded: ${NOT_BACKFILLABLE.join(', ')})`,
    );
  }
  const covered = new Set(BACKFILL_SERIES.map((s) => s.metric));
  const missing = ADMIN_METRIC_KEYS.filter((k) => !covered.has(k) && !NOT_BACKFILLABLE.includes(k));
  if (missing.length > 0) {
    throw new Error(`BACKFILL_SERIES is missing: ${missing.join(', ')}`);
  }
}
/* c8 ignore stop */

/**
 * Placeholder rows for every `(day, metric)` in the range, at value 0 and the
 * series' own provenance.
 *
 * `DO NOTHING`, always: a zero is a stand-in for "we looked and there was
 * nothing", and it must never displace a real value — not one the aggregate pass
 * is about to write, and certainly not one the cron already captured.
 */
export function buildZeroFillStatements(range: BackfillRange): string[] {
  const rows: string[] = [];
  for (const day of daysInRange(range)) {
    for (const series of BACKFILL_SERIES) {
      rows.push(`(${q(day)}, ${q(series.metric)}, 0, ${q(series.source)}, ${q(range.computedAt)})`);
    }
  }
  const statements: string[] = [];
  for (let i = 0; i < rows.length; i += ZERO_FILL_CHUNK) {
    statements.push(
      `INSERT INTO metrics_daily ("day", "metric", "value", "source", "computed_at") VALUES ` +
        `${rows.slice(i, i + ZERO_FILL_CHUNK).join(', ')} ` +
        `ON CONFLICT ("day", "metric") DO NOTHING`,
    );
  }
  return statements;
}

/**
 * One `INSERT … SELECT … ON CONFLICT` per series — the DB does the aggregation,
 * so nothing streams through the ops script.
 *
 * The conflict clause carries the precedence rule: a `measured` series upserts
 * unconditionally, a `reconstructed` one only over a row that is itself
 * reconstructed. That single asymmetry is what lets this run any number of times,
 * in any order relative to the cron, without ever degrading a real snapshot.
 */
export function buildAggregateStatements(range: BackfillRange): string[] {
  return BACKFILL_SERIES.map((series) => {
    const guard =
      series.source === 'reconstructed' ? ` WHERE metrics_daily."source" = 'reconstructed'` : '';
    return (
      `INSERT INTO metrics_daily ("day", "metric", "value", "source", "computed_at") ` +
      `SELECT day, ${q(series.metric)}, value, ${q(series.source)}, ${q(range.computedAt)} ` +
      // `WHERE true` is not filler: SQLite cannot parse `INSERT … SELECT … ON
      // CONFLICT` without a WHERE clause, because `ON` would otherwise read as the
      // start of a join constraint.
      `FROM (${series.select(range)}) AS src WHERE true ` +
      `ON CONFLICT ("day", "metric") DO UPDATE SET ` +
      `"value" = excluded."value", "source" = excluded."source", "computed_at" = excluded."computed_at"` +
      guard
    );
  });
}

/** Zero-fill first, then the aggregates — the order matters only in that the
 *  aggregates must be able to overwrite the placeholders. */
export function buildMetricsBackfillStatements(range: BackfillRange): string[] {
  return [...buildZeroFillStatements(range), ...buildAggregateStatements(range)];
}

/**
 * Rows in the range whose `is_bot` was never classified. They read as HUMAN under
 * the digest's NULL-safe predicate, so a traffic backfill over a range containing
 * them freezes an inflated human count into a table §7.4 keeps forever — which is
 * why the script refuses to proceed on a non-zero result without `--force`.
 * AECI-582 (`scripts/ops/backfill-page-view-bots.sql`) is the fix.
 */
export function buildUnclassifiedProbe(range: BackfillRange): string {
  const { startIso, endIso } = isoBounds(range);
  return (
    `SELECT count(*) AS unclassified FROM page_views ` +
    `WHERE "created_at" >= ${q(startIso)} AND "created_at" < ${q(endIso)} ` +
    `AND "is_bot" IS NULL AND ${notInternalSql()}`
  );
}

/** Earliest and latest day with any data the backfill could reconstruct — the
 *  default range when the operator does not pass `--from`/`--to`. */
export function buildRangeProbe(): string {
  return (
    `SELECT min(day) AS first_day, max(day) AS last_day FROM (` +
    `SELECT substr("created_at", 1, 10) AS day FROM page_views UNION ALL ` +
    `SELECT substr("created_at", 1, 10) FROM audit_log UNION ALL ` +
    `SELECT substr("created_at", 1, 10) FROM products UNION ALL ` +
    `SELECT substr("created_at", 1, 10) FROM profiles` +
    `)`
  );
}

/**
 * What `metrics_daily` actually holds for the range, per provenance.
 *
 * The script reports this after applying rather than summing `meta.changes`:
 * D1 does not populate `changes` for an `INSERT … ON CONFLICT`, so a change count
 * would read 0 on a run that wrote thousands of rows — an operator would
 * reasonably conclude nothing happened. Counting the rows is the honest
 * confirmation, and it doubles as the §7.4 coverage check the pruning cron needs.
 */
export function buildCoverageProbe(range: BackfillRange): string {
  return (
    `SELECT count(*) AS rows_total, ` +
    `count(DISTINCT day) AS days_covered, ` +
    `sum(CASE WHEN "source" = 'reconstructed' THEN 1 ELSE 0 END) AS reconstructed ` +
    `FROM metrics_daily WHERE day >= ${q(range.fromDay)} AND day <= ${q(range.toDay)}`
  );
}

/**
 * The §7.1 cross-check: `products.created_at` against the `product.created`
 * events, reported by the dry run as a *verification* of the exact series, never
 * as its source. A shortfall on the audit side is expected — ~40 products predate
 * the log (131 events for 171 rows) — and is the evidence for D6's correction.
 */
export function buildProductsCrossCheck(): string {
  return (
    `SELECT (SELECT count(*) FROM products) AS products, ` +
    `(SELECT count(*) FROM audit_log WHERE "action" = 'product.created') AS product_created_events`
  );
}

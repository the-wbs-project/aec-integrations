/**
 * backfill-entitlements — the testable core of the §2.4 entitlement backfill ops CLI
 * (`apps/api/scripts/backfill-entitlements.ts`, AECI-609).
 *
 * WHY THIS EXISTS. Rows already `verified = 1` from the Airtable/claim era violate the
 * §2.1 mirror invariant the moment the `vendor_entitlements` table lands — they assert
 * "this vendor is verified" with no entitlement row behind it. This restores the
 * invariant on a deployed tier.
 *
 * WHY A SCRIPT AND NOT THE MIGRATION. `docs/migrations.md` (~:128, ~:249) is explicit:
 * one-off data backfills are scripts under `apps/api/scripts/`, run explicitly per
 * environment; migrations stay declarative. It also has to be per-tier, because the
 * fixture seeds (`catalog.sql`, `phase2-fixtures.sql`) never run remotely — only
 * `taxonomy.sql` + `data-objects.sql` do.
 *
 * WHAT IT WRITES. A perpetual, TERMLESS `active` row for every `verified = 1` vendor
 * with no entitlement row: `period_start` / `period_end` / `granted_by` all NULL, so
 * the partial index `vendor_entitlements_expiry_idx` ignores those rows entirely and
 * the §7 expiry cron never warns about them. The `notes` column carries the provenance.
 *
 * WHAT IT DELIBERATELY DOES NOT. It NEVER writes `vendors.verified`. The reverse drift
 * (an `active` entitlement on a `verified = 0` vendor) is REPORTED AND REFUSED, not
 * auto-repaired: moving the mirror outside `lib/vendor-entitlement.ts` is the exact
 * thing §2.1 forbids, and an ops script is not exempt. Reverse drift means a batch
 * half-landed and wants a human, not a sweep.
 *
 * PROOF IT LANDED is the `entitlement_mirror_drift` data-quality check (Guard 2, 04:00
 * UTC) — which is why §2 does not ship without it: "the backfill ran on staging but not
 * demo" is otherwise invisible until a reader notices a missing badge.
 *
 * CAVEAT (§26.1): a raw backfill writes no `audit_log` row — there is no handler to
 * route it through, exactly as with `retract-product.ts`. That is inherent to Tier 0;
 * `notes` carries the provenance instead, and the CLI prints the caveat.
 */

import { escapeSqlLiteral } from './retract-product';

/** The provenance stamp on every backfilled row (§2.4(2), verbatim). */
export const BACKFILL_NOTES =
  'backfilled at AECI-515 §2 — pre-entitlement Airtable/claim-era verification';

/** The tier a backfilled row lands on — the launch entry rung (§3.1). */
export const BACKFILL_TIER = 'verified';

/** A vendor needing a row: `verified = 1` with no `vendor_entitlements` row. */
export interface DriftedVendorRow {
  id: string;
  slug: string;
  company_name: string;
}

/** The reverse half — an `active` entitlement on an unverified vendor. Reported,
 *  never written: repairing it would mean this script moving the mirror. */
export interface ReverseDriftRow {
  id: string;
  slug: string;
  company_name: string;
  status: string;
}

/** Vendors the backfill will INSERT for. */
export function buildForwardDriftSql(): string {
  return [
    'SELECT v."id" AS "id", v."slug" AS "slug", v."company_name" AS "company_name"',
    'FROM "vendors" v',
    'WHERE v."verified" = 1',
    '  AND NOT EXISTS (SELECT 1 FROM "vendor_entitlements" e WHERE e."vendor_id" = v."id")',
    'ORDER BY v."company_name";',
  ].join('\n');
}

/** Vendors with an `active` entitlement but `verified = 0` — the refuse-and-report set. */
export function buildReverseDriftSql(): string {
  return [
    'SELECT v."id" AS "id", v."slug" AS "slug", v."company_name" AS "company_name", e."status" AS "status"',
    'FROM "vendors" v',
    'JOIN "vendor_entitlements" e ON e."vendor_id" = v."id"',
    'WHERE v."verified" = 0 AND e."status" = \'active\'',
    'ORDER BY v."company_name";',
  ].join('\n');
}

/**
 * One guarded INSERT per drifted vendor. `ids` are injected so the unit test is
 * deterministic; the CLI supplies `crypto.randomUUID()` — the same generator `uuidPk()`
 * uses. The `WHERE NOT EXISTS` re-guard makes a re-run a no-op even if the read and the
 * write race, so the script is safely repeatable rather than one-shot.
 */
export function buildBackfillStatements(
  rows: readonly DriftedVendorRow[],
  opts: { now: string; ids: readonly string[] },
): string[] {
  if (rows.length !== opts.ids.length) {
    throw new Error(`Need one id per row: ${rows.length} rows, ${opts.ids.length} ids.`);
  }
  const now = `'${escapeSqlLiteral(opts.now)}'`;
  const notes = `'${escapeSqlLiteral(BACKFILL_NOTES)}'`;
  const tier = `'${escapeSqlLiteral(BACKFILL_TIER)}'`;

  return rows.map((row, i) => {
    const id = `'${escapeSqlLiteral(opts.ids[i]!)}'`;
    const vendorId = `'${escapeSqlLiteral(row.id)}'`;
    return [
      'INSERT INTO "vendor_entitlements"',
      '  ("id","vendor_id","tier","status","period_start","period_end","granted_by","granted_at","notes","created_at","updated_at")',
      // Perpetual + termless: NULL period bounds keep these rows out of the partial
      // expiry index, so the §7 cron never warns about a backfilled arrangement.
      `SELECT ${id},${vendorId},${tier},'active',NULL,NULL,NULL,${now},${notes},${now},${now}`,
      `WHERE NOT EXISTS (SELECT 1 FROM "vendor_entitlements" e WHERE e."vendor_id" = ${vendorId});`,
    ].join('\n');
  });
}

/** The dry-run / post-apply report: both drift directions plus the counts. */
export function formatBackfillReport(
  forward: readonly DriftedVendorRow[],
  reverse: readonly ReverseDriftRow[],
): string {
  const lines: string[] = [];

  lines.push(`Forward drift (verified = 1, no entitlement row): ${forward.length}`);
  for (const r of forward) lines.push(`  + ${r.company_name} (${r.slug})`);
  if (forward.length === 0) lines.push('  (none — every verified vendor already has a row)');

  lines.push('');
  lines.push(`Reverse drift (active entitlement, verified = 0): ${reverse.length}`);
  for (const r of reverse)
    lines.push(`  ! ${r.company_name} (${r.slug}) — entitlement '${r.status}'`);
  if (reverse.length === 0) {
    lines.push('  (none)');
  } else {
    lines.push('');
    lines.push('  Reverse drift is NOT repaired here: this script never writes vendors.verified');
    lines.push(
      '  (STAGE_2_PAID_TIERS_SPEC.md §2.1 — only lib/vendor-entitlement.ts moves the mirror).',
    );
    lines.push('  It means a batch half-landed. Investigate before re-running.');
  }

  return lines.join('\n');
}

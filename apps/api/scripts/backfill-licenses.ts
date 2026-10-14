/**
 * backfill-licenses.ts — the E1.5 ops CLI that gives every existing vendor its billing
 * account and the licenses that mirror its entitlement row (AECI-1354,
 * `docs/VENDOR_SIGNUP_PROCESS.md` §5 E1, `docs/STAGE_2_PAID_TIERS_SPEC.md` §2.4). This
 * is the Node shell around the tested core (`src/lib/backfill-licenses.ts`): argv, the
 * `wrangler d1 execute` I/O, and `console`. Same shape as `backfill-entitlements.ts`.
 *
 * WHAT IT DOES:
 *   1. Probes the tier for migration 0073's tables, and refuses without them.
 *   2. Reads every vendor with a seat, an entitlement row or `verified = 1`, and the
 *      products they own.
 *   3. Plans, per vendor: the account (when missing), the licenses mapped from the
 *      entitlement row (active → live, expired/revoked → ended, pending → none), and
 *      one `billing_account.backfilled` audit row. See the core's header.
 *   4. Prints the report: counts, perpetual rows (no end date, need a date decision),
 *      zero-product vendors, mirror drift (refused, not repaired), and the live
 *      licenses whose `expiry_notice_sent_at` lags the entitlement's on the same term.
 *   5. On `--apply`, runs each vendor's statements as ONE `wrangler d1 execute`, so a
 *      vendor's account, licenses and audit row land together. Then runs the stamp
 *      reconcile (AECI-1356): per vendor, one execute holding its
 *      `license.expiry_stamp_reconciled` audit row and the UPDATE. Then re-reads
 *      `verified` against EXISTS(live license), failing on any drift it did not
 *      already refuse.
 *
 * SAFETY:
 *   - Dry-run by default; `--apply` writes.
 *   - Refuses `production` writes without `--allow-production`.
 *   - Never writes `vendors.verified`. A vendor whose mirror disagrees with its
 *     entitlement is refused and listed; the others are still written. The exit code
 *     is 1 when anything was refused, so the run reads as unfinished.
 *   - Idempotent: vendors already carrying a license are skipped, ids are UUIDv5, and
 *     every INSERT has a `WHERE NOT EXISTS` re-guard. The stamp reconcile only fills a
 *     NULL stamp. A re-run writes nothing.
 *
 * PROOF IT LANDED is the `license_mirror_drift` data-quality check (04:00 UTC) beside
 * `entitlement_mirror_drift`. Run this on EVERY deployed tier before the E1.6
 * switch-over, and AGAIN after the E1.6/E1.7 deploy and before the next 11:00 UTC
 * expiry run: the re-run copies any stamp the old sweep wrote in between.
 *
 * USAGE (from apps/api; remote needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
 *   pnpm --filter @aeci/api ops:backfill-licenses -- --local
 *   pnpm --filter @aeci/api ops:backfill-licenses -- --local --apply
 *   pnpm --filter @aeci/api ops:backfill-licenses -- --env staging
 *   pnpm --filter @aeci/api ops:backfill-licenses -- --env staging --apply --operator you@example.com
 *   pnpm --filter @aeci/api ops:backfill-licenses -- --env production --apply --allow-production
 */

import { spawnSync } from 'node:child_process';

import {
  LICENSE_TABLES_SQL,
  buildLicenseDriftSql,
  buildOwnedProductsSql,
  buildStampLagSql,
  buildStampReconcileStatements,
  buildVendorStatements,
  buildVendorsSql,
  countBackfill,
  formatLicenseBackfillReport,
  formatStampLagReport,
  planLicenseBackfill,
  planStampReconcile,
  type BackfillVendorRow,
  type LicenseDriftRow,
  type OwnedProductRow,
  type StampLagRow,
} from '../src/lib/backfill-licenses';

// ─── Args + target resolution (as backfill-entitlements.ts) ──────────────────

const D1_ENVS = ['staging', 'demo', 'production'] as const;
type D1Env = (typeof D1_ENVS)[number];

interface Target {
  label: string;
  db: string;
  flags: string[];
  remote: boolean;
}

function readValueFlag(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

function resolveTarget(argv: string[]): Target {
  if (argv.includes('--local')) {
    return { label: 'local', db: 'aeci-app-preview', flags: ['--local'], remote: false };
  }
  const env = readValueFlag(argv, '--env');
  if (!env || !(D1_ENVS as readonly string[]).includes(env)) {
    throw new Error(
      `Set --env ${D1_ENVS.join('|')} (or --local for the seeded local D1). Got: ${env ?? '(unset)'}.`,
    );
  }
  const e = env as D1Env;
  return { label: e, db: `aeci-app-${e}`, flags: ['--env', e, '--remote'], remote: true };
}

// ─── Wrangler I/O (mirrors backfill-entitlements.ts) ─────────────────────────

interface D1ExecResult<T> {
  results: T[];
  success: boolean;
  meta?: { changes?: number };
}

function parseWranglerJson<T>(stdout: string): D1ExecResult<T>[] {
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error(`Unexpected wrangler output (no JSON):\n${stdout}`);
  return JSON.parse(stdout.slice(start)) as D1ExecResult<T>[];
}

const WRANGLER_HINT =
  'Run this through pnpm from apps/api so the workspace wrangler is on PATH: pnpm --filter @aeci/api ops:backfill-licenses -- <flags>';

function runD1<T>(target: Target, sql: string): D1ExecResult<T>[] {
  const res = spawnSync(
    'wrangler',
    ['d1', 'execute', target.db, ...target.flags, '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error) {
    if ((res.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`\`wrangler\` not found. ${WRANGLER_HINT}`);
    }
    throw res.error;
  }
  if (res.status !== 0) {
    const hint = target.remote
      ? `Check CLOUDFLARE_API_TOKEN (Account→D1→Edit) + CLOUDFLARE_ACCOUNT_ID, and that "${target.db}" exists for --env ${target.label}.`
      : 'Set up the local D1 first:  pnpm --filter @aeci/api db:setup:local';
    throw new Error(
      `wrangler d1 execute failed on "${target.db}" (exit ${res.status}).\n${hint}\n\n${res.stderr}`,
    );
  }
  return parseWranglerJson<T>(res.stdout);
}

const rowsOf = <T>(results: D1ExecResult<T>[]): T[] => results[0]?.results ?? [];

// ─── Main ────────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const target = resolveTarget(argv);
  const operator = readValueFlag(argv, '--operator') ?? null;

  if (target.remote && !process.env.CLOUDFLARE_API_TOKEN) {
    console.warn('⚠  CLOUDFLARE_API_TOKEN is unset — wrangler --remote will fail to authenticate.');
  }
  if (apply && target.label === 'production' && !argv.includes('--allow-production')) {
    console.error(
      'Refusing to --apply against PRODUCTION without --allow-production. Re-run with both if intended.',
    );
    return 1;
  }

  console.log('── backfill-licenses ───────────────────────────────────────');
  console.log(`Target: ${target.db} (${target.label})`);
  console.log(`Mode:   ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log('');

  const tables = rowsOf(runD1<{ name: string }>(target, LICENSE_TABLES_SQL)).map((r) => r.name);
  if (tables.length !== 2) {
    console.error(
      `✗ ${target.db} lacks billing_accounts and/or licenses (found: ${tables.join(', ') || 'none'}).\n` +
        '  Apply migration 0073 to this tier first.',
    );
    return 1;
  }

  const now = new Date().toISOString();
  const vendors = rowsOf(runD1<BackfillVendorRow>(target, buildVendorsSql()));
  const owned = rowsOf(runD1<OwnedProductRow>(target, buildOwnedProductsSql()));
  const plan = await planLicenseBackfill(vendors, owned, { now });
  const counts = countBackfill(plan);

  const stampLag = rowsOf(runD1<StampLagRow>(target, buildStampLagSql()));
  const reconcile = await planStampReconcile(stampLag, { now });

  console.log(formatLicenseBackfillReport(plan));
  console.log('');
  console.log(formatStampLagReport(reconcile));
  console.log('');

  if (counts.vendorsToWrite === 0 && stampLag.length === 0) {
    console.log(`✓ Nothing to back-fill on ${target.db}.`);
    return counts.refused > 0 ? 1 : 0;
  }
  if (!apply) {
    console.log(
      `Dry run: would write ${counts.vendorsToWrite} vendor(s) and copy ${stampLag.length} stamp(s) for ${reconcile.length} vendor(s). Re-run with --apply.`,
    );
    return counts.refused > 0 ? 1 : 0;
  }

  for (const p of plan.vendors) {
    const stmts = buildVendorStatements(p, { now, operator });
    if (stmts.length > 0) runD1(target, stmts.join('\n'));
  }

  // The stamp reconcile, one execute per vendor (its audit row, then the UPDATE). The
  // inserts above carry their stamps, so the read before them is the full set.
  for (const r of reconcile) {
    runD1(target, buildStampReconcileStatements(r, { now, operator }).join('\n'));
  }
  const stampLeft = rowsOf(runD1<StampLagRow>(target, buildStampLagSql()));
  if (stampLeft.length > 0) {
    console.error(`✗ ${stampLeft.length} live license(s) still lag the entitlement's stamp.`);
    return 1;
  }
  console.log(`✓ Copied ${stampLag.length} expiry-notice stamp(s); none left lagging.`);

  // Proof 1: a re-plan finds nothing left to write. (`meta.changes` is not a usable
  // count here: local D1 reports none for an INSERT … SELECT.)
  const replan = countBackfill(
    await planLicenseBackfill(
      rowsOf(runD1<BackfillVendorRow>(target, buildVendorsSql())),
      rowsOf(runD1<OwnedProductRow>(target, buildOwnedProductsSql())),
      { now },
    ),
  );
  if (replan.vendorsToWrite > 0) {
    console.error(`✗ ${replan.vendorsToWrite} vendor(s) still to write after the run.`);
    return 1;
  }
  console.log(
    `✓ Wrote ${counts.vendorsToWrite} vendor(s) to ${target.db}; a re-plan finds none left.`,
  );

  // Proof 2: every vendor's `verified` agrees with EXISTS(live license), except
  // the ones refused above, whose drift this script does not repair.
  const refusedIds = new Set(
    plan.vendors.filter((v) => v.outcome === 'refused').map((v) => v.vendorId),
  );
  const drift = rowsOf(runD1<LicenseDriftRow>(target, buildLicenseDriftSql()));
  const unexpected = drift.filter((d) => !refusedIds.has(d.id));
  if (unexpected.length > 0) {
    console.error(
      `✗ ${unexpected.length} vendor(s) disagree with their live licenses after the write:`,
    );
    for (const d of unexpected) {
      console.error(`  ! ${d.company_name} (${d.slug}): verified = ${d.verified}`);
    }
    return 1;
  }
  console.log(
    drift.length === 0
      ? '✓ license_mirror_drift: 0.'
      : `✓ license_mirror_drift: ${drift.length}, all of them refused above.`,
  );
  return counts.refused > 0 ? 1 : 0;
}

// Entrypoint guard — importing this module (e.g. in tests) must not run main().
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

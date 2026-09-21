/**
 * retract-vendor.ts — Tier-0 ops CLI to remove a promoted vendor from a deployed D1
 * (ADR 0016), when and ONLY when that vendor owns nothing. There is no vendor arm on the
 * retraction journal (`docs/REVIEW_APP_PROMOTE_API.md` §5.1 carries products and
 * integrations only) and the review app refuses to delete a vendor that is live in
 * production, so the AECI-1016 leftovers — eight vendor rows that own nothing and keep the
 * daily strand audit's `vendorNoLiveProducts` bucket red — can only come down by hand.
 * This is the Node shell around the tested core (`src/lib/retract-vendor.ts`): it supplies
 * argv, the `wrangler d1 execute` I/O, credentials, and `console`. Same shape as
 * `retract-product.ts`.
 *
 * THE RULE (owner ruling, 2026-09-18, AECI-1024). Retractable ⟺ zero products AND zero
 * owned edges, where "owned edges" is BOTH `integrations.built_by_vendor_id` AND
 * `connector_evidenced_pairs.built_by_vendor_id` (the AECI-721 two-table rule). Profiles,
 * entitlements and seat invites refuse too. There is **no `--force`** — a vendor that owns
 * something is not a retraction, it is a merge or a product-level fix. **One refusing
 * vendor refuses the whole run.**
 *
 * WHAT IT DOES (on `--apply`, per vendor, in one `wrangler d1 execute` batch):
 *   1. D1: NULL `page_views.vendor_id`, `claims.created_by_vendor_id` and
 *      `attestations.attested_by_vendor_id`, then DELETE the vendor, then INSERT the
 *      `audit_log` row — in that order, in that batch.
 *   2. Algolia: delete the `<env>_vendors` object (objectID = vendor id) so search does
 *      not keep an orphan (reuses the AECI-267 orphan-purge core).
 *   3. Cache: print the `vendor:<slug>` Cache-Tag purge command.
 *
 * SAFETY:
 *   - Dry-run by default; `--apply` performs the writes.
 *   - `--apply` additionally requires `--confirm-count N` equal to the resolved plan size.
 *   - Refuses `production` writes without `--allow-production`.
 *   - Writes ONE `audit_log` row per deleted vendor, in the same batch (§26.1), as
 *     `retract-product.ts` does for products since AECI-687.
 *
 * WHAT IT DOES NOT DO:
 *   - It does not touch the review app. After this run, clear the upstream record's
 *     `supabase_vendor_id` and delete it — that is a separate manual step (§5.1).
 *   - It does not delete a single `page_views` row. They are log-class and are detached.
 *   - It does not repair `claims.origin`, which stays `'vendor'` with a NULL
 *     `created_by_vendor_id` for any vendor-authored claim. That invariant lives in
 *     application code, not in a CHECK; the lane reports the count instead of rewriting it.
 *   - It does not purge the edge cache itself. `production` currently serves uncached
 *     (`apps/web/wrangler.jsonc` has no `exports` block for it), so there is usually
 *     nothing to purge there at all.
 *
 * USAGE (from the repo root; remote needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
 *   # dry-run, one vendor by slug:
 *   pnpm --filter @aeci/api ops:retract-vendor -- --slug skyway-consulting --env production
 *   # dry-run, a cohort by id:
 *   pnpm --filter @aeci/api ops:retract-vendor -- --ids <uuid>,<uuid>,<uuid> --env production
 *   # apply (production requires both extra guards):
 *   pnpm --filter @aeci/api ops:retract-vendor -- --ids <uuid>,<uuid> --env production \
 *     --apply --allow-production --confirm-count 2
 *   # against the local seeded D1:
 *   pnpm --filter @aeci/api ops:retract-vendor -- --id <uuid> --local --apply --confirm-count 1
 *
 * Side-effect credentials (best-effort; missing → warn + print the manual command):
 *   - Algolia:  ALGOLIA_APP_ID + ALGOLIA_ADMIN_KEY (or ALGOLIA_ADMIN_KEY_<ENV>)
 * Skip either side effect with --skip-algolia / --skip-cache.
 */

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { localizedIndexNamesFor, type AlgoliaEnv } from '@aeci/shared/algolia';

import {
  createOrphanPurgeClient,
  resolveAlgoliaCreds,
  type OrphanPurgeClient,
} from '../src/lib/algolia-orphan-purge';
import {
  buildCacheTagsForVendor,
  buildVendorDeleteStatements,
  buildVendorFootprintSql,
  buildVendorLookupSql,
  buildVendorLookupSqlForIds,
  checkConfirmCount,
  classifyVendorRetraction,
  formatVendorFootprintReport,
  parseVendorFootprint,
  VENDOR_ORIGIN_RESIDUE_NOTE,
  type RawVendorFootprintRow,
  type RetractVendorTarget,
  type VendorPlanEntry,
  type VendorRow,
} from '../src/lib/retract-vendor';

// ─── Args + target resolution ────────────────────────────────────────────────

const D1_ENVS = ['preview', 'staging', 'demo', 'production'] as const;
type D1Env = (typeof D1_ENVS)[number];

/** Which Algolia index env a D1 env de-indexes against — 1:1, as in `retract-product.ts`.
 *  Only `--local` has no `target.env` and so skips Algolia. */
function algoliaEnvFor(env: D1Env): AlgoliaEnv {
  switch (env) {
    case 'preview':
      return 'preview';
    case 'staging':
      return 'staging';
    case 'production':
      return 'production';
    case 'demo':
      return 'demo';
  }
}

interface Target {
  label: string;
  db: string;
  flags: string[];
  remote: boolean;
  /** undefined for --local (preview D1 with no matching remote Algolia env). */
  env: D1Env | undefined;
}

function readValueFlag(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

/** Every `--id` occurrence, so the flag can be repeated as well as comma-joined. */
function readRepeatedFlag(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (const [i, a] of argv.entries()) {
    if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
    else if (a === name && i + 1 < argv.length) out.push(argv[i + 1]!);
  }
  return out;
}

function resolveTarget(argv: string[]): Target {
  if (argv.includes('--local')) {
    return {
      label: 'local',
      db: 'aeci-app-preview',
      flags: ['--local'],
      remote: false,
      env: undefined,
    };
  }
  const env = readValueFlag(argv, '--env');
  if (!env || !(D1_ENVS as readonly string[]).includes(env)) {
    throw new Error(
      `Set --env ${D1_ENVS.join('|')} (or --local for the seeded local D1). Got: ${env ?? '(unset)'}.`,
    );
  }
  const e = env as D1Env;
  return { label: e, db: `aeci-app-${e}`, flags: ['--env', e, '--remote'], remote: true, env: e };
}

/** `--slug` (exactly one vendor) XOR `--ids` / repeated `--id` (a cohort). */
function resolveVendorTargets(argv: string[]): RetractVendorTarget[] {
  const slug = readValueFlag(argv, '--slug');
  const idsRaw = readValueFlag(argv, '--ids');
  const ids = [...readRepeatedFlag(argv, '--id'), ...(idsRaw ? idsRaw.split(',') : [])]
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (slug && ids.length > 0) throw new Error('Pass --slug or --id/--ids, not both.');
  if (slug) return [{ slug }];
  if (ids.length === 0) {
    throw new Error(
      'Identify the vendor(s) with --slug <slug>, --id <uuid>, or --ids <uuid,uuid>.',
    );
  }
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) {
    console.warn(`⚠  ${ids.length - unique.length} duplicate id(s) collapsed.`);
  }
  return unique.map((id) => ({ id }));
}

// ─── Wrangler I/O (mirrors retract-product.ts) ───────────────────────────────

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

function wranglerMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

const WRANGLER_HINT =
  'Run via pnpm so wrangler is on PATH:\n  pnpm --filter @aeci/api ops:retract-vendor -- …';

function runD1<T>(target: Target, sql: string): D1ExecResult<T>[] {
  const res = spawnSync(
    'wrangler',
    ['d1', 'execute', target.db, ...target.flags, '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error) {
    if (wranglerMissing(res.error)) throw new Error(`\`wrangler\` not found. ${WRANGLER_HINT}`);
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

// ─── Algolia ─────────────────────────────────────────────────────────────────

interface AlgoliaCtx {
  client: OrphanPurgeClient;
  indexName: string;
}

/** Resolve the vendors index + an authenticated client once for the whole run, or explain
 *  why not. Returns `undefined` when Algolia cannot be reached; the caller degrades to
 *  "not checked" in the report and prints the manual purge command. */
function resolveAlgolia(target: Target): AlgoliaCtx | undefined {
  const algoliaEnv = target.env ? algoliaEnvFor(target.env) : undefined;
  if (!algoliaEnv) {
    console.warn(
      `⚠  Algolia: no index env for "${target.label}" — skipping de-index. If this env has an ` +
        `index, remove the objects manually:  ops:purge-algolia-orphans -- --env <env> --ids vendors:<id> --apply`,
    );
    return undefined;
  }
  const creds = resolveAlgoliaCreds(algoliaEnv, process.env);
  if (!creds.appId || !creds.apiKey) {
    console.warn(
      '⚠  Algolia: ALGOLIA_APP_ID / ALGOLIA_ADMIN_KEY unset — search will keep orphans. ' +
        `Remove them with:  ops:purge-algolia-orphans -- --env ${algoliaEnv} --ids vendors:<id> --apply`,
    );
    return undefined;
  }
  return {
    client: createOrphanPurgeClient(creds, fetch),
    indexName: localizedIndexNamesFor(algoliaEnv).vendors,
  };
}

async function deindexAlgolia(ctx: AlgoliaCtx, vendor: VendorRow): Promise<void> {
  const outcome = await ctx.client.deleteObjects(ctx.indexName, [vendor.id]);
  if (!outcome.ok) {
    console.error(`✗ Algolia: delete failed — ${outcome.message} (HTTP ${outcome.status}).`);
    return;
  }
  // Deletes publish asynchronously — wait, then verify on the write host.
  if (outcome.taskID !== undefined) await ctx.client.waitTask(ctx.indexName, outcome.taskID);
  const after = await ctx.client.getObject(ctx.indexName, vendor.id, { consistent: true });
  if (after.found) console.error(`✗ Algolia: object ${vendor.id} still present after delete.`);
  else console.log(`✓ Algolia: removed ${vendor.id} from ${ctx.indexName}.`);
}

/**
 * Cache-tag purge is native (WC-6): the SSR Worker's `POST /admin/purge` invalidates
 * in-process via `ctx.cache.purge()`. This CLI runs outside any Worker, so it prints the
 * exact purge command for the operator to run — authenticated with `ADMIN_PURGE_TOKEN`.
 * Note that `demo` and `production` currently ship with no `exports` block in
 * `apps/web/wrangler.jsonc`, so they serve UNCACHED and there is nothing to purge there.
 */
function reportCachePurge(tags: string[]): void {
  console.warn(
    '⚠  Cache: purge the edge cache by POSTing to the SSR Worker (auth: ADMIN_PURGE_TOKEN):\n' +
      `     POST /admin/purge  {"tags": ${JSON.stringify(tags)}}\n` +
      '     (demo/production serve uncached today — nothing to purge there.)',
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const target = resolveTarget(argv);
  const vendorTargets = resolveVendorTargets(argv);

  if (argv.includes('--force')) {
    console.error(
      'There is no --force on this lane. A vendor that owns products or edges is a merge or a\n' +
        'product-level retraction, not a vendor delete (owner ruling 2026-09-18, AECI-1024).',
    );
    return 1;
  }
  if (target.remote && !process.env.CLOUDFLARE_API_TOKEN) {
    console.warn('⚠  CLOUDFLARE_API_TOKEN is unset — wrangler --remote will fail to authenticate.');
  }
  if (apply && target.label === 'production' && !argv.includes('--allow-production')) {
    console.error(
      'Refusing to --apply against PRODUCTION without --allow-production. Re-run with both if intended.',
    );
    return 1;
  }

  console.log(`── retract-vendor ──────────────────────────────────────────`);
  console.log(`Mode:  ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(
    `DB:    ${target.db}${target.remote ? ` (--env ${target.label}, remote)` : ' (local)'}`,
  );
  console.log('');

  // 1. Resolve every vendor. Ids go in one statement; a slug is its own lookup.
  const byId = vendorTargets.filter((t): t is { id: string } => 'id' in t).map((t) => t.id);
  const vendors: VendorRow[] = [];
  if (byId.length > 0) {
    vendors.push(...(runD1<VendorRow>(target, buildVendorLookupSqlForIds(byId))[0]?.results ?? []));
    const found = new Set(vendors.map((v) => v.id));
    const missing = byId.filter((id) => !found.has(id));
    if (missing.length > 0) {
      console.error(`Not found in ${target.db}:`);
      for (const id of missing) console.error(`  • ${id}`);
      console.error(
        '\nRefusing the whole run. A missing id means the cohort is not what you think it is.',
      );
      return 1;
    }
  }
  for (const t of vendorTargets) {
    if (!('slug' in t)) continue;
    const row = runD1<VendorRow>(target, buildVendorLookupSql(t))[0]?.results[0];
    if (!row) {
      console.error(`No vendor found for slug "${t.slug}" in ${target.db}.`);
      return 1;
    }
    vendors.push(row);
  }

  // 2. Algolia presence, read once per vendor for the report.
  const skipAlgolia = argv.includes('--skip-algolia');
  const algolia = skipAlgolia ? undefined : resolveAlgolia(target);
  if (skipAlgolia) console.log('Algolia: skipped (--skip-algolia).\n');

  // 3. Footprint + classification, per vendor.
  const plan: VendorPlanEntry[] = [];
  for (const vendor of vendors) {
    const raw = runD1<RawVendorFootprintRow>(target, buildVendorFootprintSql(vendor.id))[0]
      ?.results[0];
    if (!raw) {
      console.error(`Could not read footprint for ${vendor.id} (empty result).`);
      return 1;
    }
    const footprint = parseVendorFootprint(raw);
    const inAlgolia = algolia
      ? (await algolia.client.getObject(algolia.indexName, vendor.id, { consistent: true })).found
      : undefined;
    plan.push({
      vendor,
      footprint,
      classification: classifyVendorRetraction(footprint),
      inAlgolia,
    });
  }

  for (const entry of plan) {
    console.log(formatVendorFootprintReport(entry));
    console.log('');
  }

  // 4. Safety gate — one refusal refuses the run.
  const refused = plan.filter((e) => !e.classification.safe);
  if (refused.length > 0) {
    console.error(
      `Refusing: ${refused.length} of ${plan.length} vendor(s) own something. There is no --force.`,
    );
    for (const e of refused) {
      console.error(`  ✗ ${e.vendor.company_name} (${e.vendor.slug}):`);
      for (const b of e.classification.blockers) console.error(`      • ${b}`);
    }
    console.error(
      '\nOne refusing vendor refuses the whole run — a partial cohort is not the cohort you read.',
    );
    return 1;
  }

  const detached = plan.reduce(
    (acc, e) => ({
      claims: acc.claims + e.footprint.claims,
      attestations: acc.attestations + e.footprint.attestations,
      pageViews: acc.pageViews + e.footprint.pageViews,
    }),
    { claims: 0, attestations: 0, pageViews: 0 },
  );
  if (detached.claims > 0) console.warn(`⚠  ${VENDOR_ORIGIN_RESIDUE_NOTE}\n`);

  const tags = plan.flatMap((e) => buildCacheTagsForVendor(e.vendor.slug));

  // 5. Dry-run stops here.
  if (!apply) {
    console.log(`DRY RUN — nothing deleted. ${plan.length} vendor(s) are retractable.`);
    console.log(
      `On --apply: delete them from ${target.db}, detaching ${detached.claims} claim(s), ` +
        `${detached.attestations} attestation(s) and ${detached.pageViews} page_view(s);`,
    );
    console.log(`de-index the Algolia vendors objects; purge Cache-Tags: ${tags.join(', ')}.`);
    console.log(
      `Re-run with --apply --confirm-count ${plan.length}` +
        (target.label === 'production' ? ' --allow-production' : '') +
        ' to perform the deletion.',
    );
    return 0;
  }

  // 6. `--confirm-count` must match the plan resolved from THIS read.
  const confirm = checkConfirmCount(readValueFlag(argv, '--confirm-count'), plan.length);
  if (!confirm.ok) {
    console.error(`\n${confirm.message}`);
    return 1;
  }

  // 7. Apply: one execute per vendor (detach → delete → audit, in that batch).
  const now = new Date().toISOString();
  console.log(`Deleting ${plan.length} vendor(s) from D1…`);
  for (const entry of plan) {
    const statements = buildVendorDeleteStatements({
      vendor: entry.vendor,
      footprint: entry.footprint,
      auditId: randomUUID(),
      now,
    }).join('\n');
    const results = runD1<unknown>(target, statements);
    const changed = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
    console.log(
      `✓ D1: ${entry.vendor.slug} — ${changed} row(s) changed across ${results.length} statement(s), ` +
        `audit_log action=vendor.deleted entity_id=${entry.vendor.id}.`,
    );
  }
  console.log('');

  if (algolia) {
    for (const entry of plan) await deindexAlgolia(algolia, entry.vendor);
  } else {
    console.log('Algolia: not reachable — see the warning above.');
  }
  console.log('');

  if (!argv.includes('--skip-cache')) reportCachePurge(tags);
  else console.log('Cache: skipped (--skip-cache).');

  console.log('');
  console.log(`✓ Retracted ${plan.length} vendor(s) from ${target.db}.`);
  console.log(
    "   Next, upstream: clear each review-app record's `supabase_vendor_id`, then delete the record.",
  );
  return 0;
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

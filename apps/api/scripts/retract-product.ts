/**
 * retract-product.ts — Tier-0 ops CLI to remove a promoted product from a deployed
 * D1 (ADR 0016). The app has no product-delete path (`promote` only upserts), so a
 * mis-promoted / duplicate product — e.g. a stub that disambiguated to `box-2`
 * because `box` already existed — is removed by hand. This is the Node shell around
 * the tested core (`src/lib/retract-product.ts`): it supplies argv, the
 * `wrangler d1 execute` I/O, credentials, and `console`. Same shape as
 * `reconcile-product-counts.ts` / `purge-algolia-orphans.ts`.
 *
 * WHAT IT DOES (on `--apply`):
 *   1. D1: ordered child→parent delete of the product + everything hanging off it.
 *   2. Algolia: delete the `products` object (objectID = product id) so search
 *      doesn't keep an orphan (reuses the AECI-267 orphan-purge core).
 *   3. Cache: purge the product/index/browse Cache-Tags so no edge-cached page
 *      keeps rendering it.
 *
 * SAFETY:
 *   - Dry-run by default; `--apply` performs the writes.
 *   - Refuses a product that has integrations or reviews unless `--force` (those
 *     should be merged onto the canonical product, not cascaded away).
 *   - Refuses `production` writes without `--allow-production`.
 *   - Emits NO `audit_log` row (there is no handler; see the core-lib header). The
 *     audited path is the future Tier-1 `retract` endpoint.
 *
 * USAGE (from apps/api; remote needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
 *   # dry-run — read + report footprint, delete nothing:
 *   pnpm --filter @aeci/api ops:retract-product -- --slug box-2 --env production
 *   # apply (production requires the extra guard flag):
 *   pnpm --filter @aeci/api ops:retract-product -- --slug box-2 --env production --apply --allow-production
 *   # by id, against the local seeded D1:
 *   pnpm --filter @aeci/api ops:retract-product -- --id <uuid> --local --apply
 *
 * Side-effect credentials (best-effort; missing → warn + print the manual command):
 *   - Algolia:  ALGOLIA_APP_ID + ALGOLIA_ADMIN_KEY (or ALGOLIA_ADMIN_KEY_<ENV>)
 *   - Cache:    CF_PURGE_API_TOKEN + CF_ZONE_ID   (Zone.Cache Purge on the zone)
 * Skip either with --skip-algolia / --skip-cache.
 */

import { spawnSync } from 'node:child_process';

import { callCloudflarePurge } from '@aeci/shared/cache-purge';
import { localizedIndexNamesFor, type AlgoliaEnv } from '@aeci/shared/algolia';

import { createOrphanPurgeClient, resolveAlgoliaCreds } from '../src/lib/algolia-orphan-purge';
import {
  buildCacheTagsForProduct,
  buildDeleteStatements,
  buildFootprintSql,
  buildProductLookupSql,
  classifyRetraction,
  formatFootprintReport,
  parseFootprint,
  type ProductRow,
  type RawFootprintRow,
  type RetractTarget,
} from '../src/lib/retract-product';

// ─── Args + target resolution ────────────────────────────────────────────────

const D1_ENVS = ['preview', 'staging', 'demo', 'production'] as const;
type D1Env = (typeof D1_ENVS)[number];

/** Which Algolia index env a D1 env de-indexes against. Every deployed D1 env has
 *  its own `<env>_*` index set in `@aeci/shared/algolia` (including `demo`, which
 *  runs the same sync/drift crons as staging/production), so the mapping is 1:1.
 *  Only `--local` skips Algolia — it has no `target.env` (see `deindexAlgolia`). */
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

function resolveProductTarget(argv: string[]): RetractTarget {
  const slug = readValueFlag(argv, '--slug');
  const id = readValueFlag(argv, '--id');
  if (slug && id) throw new Error('Pass exactly one of --slug or --id, not both.');
  if (slug) return { slug };
  if (id) return { id };
  throw new Error('Identify the product with --slug <slug> or --id <uuid>.');
}

// ─── Wrangler I/O (mirrors reconcile-product-counts.ts) ──────────────────────

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
  'Run via pnpm so wrangler is on PATH:\n  pnpm --filter @aeci/api ops:retract-product -- …';

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

// ─── Side effects ────────────────────────────────────────────────────────────

async function deindexAlgolia(target: Target, product: ProductRow): Promise<void> {
  const algoliaEnv = target.env ? algoliaEnvFor(target.env) : undefined;
  if (!algoliaEnv) {
    console.warn(
      `⚠  Algolia: no index env for "${target.label}" — skipping de-index. If this env has an ` +
        `index, remove the object manually:  ops:purge-algolia-orphans -- --env <env> --ids products:${product.id} --apply`,
    );
    return;
  }
  const creds = resolveAlgoliaCreds(algoliaEnv, process.env);
  if (!creds.appId || !creds.apiKey) {
    console.warn(
      '⚠  Algolia: ALGOLIA_APP_ID / ALGOLIA_ADMIN_KEY unset — search will keep an orphan. ' +
        `Remove it with:  ops:purge-algolia-orphans -- --env ${algoliaEnv} --ids products:${product.id} --apply`,
    );
    return;
  }
  const client = createOrphanPurgeClient(creds, fetch);
  const indexName = localizedIndexNamesFor(algoliaEnv).products;
  const outcome = await client.deleteObjects(indexName, [product.id]);
  if (!outcome.ok) {
    console.error(`✗ Algolia: delete failed — ${outcome.message} (HTTP ${outcome.status}).`);
    return;
  }
  // Deletes publish asynchronously — wait, then verify on the write host.
  if (outcome.taskID !== undefined) await client.waitTask(indexName, outcome.taskID);
  const after = await client.getObject(indexName, product.id, { consistent: true });
  if (after.found) console.error(`✗ Algolia: object ${product.id} still present after delete.`);
  else console.log(`✓ Algolia: removed ${product.id} from ${indexName}.`);
}

async function purgeCache(tags: string[]): Promise<void> {
  const creds = { apiToken: process.env.CF_PURGE_API_TOKEN, zoneId: process.env.CF_ZONE_ID };
  if (!creds.apiToken || !creds.zoneId) {
    console.warn(
      '⚠  Cache: CF_PURGE_API_TOKEN / CF_ZONE_ID unset — edge cache not purged. Purge manually:\n' +
        `     POST /admin/purge  {"tags": ${JSON.stringify(tags)}}`,
    );
    return;
  }
  const outcome = await callCloudflarePurge(fetch, creds, tags);
  if (outcome.ok) console.log(`✓ Cache: purged ${tags.length} tag(s) (HTTP ${outcome.status}).`);
  else console.error(`✗ Cache: purge failed — ${outcome.message} (HTTP ${outcome.status}).`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const force = argv.includes('--force');
  const target = resolveTarget(argv);
  const productTarget = resolveProductTarget(argv);

  if (target.remote && !process.env.CLOUDFLARE_API_TOKEN) {
    console.warn('⚠  CLOUDFLARE_API_TOKEN is unset — wrangler --remote will fail to authenticate.');
  }
  if (apply && target.label === 'production' && !argv.includes('--allow-production')) {
    console.error(
      'Refusing to --apply against PRODUCTION without --allow-production. Re-run with both if intended.',
    );
    return 1;
  }

  console.log(`── retract-product ─────────────────────────────────────────`);
  console.log(`Mode:  ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(
    `DB:    ${target.db}${target.remote ? ` (--env ${target.label}, remote)` : ' (local)'}`,
  );
  console.log('');

  // 1. Resolve the product.
  const product = runD1<ProductRow>(target, buildProductLookupSql(productTarget))[0]?.results[0];
  if (!product) {
    console.error(`No product found for ${JSON.stringify(productTarget)} in ${target.db}.`);
    return 1;
  }

  // 2. Footprint + report.
  const rawFootprint = runD1<RawFootprintRow>(target, buildFootprintSql(product.id))[0]?.results[0];
  if (!rawFootprint) {
    console.error('Could not read footprint (empty result).');
    return 1;
  }
  const footprint = parseFootprint(rawFootprint);
  console.log(formatFootprintReport(product, footprint));
  console.log('');

  // 3. Safety gate.
  const classification = classifyRetraction(footprint);
  if (!classification.safe) {
    console.warn(`⚠  Not a clean stub — this product carries content a delete would DESTROY:`);
    for (const b of classification.blockers) console.warn(`     • ${b}`);
    if (!force) {
      console.error(
        '\nRefusing without --force. Those integrations/reviews should be MERGED onto the canonical\n' +
          'product first (the merge-then-retract tool), not cascaded away. Re-run with --force only if\n' +
          'you intend to delete them along with the product.',
      );
      return 1;
    }
    console.warn('   --force set: proceeding; the above WILL be deleted.\n');
  }

  const tags = buildCacheTagsForProduct(product.slug, footprint);

  // 4. Dry-run stops here.
  if (!apply) {
    console.log('DRY RUN — nothing deleted.');
    console.log(
      `On --apply: delete the above from ${target.db}, de-index Algolia object ${product.id},`,
    );
    console.log(`and purge Cache-Tags: ${tags.join(', ')}.`);
    console.log('Re-run with --apply to perform the deletion.');
    return 0;
  }

  // 5. Apply: D1 delete (one execute, ordered statements) → Algolia → cache.
  console.log('Deleting from D1…');
  const statements = buildDeleteStatements(product.id).join('\n');
  const results = runD1<unknown>(target, statements);
  const changed = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
  console.log(`✓ D1: ${changed} row(s) removed across ${results.length} statement(s).`);
  console.log(
    '   (No audit_log row is written — Tier-0 raw delete; see the Tier-1 retract endpoint.)',
  );
  console.log('');

  if (!argv.includes('--skip-algolia')) await deindexAlgolia(target, product);
  else console.log('Algolia: skipped (--skip-algolia).');
  console.log('');

  if (!argv.includes('--skip-cache')) await purgeCache(tags);
  else console.log('Cache: skipped (--skip-cache).');

  console.log('');
  console.log(`✓ Retracted "${product.name}" (${product.slug}) from ${target.db}.`);
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

#!/usr/bin/env node
//
// audit.mjs — count unclaimed products and vendors whose Algolia record still
// carries a `logo_url` (AECI-1867). READ ONLY: one D1 SELECT per entity and
// Algolia getObjects calls with the public search-only key.
//
// Why: both record builders null `logo_url` for an unclaimed listing since
// AECI-1618 (`toAlgoliaProduct` / `toAlgoliaVendor` in
// `apps/api/src/lib/algolia-transforms.ts`, and the datatool reindex). Records
// indexed before that change were never rebuilt, because the nightly sync only
// re-pushes rows whose `updated_at` moved. `/search` trusts the record, so a
// stale record shows an unclaimed logo off its own page (DESIGN.md §5, counsel's
// ruling 9).
//
// The candidate set is EVERY unclaimed id, not only those with a stored logo: a
// record can hold a logo D1 no longer has. An id with no record (unpromoted,
// hidden) comes back null from getObjects and is not a finding.
//
// The claimed test mirrors `isVendorClaimed` and `claimedProductExtra`
// (`apps/api/src/lib/claimed-vendors.ts`): a vendor is claimed when `owned_at` is
// set and `claim_ended_at` is null; a product when any linked vendor is.
//
// Usage:
//   ALGOLIA_APP_ID=… ALGOLIA_SEARCH_KEY=… \
//     node scripts/ops/2026-11-algolia-unclaimed-logo-audit/audit.mjs --env production
//
// The search key is the per-env query-only key the SSR Worker renders into
// `window.__AECI_ALGOLIA__`. Needs `CLOUDFLARE_API_TOKEN` (or `wrangler login`)
// with D1 read on the target account. Exit 0 = clean, 2 = findings, 1 = error.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { D1_ENVS } from '../2026-09-algolia-integration-watermark-reset/args.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const API_DIR = join(REPO_ROOT, 'apps', 'api');

/** Must match `indexPrefixForEnv` in `packages/shared/src/algolia.ts`. */
const INDEX_PREFIX = { staging: 'staging', demo: 'demo', production: 'production' };

/** Algolia's getObjects limit per request. */
const GET_OBJECTS_MAX = 1000;

const CLAIMED_VENDOR = 'v.owned_at IS NOT NULL AND v.claim_ended_at IS NULL';

const ENTITIES = {
  products: {
    sql:
      'SELECT p.id AS id FROM products p WHERE NOT EXISTS (' +
      'SELECT 1 FROM product_vendors pv JOIN vendors v ON v.id = pv.vendor_id ' +
      `WHERE pv.product_id = p.id AND ${CLAIMED_VENDOR});`,
    label: (r) => r.name ?? r.objectID,
  },
  vendors: {
    sql: `SELECT v.id AS id FROM vendors v WHERE NOT (${CLAIMED_VENDOR});`,
    label: (r) => r.company_name ?? r.objectID,
  },
};

function parseArgs(argv) {
  let envName;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--env') {
      envName = argv[++i];
    } else if (arg.startsWith('--env=')) {
      envName = arg.slice('--env='.length);
    } else {
      return { kind: 'error', message: `Unknown argument: ${arg}` };
    }
  }
  if (!envName || !(envName in INDEX_PREFIX)) {
    return {
      kind: 'error',
      message: `--env must be one of: ${Object.keys(INDEX_PREFIX).join(', ')}. Got: ${envName ?? '(unset)'}`,
    };
  }
  return { kind: 'run', envName, target: D1_ENVS[envName] };
}

function d1Read(target, sql) {
  const res = spawnSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      target.db,
      ...target.flags,
      '--remote',
      '--json',
      '--command',
      sql,
    ],
    { cwd: API_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(`wrangler d1 execute failed with ${res.status}:\n${res.stderr || res.stdout}`);
  }
  const start = res.stdout.indexOf('[');
  if (start === -1) throw new Error(`No JSON in wrangler output:\n${res.stdout}`);
  return JSON.parse(res.stdout.slice(start))[0]?.results ?? [];
}

async function getObjects(appId, apiKey, indexName, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += GET_OBJECTS_MAX) {
    const requests = ids.slice(i, i + GET_OBJECTS_MAX).map((objectID) => ({
      indexName,
      objectID,
      attributesToRetrieve: ['logo_url', 'name', 'company_name', 'slug'],
    }));
    const res = await fetch(`https://${appId}-dsn.algolia.net/1/indexes/*/objects`, {
      method: 'POST',
      headers: {
        'X-Algolia-Application-Id': appId,
        'X-Algolia-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requests }),
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`Algolia getObjects on ${indexName} returned ${res.status}: ${text}`);
    out.push(...(JSON.parse(text).results ?? []));
  }
  return out;
}

function usage() {
  console.log(`
audit.mjs — unclaimed search records that still carry a logo (AECI-1867). Read only.

  --env <staging|demo|production>   target D1 and index prefix (required)

Env: ALGOLIA_APP_ID, ALGOLIA_SEARCH_KEY (the per-env search-only key).
Exit 0 = clean, 2 = findings, 1 = error.
`);
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.kind === 'help') {
    usage();
    return 0;
  }
  if (args.kind === 'error') {
    console.error(args.message);
    usage();
    return 1;
  }
  const appId = process.env.ALGOLIA_APP_ID;
  const apiKey = process.env.ALGOLIA_SEARCH_KEY;
  if (!appId || !apiKey) {
    console.error('Set ALGOLIA_APP_ID and ALGOLIA_SEARCH_KEY.');
    return 1;
  }
  const { envName, target } = args;
  console.log(`Target: ${target.db} / ${INDEX_PREFIX[envName]}_* — read only\n`);

  let findings = 0;
  for (const [entity, spec] of Object.entries(ENTITIES)) {
    const indexName = `${INDEX_PREFIX[envName]}_${entity}`;
    const ids = d1Read(target, spec.sql).map((r) => r.id);
    const records = (await getObjects(appId, apiKey, indexName, ids)).filter(Boolean);
    const leaks = records.filter((r) => r.logo_url);
    findings += leaks.length;
    console.log(
      `${indexName}: ${ids.length} unclaimed in D1, ${records.length} in the index, ${leaks.length} with a logo_url`,
    );
    for (const r of leaks) console.log(`  ${r.objectID}  ${spec.label(r)}  ${r.logo_url}`);
    console.log('');
  }
  console.log(findings === 0 ? 'Clean.' : `${findings} record(s) to repair.`);
  return findings === 0 ? 0 : 2;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });

#!/usr/bin/env node
/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  Algolia provisioning — AECI-134 / Phase 3.1.  OPERATOR-RUN.
 *
 *  ⚠️  PRINTS SECRETS TO STDOUT. Run locally only. NEVER wire this into CI.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * For ONE environment, this script:
 *   1. Ensures the three entity indexes exist (`<prefix>_products`, …) by setting
 *      EMPTY settings on each. Index *settings* (searchable attrs, facets,
 *      ranking) are deliberately NOT touched — those land in 3.2.
 *   2. Mints two standalone, independently-rotatable API keys scoped to those
 *      three indexes (`addApiKey`, not derived/secured keys):
 *        - search-only key   (ACL ['search'])                  → web Worker secret
 *                                                                ALGOLIA_SEARCH_KEY
 *        - management key     (search + index-mutation ACLs)    → API/CI secret
 *                                                                ALGOLIA_ADMIN_KEY
 *   3. Prints the exact `gh secret set` + `wrangler secret put` commands to run.
 *
 * Idempotent: re-running without --rotate reuses keys already tagged for this
 * env (it never creates duplicates) and re-applies empty settings (a no-op).
 * Pass --rotate to mint fresh keys and delete the old ones for this env.
 *
 * ── Credentials ────────────────────────────────────────────────────────────
 * Reads from the environment:
 *   ALGOLIA_APP_ID    — the AECi application id (shared across all envs).
 *   ALGOLIA_ADMIN_KEY — the app-wide ROOT admin key. Operator-held; used ONLY to
 *                       run this script. It is NEVER pushed onto a Worker. (Note
 *                       the name overlap: the per-env MANAGEMENT key this script
 *                       MINTS is ALSO surfaced as `ALGOLIA_ADMIN_KEY` on the API
 *                       Worker — different value, different place. See §7.5.)
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   ALGOLIA_APP_ID=… ALGOLIA_ADMIN_KEY=<root admin key> \
 *     node scripts/algolia/provision.mjs --env <preview|staging|demo|production|stage2> [--rotate]
 *
 * Requires Node ≥22.18 (native TypeScript type-stripping for the shared import);
 * the repo's `engines` floor (22.22.3) satisfies this.
 *
 * Spec: docs/CICD_PLAN.md §7.5 (topology), §7.4 (rotation); docs/environments.md
 * §6/§8 (operator runbook). ADR 0006.
 */

import { algoliasearch } from 'algoliasearch';

// Relative import (not `@aeci/shared/algolia`): Node refuses to type-strip files
// resolved through node_modules, and the workspace package is symlinked there.
// The path below points straight at the source — the SAME file the Workers
// import — so type-stripping applies and the single-source-of-truth holds.
import {
  indexListFor,
  managementKeyParams,
  searchKeyParams,
} from '../../packages/shared/src/algolia.ts';

// `stage2` is the TEMPORARY Stage 2 test tier (AECI-637). Remove it — and delete
// the `stage2_*` indexes + the `aeci:{search,management}:stage2` keys this mints —
// at teardown. Its search key is per-env scoped and pushed straight to the stage2
// Workers, so the SHARED `ALGOLIA_SEARCH_KEY` GH secret is never touched or widened.
const VALID_ENVS = ['preview', 'staging', 'demo', 'production', 'stage2'];

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const rotate = args.includes('--rotate');
  const envIdx = args.indexOf('--env');
  const env = envIdx >= 0 ? args[envIdx + 1] : undefined;
  return { env, rotate };
}

/**
 * Ensure the env's three indexes exist by applying empty settings. Setting
 * settings on a non-existent index creates it; on an existing one it is a no-op
 * here (we send `{}`). Searchable/facet/ranking config is 3.2, not this script.
 */
async function ensureIndexes(client, env) {
  console.log('• Ensuring indexes (empty settings — no searchable/facet/ranking):');
  for (const indexName of indexListFor(env)) {
    await client.setSettings({ indexName, indexSettings: {} });
    console.log(`    ✓ ${indexName}`);
  }
}

/**
 * Create (or reuse / rotate) a single standalone key tagged by description.
 * Returns the key value so the caller can print it for `wrangler secret put`.
 */
async function ensureKey(client, params, { rotate }) {
  const { keys } = await client.listApiKeys();
  const existing = keys.filter((k) => k.description === params.description);

  if (existing.length > 0 && !rotate) {
    if (existing.length > 1) {
      console.warn(
        `    ! ${existing.length} keys tagged "${params.description}" — using the first; ` +
          `re-run with --rotate to consolidate.`,
      );
    }
    return { value: existing[0].value, created: false };
  }

  const { key } = await client.addApiKey({
    acl: params.acl,
    indexes: params.indexes,
    description: params.description,
  });

  if (rotate && existing.length > 0) {
    for (const old of existing) {
      await client.deleteApiKey({ key: old.value });
      console.log(`    ↻ rotated out old key …${old.value.slice(-6)} (${params.description})`);
    }
  }

  return { value: key, created: true };
}

function printNextSteps({ env, appId, searchKey, managementKey }) {
  const SUFFIX = env.toUpperCase();
  const rule = '─'.repeat(76);
  console.log(`\n${rule}`);
  console.log('NEXT STEPS — set these secrets (values above are LIVE; treat as secret)');
  console.log(rule);

  // AECI-637: `stage2` is a TEMPORARY hand-deployed tier with no CI workflow, so it
  // reads no GitHub secret at all. Printing the usual `gh secret set` lines here
  // would be actively harmful — `ALGOLIA_SEARCH_KEY` is a SINGLE shared secret that
  // staging/demo/production all read, and overwriting it with this stage2-scoped key
  // 403s browser search on every one of them. Print only the per-Worker puts.
  if (env === 'stage2') {
    console.log('\n# GitHub Actions secrets — NONE.');
    console.log(`#   stage2 is a temporary, hand-deployed tier (AECI-637): no workflow reads`);
    console.log(`#   a GH secret for it. Do NOT run 'gh secret set ALGOLIA_SEARCH_KEY' with the`);
    console.log(`#   key above — that secret is SHARED, and replacing it with this stage2-scoped`);
    console.log(`#   key would 403 browser search on staging, demo AND production.`);
    console.log('\n# Cloudflare Worker secrets (persist across deploys)');
    console.log('#   web Worker — app id + query-only SEARCH key ONLY (never the admin key):');
    console.log(`cd apps/web`);
    console.log(`echo '${appId}'     | wrangler secret put ALGOLIA_APP_ID --env stage2`);
    console.log(`echo '${searchKey}' | wrangler secret put ALGOLIA_SEARCH_KEY --env stage2`);
    console.log('#   API Worker — app id + the stage2 MANAGEMENT key (search + index-mutation):');
    console.log(`cd ../api`);
    console.log(`echo '${appId}'        | wrangler secret put ALGOLIA_APP_ID --env stage2`);
    console.log(`echo '${managementKey}' | wrangler secret put ALGOLIA_ADMIN_KEY --env stage2`);
    console.log(`\n${rule}\n`);
    return;
  }

  console.log('\n# GitHub Actions secrets');
  console.log(`#   ALGOLIA_APP_ID, ALGOLIA_SEARCH_KEY and ALGOLIA_ADMIN_KEY are now`);
  console.log(`#   SINGLE shared secrets across every env (no _STAGING/_PRODUCTION/_PREVIEW/`);
  console.log(`#   _DEMO suffix). CAUTION: every env's deploy reads the SAME secret, so a`);
  console.log(`#   per-env key minted here OVERWRITES the shared value — the search key you`);
  console.log(`#   set must be able to query ALL envs' indexes (staging_*/production_*/`);
  console.log(`#   preview_*/demo_*), or scope it to the env that actually serves users.`);
  console.log(`gh secret set ALGOLIA_APP_ID --body '${appId}'`);
  console.log(`gh secret set ALGOLIA_SEARCH_KEY --body '${searchKey}'`);
  if (env === 'preview') {
    console.log(
      '#   preview search key → lighthouse.yml (AECI-188): the post-merge Lighthouse\n' +
        '#   workflow hard-fails without it (it provisions /search with the real SDK).\n' +
        '#   No preview ADMIN GitHub secret: sync (3.5) uses the management key directly.',
    );
  } else {
    console.log(`gh secret set ALGOLIA_ADMIN_KEY --body '${managementKey}'`);
  }

  console.log('\n# Cloudflare Worker secrets (persist across deploys)');
  console.log('#   web Worker — app id + query-only SEARCH key ONLY (never the admin key):');
  console.log(`cd apps/web`);
  console.log(`echo '${appId}'     | wrangler secret put ALGOLIA_APP_ID --env ${env}`);
  console.log(`echo '${searchKey}' | wrangler secret put ALGOLIA_SEARCH_KEY --env ${env}`);
  console.log('#   API Worker — app id + per-env MANAGEMENT key (search + index-mutation):');
  console.log(`cd ../api`);
  console.log(`echo '${appId}'        | wrangler secret put ALGOLIA_APP_ID --env ${env}`);
  console.log(`echo '${managementKey}' | wrangler secret put ALGOLIA_ADMIN_KEY --env ${env}`);
  console.log(`\n${rule}\n`);
}

async function main() {
  const { env, rotate } = parseArgs(process.argv);

  if (!env || !VALID_ENVS.includes(env)) {
    fail(
      `--env is required and must be one of ${VALID_ENVS.join(' | ')}.\n` +
        `  (development folds onto the preview index set — provision 'preview'.)\n` +
        `  Usage: node scripts/algolia/provision.mjs --env <preview|staging|demo|production|stage2> [--rotate]`,
    );
  }

  const appId = process.env.ALGOLIA_APP_ID;
  const rootAdminKey = process.env.ALGOLIA_ADMIN_KEY;
  if (!appId || !rootAdminKey) {
    fail(
      `Set ALGOLIA_APP_ID and ALGOLIA_ADMIN_KEY (the app-wide ROOT admin key) in your shell.\n` +
        `  export ALGOLIA_APP_ID=…\n` +
        `  export ALGOLIA_ADMIN_KEY=<root admin key>   # operator-held; never pushed to a Worker`,
    );
  }

  console.log(`\nAlgolia provisioning — env=${env}${rotate ? ' (--rotate)' : ''}, app=${appId}\n`);

  const client = algoliasearch(appId, rootAdminKey);

  try {
    await ensureIndexes(client, env);

    console.log('\n• Provisioning scoped API keys:');
    const search = await ensureKey(client, searchKeyParams(env), { rotate });
    console.log(`    ${search.created ? '＋ created' : '↺ reused'} search-only key  (ACL: search)`);
    const management = await ensureKey(client, managementKeyParams(env), { rotate });
    console.log(
      `    ${management.created ? '＋ created' : '↺ reused'} management key   (ACL: search + index-mutation)`,
    );

    console.log('\n• Live key values (set as secrets — do NOT commit):');
    console.log(`    ALGOLIA_SEARCH_KEY = ${search.value}`);
    console.log(`    ALGOLIA_ADMIN_KEY  = ${management.value}   (per-env management key)`);

    printNextSteps({
      env,
      appId,
      searchKey: search.value,
      managementKey: management.value,
    });
  } catch (error) {
    fail(`Algolia API call failed: ${error?.message ?? error}`);
  }
}

main().catch((error) => fail(error?.stack ?? String(error)));

#!/usr/bin/env node
/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  Docs search index push — AECI-1270.  CI-SAFE (prints no secrets).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Builds the docs search records from the real docs manifest and syncs them
 * into ONE tier's docs index: `staging_docs` (`--env staging`) or
 * `production_docs` (`--env production`). Demo reads `production_docs` and
 * never pushes, so `--env demo` exits 1, as does anything else. The index name
 * comes from `docsIndexWriterFor`, which throws for every other tier.
 *
 * How the records are built: esbuild bundles
 * `apps/web/scripts/docs-search-records.entry.ts` in memory, with `.md` loaded
 * as text exactly as `angular.json` does, and the script imports the bundle.
 * The entry loads `@angular/localize/init` first, then the manifest and
 * `buildDocsSearchRecords`. So the records use the same anchors the rendered
 * pages do, and a manifest guard that throws at build time fails this push too.
 *
 * The sync is `syncDocsIndex` (`packages/shared/src/algolia.ts`): settings,
 * then save every record, then browse and delete the ids no longer built. Save
 * before delete, never `replaceAllObjects`.
 *
 * Runs in CI after the settings step: `deploy.yml` (deploy-staging) and
 * `promote-to-prod.yml` (deploy-prod-workers). Missing `ALGOLIA_APP_ID` /
 * `ALGOLIA_ADMIN_KEY` warns and exits 0, as `apply-settings.mjs` does. The key
 * must reach the docs index: the shared management key from
 * `provision.mjs --shared` does.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/algolia/push-docs.mjs --env <staging|production> [--dry-run]
 *   pnpm algolia:push-docs --env staging --dry-run
 *
 * `--dry-run` builds and prints the records and makes no network call. It needs
 * no credentials.
 *
 * Spec: docs/STAGE_2_PRODUCT_DOCS_SPEC.md §3 (Search); docs/CICD_PLAN.md §7.5;
 * docs/SEARCH_RANKING.md §3.5. ADR 0040.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

// Relative import (not `@aeci/shared/algolia`): Node type-strips only files
// outside node_modules. Matches provision.mjs and apply-settings.mjs.
import { docsIndexWriterFor, syncDocsIndex } from '../../packages/shared/src/algolia.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = join(ROOT, 'apps', 'web', 'scripts', 'docs-search-records.entry.ts');
const VALID_ENVS = ['staging', 'production'];

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const envIdx = args.indexOf('--env');
  return {
    env: envIdx >= 0 ? args[envIdx + 1] : undefined,
    dryRun: args.includes('--dry-run'),
  };
}

/**
 * Bundles the entry in memory and imports it. The bundle is written to a temp
 * directory, not beside the source, so a failed run leaves nothing in the repo.
 * `nodePaths` lets the bundle resolve `@angular/localize` and `marked` from the
 * web app's own node_modules.
 */
async function loadRecords() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    loader: { '.md': 'text' },
    absWorkingDir: join(ROOT, 'apps', 'web'),
    nodePaths: [join(ROOT, 'apps', 'web', 'node_modules')],
    tsconfig: join(ROOT, 'apps', 'web', 'tsconfig.app.json'),
    logLevel: 'silent',
  });
  const dir = await mkdtemp(join(tmpdir(), 'aeci-docs-search-'));
  const file = join(dir, 'records.mjs');
  try {
    await writeFile(file, result.outputFiles[0].text);
    const { buildRecords } = await import(pathToFileURL(file).href);
    return buildRecords();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const { env, dryRun } = parseArgs(process.argv);

  if (!env || !VALID_ENVS.includes(env)) {
    fail(
      `--env must be one of ${VALID_ENVS.join(' | ')}.\n` +
        `  Demo reads production_docs and never pushes. Local runs never push.\n` +
        `  Usage: node scripts/algolia/push-docs.mjs --env <staging|production> [--dry-run]`,
    );
  }

  let indexName;
  try {
    indexName = docsIndexWriterFor(env);
  } catch (error) {
    fail(error?.message ?? String(error));
  }

  let records;
  try {
    records = await loadRecords();
  } catch (error) {
    fail(`Could not build the docs search records: ${error?.message ?? error}`);
  }

  if (dryRun) {
    const byGuide = records.reduce((acc, record) => {
      acc[record.guide] = (acc[record.guide] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`\nDocs search push — env=${env}, index=${indexName} (--dry-run, no network)\n`);
    for (const record of records) {
      console.log(`  ${String(record.order).padStart(3)}  [${record.guide}]  ${record.objectID}`);
    }
    console.log('\nSample record:');
    console.log(JSON.stringify(records[0], null, 2));
    console.log(
      `\n${JSON.stringify({ index: indexName, records: records.length, byGuide, dryRun: true })}\n`,
    );
    return;
  }

  const appId = process.env.ALGOLIA_APP_ID;
  const adminKey = process.env.ALGOLIA_ADMIN_KEY;
  if (!appId || !adminKey) {
    console.warn(
      `\n⚠ ALGOLIA_APP_ID / ALGOLIA_ADMIN_KEY not set — skipping the docs search push ` +
        `for env=${env}. (Set the shared management key to enable.)\n`,
    );
    process.exit(0);
  }

  // Imported here, not at the top, so `--dry-run` and the skip path need no SDK.
  const { algoliasearch } = await import('algoliasearch');
  const client = algoliasearch(appId, adminKey);

  console.log(`\nDocs search push — env=${env}, index=${indexName}, app=${appId}\n`);
  try {
    const result = await syncDocsIndex(client, indexName, records);
    console.log(JSON.stringify(result));
    console.log(
      '\n✓ Done. Re-running with unchanged docs saves the same records and deletes none.\n',
    );
  } catch (error) {
    fail(`Algolia docs sync failed: ${error?.message ?? error}`);
  }
}

main().catch((error) => fail(error?.stack ?? String(error)));

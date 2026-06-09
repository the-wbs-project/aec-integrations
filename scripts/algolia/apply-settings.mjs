#!/usr/bin/env node
/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  Algolia index settings as code — AECI-137 / Phase 3.2.  OPERATOR + CI-SAFE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Idempotently applies the per-index settings (searchable attributes, faceting,
 * custom ranking — `STAGE_1_SPEC.md` §7.2/§7.3) defined in
 * `packages/shared/src/algolia.ts` to ONE environment's three indexes
 * (`<prefix>_products`, `<prefix>_vendors`, `<prefix>_integrations`).
 *
 * This is the entrypoint the CI "update Algolia indexes" step (CICD §3.2) runs
 * on every staging/prod deploy; the sync pipeline (3.5/3.6) calls the same shared
 * `applyIndexSettings()` directly. Re-running is a no-op when the settings are
 * unchanged (`setSettings` overwrites with an identical definition).
 *
 * Unlike `provision.mjs`, this prints NO secrets and is SAFE to wire into CI.
 *
 * ── Credentials ────────────────────────────────────────────────────────────
 * Reads from the environment:
 *   ALGOLIA_APP_ID    — the AECi application id (shared across all envs).
 *   ALGOLIA_ADMIN_KEY — the per-env MANAGEMENT key (ACL includes `editSettings`),
 *                       i.e. the value provisioned as `ALGOLIA_ADMIN_KEY_<ENV>`
 *                       and pushed onto the API Worker. (An operator may also use
 *                       the app-wide root admin key locally.)
 *
 * Missing creds → SKIP cleanly (exit 0 + warning). This lets the CI step ship
 * before the Algolia secrets are provisioned without ever failing a deploy —
 * mirrors `apps/web/src/algolia-bootstrap-inject.ts`'s no-op-when-absent posture.
 * An invalid/absent `--env`, by contrast, is an operator error and exits non-zero.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   ALGOLIA_APP_ID=… ALGOLIA_ADMIN_KEY=<per-env management key> \
 *     node scripts/algolia/apply-settings.mjs --env <preview|staging|production>
 *
 *   # or: pnpm algolia:apply-settings --env staging
 *
 * Requires Node ≥22.18 (native TypeScript type-stripping for the shared import);
 * the repo's `engines` floor (22.22.3) satisfies this.
 *
 * Spec: docs/STAGE_1_SPEC.md §7.2/§7.3 (settings); docs/CICD_PLAN.md §3.2 (CI
 * step), §7.5 (key topology). ADR 0006.
 */

import { algoliasearch } from 'algoliasearch';

// Relative import (not `@aeci/shared/algolia`): Node refuses to type-strip files
// resolved through node_modules, and the workspace package is symlinked there.
// Points straight at the source — the SAME file the Workers import — so the
// single-source-of-truth settings hold. Matches provision.mjs.
import { applyIndexSettings } from '../../packages/shared/src/algolia.ts';

const VALID_ENVS = ['preview', 'staging', 'production'];

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const envIdx = args.indexOf('--env');
  const env = envIdx >= 0 ? args[envIdx + 1] : undefined;
  return { env };
}

async function main() {
  const { env } = parseArgs(process.argv);

  if (!env || !VALID_ENVS.includes(env)) {
    fail(
      `--env is required and must be one of ${VALID_ENVS.join(' | ')}.\n` +
        `  (development folds onto the preview index set — apply 'preview'.)\n` +
        `  Usage: node scripts/algolia/apply-settings.mjs --env <preview|staging|production>`,
    );
  }

  const appId = process.env.ALGOLIA_APP_ID;
  const adminKey = process.env.ALGOLIA_ADMIN_KEY;

  // Graceful skip: a deploy must not fail just because Algolia isn't provisioned
  // yet. Exit 0 so the CI step is green; the settings get applied on the first
  // deploy after the secrets land.
  if (!appId || !adminKey) {
    console.warn(
      `\n⚠ ALGOLIA_APP_ID / ALGOLIA_ADMIN_KEY not set — skipping Algolia ` +
        `settings apply for env=${env}. (Set the per-env management key to enable.)\n`,
    );
    process.exit(0);
  }

  console.log(`\nAlgolia settings apply — env=${env}, app=${appId}\n`);

  const client = algoliasearch(appId, adminKey);

  try {
    const applied = await applyIndexSettings(client, env);
    console.log('• Applied searchable/facet/ranking settings to:');
    for (const { indexName, taskID } of applied) {
      console.log(`    ✓ ${indexName}  (task ${taskID})`);
    }
    console.log('\n✓ Done — settings are idempotent; re-running is a no-op when unchanged.\n');
  } catch (error) {
    fail(`Algolia setSettings failed: ${error?.message ?? error}`);
  }
}

main().catch((error) => fail(error?.stack ?? String(error)));

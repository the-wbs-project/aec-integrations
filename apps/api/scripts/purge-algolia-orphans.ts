/**
 * purge-algolia-orphans — one-off ops CLI (AECI-267, `STAGE_1_SPEC.md` §23.1).
 *
 * Deletes specific orphaned objects **by objectID** from an environment's Algolia
 * indexes. Defaults to the three AECI-65 "Fixture Procore" CI fixtures stranded in
 * the **staging** indexes by the Supabase→D1 cutover (they exist in the index but
 * not in staging D1 → detail pages 404, negative drift). Dry-run by default;
 * `--apply` performs the deletes. The testable core is `src/lib/algolia-orphan-purge.ts`;
 * this is a thin wrapper that supplies argv, `process.env` credentials, and console.
 *
 * Credentials (read from the environment — this script does NOT auto-load .dev.vars):
 *   - ALGOLIA_APP_ID     the Algolia application id (one app backs every env)
 *   - ALGOLIA_ADMIN_KEY  the app's MANAGEMENT (admin) key — has the deleteObject ACL.
 *                        (ALGOLIA_ADMIN_KEY_<ENV>, the CI secret name, is also
 *                        accepted and wins when both are set.)
 * `--env` selects the target indexes (`staging_*`), NOT the key — the one admin key
 * reaches any index in the app.
 *
 * Usage (from apps/api, with the two vars in the environment):
 *   pnpm --filter @aeci/api ops:purge-algolia-orphans -- --env staging          # dry-run
 *   pnpm --filter @aeci/api ops:purge-algolia-orphans -- --env staging --apply   # delete + verify
 *
 *   # override the target set (entity:objectID,…)
 *   … --env staging --ids products:<uuid>,vendors:<uuid> --apply
 *
 * NOTE: never "fix" stranded orphans by seeding the fixtures into a real catalog DB
 * — they are dev/CI-only. The correct end state is "absent from both D1 and the index".
 */

import {
  PROCORE_ORPHANS,
  assertEnvAllowed,
  createOrphanPurgeClient,
  parsePurgeArgs,
  resolveAlgoliaCreds,
  runOrphanPurge,
} from '../src/lib/algolia-orphan-purge';

async function main(): Promise<number> {
  const args = parsePurgeArgs(process.argv.slice(2));
  assertEnvAllowed(args);

  const creds = resolveAlgoliaCreds(args.env, process.env);
  if (!creds.appId || !creds.apiKey) {
    console.error(
      'Missing Algolia credentials. Set ALGOLIA_APP_ID and ALGOLIA_ADMIN_KEY ' +
        `(or ALGOLIA_ADMIN_KEY_${args.env.toUpperCase()}) in the environment — ` +
        "the app's management (admin) key, which carries the deleteObject ACL.",
    );
    return 1;
  }

  const orphans = args.ids ?? PROCORE_ORPHANS;
  const client = createOrphanPurgeClient(creds, fetch);
  const result = await runOrphanPurge({ client, log: console }, { ...args, orphans });
  return result.ok ? 0 : 1;
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('purge-algolia-orphans.ts');

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error('purge-algolia-orphans: fatal', err);
      process.exitCode = 1;
    });
}

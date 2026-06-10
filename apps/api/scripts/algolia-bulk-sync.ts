/**
 * Algolia bulk-sync CLI — Phase 3.5 (AECI-138, `STAGE_1_SPEC.md` §7.4 / §7.6).
 *
 * One-off, rerunnable full reindex: reads every PROMOTED product / vendor /
 * integration from Supabase, transforms to the §7.1 Algolia records (the AECI-137
 * transform), applies the §7.2/§7.3 index settings, and batch-uploads to one
 * environment's index set. The orchestration + record validation live in the
 * unit-tested core `src/lib/algolia-bulk-sync.ts`; this file is the thin runner
 * that parses argv and builds the real clients.
 *
 * Connection: like `reconcile-product-counts.ts` / the bulk-migrate script, this
 * is a Node CLI (never deployed). It uses the VANILLA `@prisma/client` over
 * `DIRECT_URL` (privileged Postgres role, bypassing RLS) — NOT Accelerate /
 * `@prisma/client/edge`; that rule is for the Worker runtime, not this CLI.
 *
 * Credentials (env / `apps/api/.dev.vars`):
 *   DIRECT_URL         — always required (the source DB to read from).
 *   ALGOLIA_APP_ID     — required for a real run (the shared AECi app id).
 *   ALGOLIA_ADMIN_KEY  — required for a real run: the per-env MANAGEMENT key
 *                        (search + addObject/deleteObject/editSettings), NEVER the
 *                        search-only key. `--dry-run` needs neither Algolia var.
 *
 * The operator points DIRECT_URL at the target env's DB, ALGOLIA_ADMIN_KEY at the
 * matching env's management key, and `--env` at that env's index prefix.
 * (`development` folds onto the preview set — pass `--env preview`.)
 *
 * Usage:
 *   pnpm --filter @aeci/api db:algolia-bulk-sync -- --env staging
 *   pnpm --filter @aeci/api db:algolia-bulk-sync -- --env preview --dry-run
 *   # or, from the repo root: pnpm algolia:bulk-sync -- --env staging
 *
 * Flags: --env <preview|staging|production> (required), --locale <code>
 * (default en-US), --dry-run (no writes), --skip-settings.
 *
 * Exit codes: 0 = success, 1 = bad args / missing creds / sync error.
 */

import { algoliasearch } from 'algoliasearch';

import { DEFAULT_LOCALE, type AlgoliaEnv } from '@aeci/shared/algolia';

import {
  runBulkSync,
  type AlgoliaBatchClient,
  type BulkSyncPrisma,
} from '../src/lib/algolia-bulk-sync';

const VALID_ENVS = ['preview', 'staging', 'production'] as const;

type ParsedArgs = {
  env: string | undefined;
  locale: string;
  dryRun: boolean;
  skipSettings: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const valueAfter = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    env: valueAfter('--env'),
    locale: valueAfter('--locale') ?? DEFAULT_LOCALE,
    dryRun: args.includes('--dry-run'),
    skipSettings: args.includes('--skip-settings'),
  };
}

/** Stub used only on a `--dry-run` without Algolia creds — the core never calls
 *  it in dry-run, so any invocation is a programming error. */
function unreachableAlgolia(): AlgoliaBatchClient {
  const boom = (): never => {
    throw new Error('Algolia client invoked during --dry-run (no credentials configured).');
  };
  return { setSettings: boom, saveObjects: boom };
}

export async function main(): Promise<number> {
  const { env, locale, dryRun, skipSettings } = parseArgs(process.argv);

  if (!env || !(VALID_ENVS as readonly string[]).includes(env)) {
    console.error(
      `--env is required and must be one of ${VALID_ENVS.join(' | ')}.\n` +
        `  (development folds onto the preview index set — apply 'preview'.)\n` +
        `  Usage: db:algolia-bulk-sync -- --env <preview|staging|production> [--locale <code>] [--dry-run] [--skip-settings]`,
    );
    return 1;
  }

  const directUrl = process.env.DIRECT_URL;
  if (!directUrl) {
    console.error('Missing required env: DIRECT_URL (set in apps/api/.dev.vars).');
    return 1;
  }

  const appId = process.env.ALGOLIA_APP_ID;
  const adminKey = process.env.ALGOLIA_ADMIN_KEY;

  let algolia: AlgoliaBatchClient;
  if (appId && adminKey) {
    algolia = algoliasearch(appId, adminKey) as unknown as AlgoliaBatchClient;
  } else if (dryRun) {
    algolia = unreachableAlgolia();
  } else {
    console.error(
      'Missing ALGOLIA_APP_ID / ALGOLIA_ADMIN_KEY (required for a real run).\n' +
        '  Set the per-env MANAGEMENT key, or pass --dry-run to preview without credentials.',
    );
    return 1;
  }

  // Vanilla client over DIRECT_URL (privileged role). NOT Accelerate / edge.
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: directUrl });

  try {
    const result = await runBulkSync(
      { prisma: prisma as unknown as BulkSyncPrisma, algolia },
      { env: env as AlgoliaEnv, locale, dryRun, skipSettings },
    );
    const failed = result.entities.some((e) => e.read > 0 && !dryRun && e.uploaded !== e.read);
    return failed ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('algolia-bulk-sync.ts');

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('algolia-bulk-sync: fatal', err);
      process.exitCode = 1;
    });
}

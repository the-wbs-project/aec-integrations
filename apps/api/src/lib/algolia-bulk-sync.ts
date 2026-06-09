/**
 * Algolia bulk reindex — the testable core of the Phase 3.5 one-off sync
 * (AECI-138, `STAGE_1_SPEC.md` §7.4 / §7.6).
 *
 * Reads every **promoted** product / vendor / integration from Supabase,
 * denormalizes each row into its §7.1 Algolia record via the AECI-137 transform
 * (`./algolia-transforms`), validates against the shared Zod schema, and
 * batch-uploads to one environment's index set. The thin CLI wrapper that builds
 * the real Prisma + Algolia clients and parses argv lives in
 * `apps/api/scripts/algolia-bulk-sync.ts`; this module is dependency-injected so
 * it unit-tests with fakes (it imports neither `@prisma/client` nor
 * `algoliasearch` at module load).
 *
 * Design notes:
 * - **Upsert, not replace.** Uploads go through `saveObjects`, which upserts by
 *   `objectID` (the Supabase UUID) — so a re-run replaces each record in place.
 *   We deliberately do NOT use `replaceAllObjects`: it stages writes in a
 *   `<index>_tmp_*` index that is outside the per-env management key's index
 *   scope (CICD_PLAN §7.5), so it would 403. Consequence: rows that fall out of
 *   `promoted` (retracted) are NOT pruned by this script — orphan removal is a
 *   separate, deliberately-scoped concern (out of 3.5).
 * - **Validate before upload.** The transforms return typed records but do not
 *   `.parse()`; we parse here so malformed data fails loud before it reaches the
 *   index (the contract `algolia-transforms.ts` documents).
 * - **0 rows is a clean state.** Each entity skips its upload when empty — in
 *   particular `integrations` stays empty until AECI-86 re-enables integration
 *   seeding in `POST /api/promote`.
 * - **Index settings.** Applies the §7.2/§7.3 settings (idempotent) to the
 *   target index set before uploading, reusing the shared `applyIndexSettingsTo`
 *   — the same single definition the CI step and 3.6 share. Skipped on dry-run.
 * - **Locale.** `localizedIndexNamesFor(env, locale)` selects the index set;
 *   `en-US` (default) is the bare `<prefix>_<entity>` set, other locales append
 *   `_<locale>` (§7.6 readiness). At launch only `en-US` exists.
 *
 * Spec: `STAGE_1_SPEC.md` §7.4 (sync strategy), §7.6 (per-locale indexes).
 */

import {
  applyIndexSettingsTo,
  DEFAULT_LOCALE,
  INDEX_ENTITIES,
  localizedIndexNamesFor,
  type AlgoliaEnv,
  type AlgoliaSettingsClient,
  type IndexEntity,
} from '@aeci/shared/algolia';
import {
  AlgoliaIntegrationRecordSchema,
  AlgoliaProductRecordSchema,
  AlgoliaVendorRecordSchema,
} from '@aeci/shared/algolia-records';

import {
  algoliaIntegrationSelect,
  algoliaProductSelect,
  algoliaVendorSelect,
  toAlgoliaIntegration,
  toAlgoliaProduct,
  toAlgoliaVendor,
  type RawAlgoliaIntegrationRow,
  type RawAlgoliaProductRow,
  type RawAlgoliaVendorRow,
} from './algolia-transforms';

/**
 * The `promotion_status` value that marks a row as live on the public site
 * (`docs/DATABASE_SCHEMA.md` CHECK constraint; the value `POST /api/promote`
 * writes). Only `products` and `vendors` carry the column — integrations are
 * promoted transitively when both endpoints are.
 */
const PROMOTED = 'promoted';

/**
 * Minimal Prisma surface this sync uses. Accepts a vanilla `PrismaClient`
 * (the CLI path over `DIRECT_URL`) or any client matching the shape — the script
 * is agnostic to the transport. Selects/return rows reuse the AECI-137
 * `*Select` shapes so a select change breaks the build here too.
 */
export type BulkSyncPrisma = {
  product: {
    findMany(args: {
      where: { promotionStatus: string };
      select: typeof algoliaProductSelect;
    }): Promise<RawAlgoliaProductRow[]>;
  };
  vendor: {
    findMany(args: {
      where: { promotionStatus: string };
      select: typeof algoliaVendorSelect;
    }): Promise<RawAlgoliaVendorRow[]>;
  };
  integration: {
    findMany(args: {
      where: {
        sourceProduct: { promotionStatus: string };
        targetProduct: { promotionStatus: string };
      };
      select: typeof algoliaIntegrationSelect;
    }): Promise<RawAlgoliaIntegrationRow[]>;
  };
};

/**
 * Minimal Algolia surface: index-settings application (via the shared
 * `AlgoliaSettingsClient`) plus `saveObjects` for batch upload. The v5
 * `algoliasearch` client satisfies this; tests inject a recording fake.
 */
export type AlgoliaBatchClient = AlgoliaSettingsClient & {
  saveObjects(args: {
    indexName: string;
    objects: Record<string, unknown>[];
    waitForTasks?: boolean;
  }): Promise<unknown>;
};

export type BulkSyncDeps = {
  prisma: BulkSyncPrisma;
  algolia: AlgoliaBatchClient;
  /** Defaults to `console`. Tests inject a recorder. */
  log?: Pick<Console, 'log' | 'warn'>;
};

export type BulkSyncOpts = {
  env: AlgoliaEnv;
  /** Per-locale index target (§7.6). Defaults to `en-US` (the bare index set). */
  locale?: string;
  /** Read + transform + validate and print the plan, but perform NO writes. */
  dryRun: boolean;
  /** Skip the idempotent index-settings apply (settings are also CI-managed). */
  skipSettings?: boolean;
};

export type BulkSyncEntityResult = {
  entity: IndexEntity;
  indexName: string;
  /** Promoted rows read + validated for this entity. */
  read: number;
  /** Records actually uploaded (0 on dry-run or when there were no rows). */
  uploaded: number;
};

export type BulkSyncResult = {
  env: AlgoliaEnv;
  locale: string;
  dryRun: boolean;
  settingsApplied: boolean;
  entities: BulkSyncEntityResult[];
};

/**
 * Full reindex of one env's (and locale's) Algolia indexes from the promoted
 * Supabase rows. Idempotent and rerunnable. Returns per-entity read/upload
 * counts for the caller to report and for CI assertions.
 */
export async function runBulkSync(deps: BulkSyncDeps, opts: BulkSyncOpts): Promise<BulkSyncResult> {
  const { prisma, algolia } = deps;
  const log = deps.log ?? console;
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const names = localizedIndexNamesFor(opts.env, locale);

  log.log(
    `Algolia bulk sync — env=${opts.env}, locale=${locale}${opts.dryRun ? ' (dry-run)' : ''}.`,
  );

  // ── Index settings (idempotent; §7.2/§7.3) ────────────────────────────────
  let settingsApplied = false;
  if (opts.skipSettings) {
    log.log('• Skipping index-settings apply (--skip-settings).');
  } else if (opts.dryRun) {
    log.log(
      `• [dry-run] would apply index settings to: ${INDEX_ENTITIES.map((e) => names[e]).join(', ')}`,
    );
  } else {
    const applied = await applyIndexSettingsTo(algolia, names);
    settingsApplied = true;
    log.log(`• Applied settings to: ${applied.map((a) => a.indexName).join(', ')}`);
  }

  // ── Per-entity upload ─────────────────────────────────────────────────────
  const syncEntity = async (
    entity: IndexEntity,
    indexName: string,
    records: Record<string, unknown>[],
  ): Promise<BulkSyncEntityResult> => {
    if (records.length === 0) {
      // 0 rows is an expected, clean state (esp. integrations until AECI-86).
      log.log(`• ${entity}: 0 promoted row(s) — ${indexName} left unchanged.`);
      return { entity, indexName, read: 0, uploaded: 0 };
    }
    if (opts.dryRun) {
      log.log(`• [dry-run] ${entity}: would upload ${records.length} record(s) to ${indexName}.`);
      return { entity, indexName, read: records.length, uploaded: 0 };
    }
    // saveObjects upserts by objectID (Supabase UUID) → re-run replaces in place.
    await algolia.saveObjects({ indexName, objects: records, waitForTasks: true });
    log.log(`• ${entity}: uploaded ${records.length} record(s) to ${indexName}.`);
    return { entity, indexName, read: records.length, uploaded: records.length };
  };

  const products = await prisma.product.findMany({
    where: { promotionStatus: PROMOTED },
    select: algoliaProductSelect,
  });
  const productRecords = products.map((row) =>
    AlgoliaProductRecordSchema.parse(toAlgoliaProduct(row)),
  );

  const vendors = await prisma.vendor.findMany({
    where: { promotionStatus: PROMOTED },
    select: algoliaVendorSelect,
  });
  const vendorRecords = vendors.map((row) => AlgoliaVendorRecordSchema.parse(toAlgoliaVendor(row)));

  // Integrations are promoted transitively: both endpoints must be promoted.
  // May be 0 rows until AECI-86 re-enables integration seeding.
  const integrations = await prisma.integration.findMany({
    where: {
      sourceProduct: { promotionStatus: PROMOTED },
      targetProduct: { promotionStatus: PROMOTED },
    },
    select: algoliaIntegrationSelect,
  });
  const integrationRecords = integrations.map((row) =>
    AlgoliaIntegrationRecordSchema.parse(toAlgoliaIntegration(row)),
  );

  const entities: BulkSyncEntityResult[] = [
    await syncEntity('products', names.products, productRecords),
    await syncEntity('vendors', names.vendors, vendorRecords),
    await syncEntity('integrations', names.integrations, integrationRecords),
  ];

  const totalRead = entities.reduce((n, e) => n + e.read, 0);
  const totalUploaded = entities.reduce((n, e) => n + e.uploaded, 0);
  log.log(
    `Done — read ${totalRead} record(s), uploaded ${totalUploaded}` +
      `${opts.dryRun ? ' (dry-run: nothing written)' : ''}.`,
  );

  return { env: opts.env, locale, dryRun: opts.dryRun, settingsApplied, entities };
}

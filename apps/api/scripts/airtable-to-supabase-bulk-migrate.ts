/**
 * ⚠️ DEPRECATED (superseded by `POST /api/promote`).
 *
 * Promotion is now PUSH-based: the review application sends each promoted
 * product (plus its vendors, taxonomy, and integrations) to the main AECi API,
 * which upserts them and returns the created IDs. See `apps/api/src/routes/
 * promote.ts` and the hand-off spec `docs/REVIEW_APP_PROMOTE_API.md`. This
 * pull-based CLI is retained as a one-shot bulk fallback only — prefer the API.
 *
 * AECI-83 / Phase 2.0 — one-time bulk migration: Airtable → Supabase.
 *
 * Reads every Airtable Product with `promotion_status='promoted'` and writes the
 * equivalent rows to Supabase production in dependency order. Promoted products
 * are the *driver*: each pulls in its linked vendors and taxonomy transitively,
 * and an integration migrates only when BOTH endpoint products are promoted
 * (both `source_product_id` / `target_product_id` are NOT NULL FKs). This is the
 * product-driven model — `promotion_status` exists only on the Products table,
 * not Vendors or Integrations (see DATABASE_SCHEMA.md §13.2 and the AECI-83
 * issue discussion).
 *
 * Slugs are generated inline at insert via `@aeci/shared/slug` — AECI-53's
 * backfill already ran against the empty DB, so this is the ONLY place migrated
 * records get a slug. Each entity insert writes an `audit_log` row in the same
 * transaction via `appendAuditLog` (Stage 1 Spec §26.1). Idempotent: records
 * already carrying a `supabase_uuid` (written back to Airtable) are skipped,
 * which inherently preserves curator-edited fields (§13.4) on re-run.
 *
 * Connection: this is a CLI script (never deployed). It uses the VANILLA
 * `@prisma/client` over `DIRECT_URL` (the privileged Postgres role, bypassing
 * RLS) — NOT Accelerate / `@prisma/client/edge`. That transport rule is for the
 * Worker runtime; a Node script talks to Postgres directly. Each entity is
 * written in an interactive `$transaction` (entity + audit row atomically), so
 * point `DIRECT_URL` at a session-capable connection — Supabase's "Session"
 * pooler or the direct 5432 endpoint — rather than a transaction-mode pooler.
 *
 * Usage:
 *   pnpm --filter @aeci/api db:airtable-migrate              # apply
 *   pnpm --filter @aeci/api db:airtable-migrate -- --dry-run # plan only (no writes)
 *
 * Required env (apps/api/.dev.vars or shell): DIRECT_URL, AIRTABLE_PAT,
 * AIRTABLE_BASE_ID. Optional: DD_API_KEY / DD_SITE to forward audit events.
 */

import { randomUUID } from 'node:crypto';

import { appendAuditLog, type AuditLogEntry, type AuditLogForwarder } from '@aeci/shared/audit-log';
import { disambiguateSlug, SlugReservedError, slugify } from '@aeci/shared/slug';

import { recomputeProductCounts } from '../src/lib/product-counts';
import { createAirtableGateway, type AirtableGateway, type AirtableRecord } from './lib/airtable';

// ─── Airtable table IDs (base appy81IdGJY6Fngf9) ─────────────────────────────
export const TABLES = {
  products: 'tbleVEZV0H5RigtHN',
  integrations: 'tbl6PBPsGJuPcrZZi',
  vendors: 'tbln8aZjwPI3Am4TF',
  categories: 'tbl0xEW7FPousftNs',
  disciplines: 'tbl0pNJbWBiA080o7',
  phases: 'tblkv9fmq2nUnjwE7',
} as const;

const SUPABASE_UUID_FIELD = 'supabase_uuid';
const PROMOTED_FILTER = "{promotion_status}='promoted'";

// ─── Injected dependencies (real client in main(); fakes in tests) ───────────
type Log = Pick<Console, 'log' | 'warn' | 'error'>;

/**
 * Structural Prisma surface the migration uses. A real `PrismaClient` satisfies
 * it; tests can pass the same. Kept as `any`-typed model accessors via the
 * generated client at the call sites — the interactive `$transaction` hands back
 * a transaction client structurally compatible with `appendAuditLog`.
 */
export type MigratePrisma = {
  $transaction<T>(fn: (tx: AnyPrisma) => Promise<T>): Promise<T>;
} & AnyPrisma;

// The generated client's model accessors are broad; we only touch a known
// subset. Typing them loosely keeps this script decoupled from the generated
// types while staying runtime-correct.
type AnyPrisma = {
  vendor: ModelDelegate;
  product: ModelDelegate;
  integration: ModelDelegate;
  productVendor: ModelDelegate;
  productCategory: ModelDelegate;
  productDiscipline: ModelDelegate;
  productPhase: ModelDelegate;
  productExtension: ModelDelegate;
  taxonomyCategory: ModelDelegate;
  taxonomyDiscipline: ModelDelegate;
  taxonomyPhase: ModelDelegate;
  // `review` is read-only here (count + _avg) — used by recomputeProductCounts
  // to maintain the denormalized product aggregates (AECI-104).
  review: ModelDelegate & {
    aggregate(args: {
      where?: Record<string, unknown>;
      _avg: Record<string, true>;
    }): Promise<{ _avg: Record<string, number | string | null> }>;
  };
  auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
};

type ModelDelegate = {
  create(args: {
    data: Record<string, unknown>;
  }): Promise<{ id: string } & Record<string, unknown>>;
  createMany(args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }): Promise<unknown>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
  findUnique(args: {
    where: Record<string, unknown>;
    select?: Record<string, boolean>;
  }): Promise<unknown>;
  findMany(args?: { select?: Record<string, boolean> }): Promise<{ id: string; slug: string }[]>;
  count(args?: { where?: Record<string, unknown> }): Promise<number>;
};

export interface MigrateDeps {
  airtable: AirtableGateway;
  prisma: MigratePrisma;
  /** Optional best-effort audit-event forwarder (Datadog). */
  forward?: AuditLogForwarder;
}

export interface MigrateOpts {
  dryRun: boolean;
  log?: Log;
}

export interface EntityCounters {
  scanned: number;
  inserted: number;
  skipped: number;
  errored: number;
}

export interface MigrateResult {
  taxonomy: EntityCounters;
  vendors: EntityCounters;
  products: EntityCounters;
  integrations: EntityCounters;
  /** Integrations skipped because one/both endpoint products weren't promoted. */
  integrationsSkippedUnmigratedEndpoint: number;
  verification: {
    ok: boolean;
    products: { expected: number; actual: number };
    vendors: { expected: number; actual: number };
    integrations: { expected: number; actual: number };
  };
}

const emptyCounters = (): EntityCounters => ({ scanned: 0, inserted: 0, skipped: 0, errored: 0 });

// ─── Airtable field coercion helpers ─────────────────────────────────────────
function str(fields: Record<string, unknown>, key: string): string | null {
  const v = fields[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}
function num(fields: Record<string, unknown>, key: string): number | null {
  const v = fields[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function bool(fields: Record<string, unknown>, key: string): boolean {
  return fields[key] === true;
}
/** multipleRecordLinks come back as an array of record IDs. */
function links(fields: Record<string, unknown>, key: string): string[] {
  const v = fields[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Compute a canonical slug, classifying the two expected failure modes. */
function canonicalSlug(
  name: string | null,
): { ok: true; slug: string } | { ok: false; reason: 'reserved' | 'empty' } {
  if (name === null) return { ok: false, reason: 'empty' };
  try {
    return { ok: true, slug: slugify(name) };
  } catch (err) {
    if (err instanceof SlugReservedError) return { ok: false, reason: 'reserved' };
    if (err instanceof TypeError) return { ok: false, reason: 'empty' };
    throw err;
  }
}

// ─── Core migration ──────────────────────────────────────────────────────────
export async function bulkMigrate(deps: MigrateDeps, opts: MigrateOpts): Promise<MigrateResult> {
  const { airtable, prisma, forward } = deps;
  const log = opts.log ?? console;
  const { dryRun } = opts;

  const result: MigrateResult = {
    taxonomy: emptyCounters(),
    vendors: emptyCounters(),
    products: emptyCounters(),
    integrations: emptyCounters(),
    integrationsSkippedUnmigratedEndpoint: 0,
    verification: {
      ok: true,
      products: { expected: 0, actual: 0 },
      vendors: { expected: 0, actual: 0 },
      integrations: { expected: 0, actual: 0 },
    },
  };

  // Insert an entity + its audit row atomically. UUID is generated in JS so it
  // is available for the rec-ID map and Airtable write-back before the insert.
  async function insertWithAudit(
    create: (tx: AnyPrisma) => Promise<void>,
    audit: AuditLogEntry,
  ): Promise<void> {
    if (dryRun) return;
    await prisma.$transaction(async (tx) => {
      await create(tx);
      await appendAuditLog(tx, audit, forward);
    });
  }

  // ── Step 1: ensure Airtable supabase_uuid fields exist (skip on dry run) ────
  if (!dryRun) {
    for (const t of [TABLES.products, TABLES.integrations, TABLES.vendors]) {
      const { created } = await airtable.ensureField(t, SUPABASE_UUID_FIELD, 'singleLineText');
      if (created) log.log(`[airtable] created field ${SUPABASE_UUID_FIELD} on ${t}`);
    }
  }

  // ── Step 2: read Airtable ───────────────────────────────────────────────────
  log.log('Reading Airtable…');
  const promotedProducts = await airtable.listRecords(TABLES.products, {
    filterByFormula: PROMOTED_FILTER,
  });
  const allVendors = await airtable.listRecords(TABLES.vendors);
  const allIntegrations = await airtable.listRecords(TABLES.integrations);
  const airtableCategories = await airtable.listRecords(TABLES.categories);
  const airtableDisciplines = await airtable.listRecords(TABLES.disciplines);
  const airtablePhases = await airtable.listRecords(TABLES.phases);

  const vendorsById = new Map(allVendors.map((v) => [v.id, v]));
  const promotedProductIds = new Set(promotedProducts.map((p) => p.id));
  log.log(
    `Found ${promotedProducts.length} promoted products, ${allVendors.length} vendors, ` +
      `${allIntegrations.length} integrations in Airtable.`,
  );

  // Maps: Airtable rec ID → Supabase UUID.
  const productUuid = new Map<string, string>();
  const vendorUuid = new Map<string, string>();
  const vendorSlugByRecId = new Map<string, string>();
  const categoryUuid = new Map<string, string>();
  const disciplineUuid = new Map<string, string>();
  const phaseUuid = new Map<string, string>();

  // Track which records this run newly inserted, for Airtable write-back.
  const newProductWriteback: { id: string; fields: Record<string, unknown> }[] = [];
  const newVendorWriteback: { id: string; fields: Record<string, unknown> }[] = [];
  const newIntegrationWriteback: { id: string; fields: Record<string, unknown> }[] = [];

  // ── Step 3: preload existing Supabase slugs for disambiguation ──────────────
  const loadSlugs = async (m: ModelDelegate) =>
    new Set((await m.findMany({ select: { id: true, slug: true } })).map((r) => r.slug));
  const vendorSlugs = await loadSlugs(prisma.vendor);
  const productSlugs = await loadSlugs(prisma.product);
  const categorySlugs = await loadSlugs(prisma.taxonomyCategory);
  const disciplineSlugs = await loadSlugs(prisma.taxonomyDiscipline);
  const phaseSlugs = await loadSlugs(prisma.taxonomyPhase);

  // Idempotency: has this Airtable record already been migrated (uuid present
  // AND the row exists in Supabase)? Returns the existing uuid if so.
  async function alreadyMigrated(
    rec: AirtableRecord,
    model: ModelDelegate,
  ): Promise<string | null> {
    const existing = str(rec.fields, SUPABASE_UUID_FIELD);
    if (!existing) return null;
    const row = await model.findUnique({ where: { id: existing }, select: { id: true } });
    if (row) return existing;
    log.warn(
      `[idempotency] ${rec.id} has stale ${SUPABASE_UUID_FIELD}=${existing} (no Supabase row) — re-inserting`,
    );
    return null;
  }

  // ── Step 4: taxonomy (find-or-create by canonical slug) ─────────────────────
  async function migrateTaxonomy(
    records: AirtableRecord[],
    model: ModelDelegate,
    slugSet: Set<string>,
    uuidMap: Map<string, string>,
    entity: 'category' | 'discipline' | 'phase',
  ): Promise<void> {
    const bySlug = new Map<string, string>();
    // Seed from existing rows so re-runs reuse, not duplicate.
    for (const r of await model.findMany({ select: { id: true, slug: true } }))
      bySlug.set(r.slug, r.id);

    for (const rec of records) {
      result.taxonomy.scanned += 1;
      const name = str(rec.fields, 'Name');
      const canonical = canonicalSlug(name);
      if (!canonical.ok) {
        log.warn(`[${entity}] ${rec.id} ${JSON.stringify(name)} → ERRORED (${canonical.reason})`);
        result.taxonomy.errored += 1;
        continue;
      }
      const existingId = bySlug.get(canonical.slug);
      if (existingId) {
        uuidMap.set(rec.id, existingId);
        result.taxonomy.skipped += 1;
        continue;
      }
      const slug = disambiguateSlug(canonical.slug, [...slugSet]);
      slugSet.add(slug);
      const id = randomUUID();
      uuidMap.set(rec.id, id);
      bySlug.set(slug, id);
      log.log(`[${entity}] ${name} → ${slug} ${dryRun ? '(WOULD WRITE)' : '(INSERT)'}`);
      await insertWithAudit(
        (tx) =>
          tx[
            entity === 'category'
              ? 'taxonomyCategory'
              : entity === 'discipline'
                ? 'taxonomyDiscipline'
                : 'taxonomyPhase'
          ]
            .create({
              data: { id, slug, name, description: str(rec.fields, 'Description') },
            })
            .then(() => undefined),
        { actorType: 'system', action: `${entity}.created`, entityType: entity, entityId: id },
      );
      result.taxonomy.inserted += 1;
    }
  }

  log.log('Migrating taxonomy…');
  await migrateTaxonomy(
    airtableCategories,
    prisma.taxonomyCategory,
    categorySlugs,
    categoryUuid,
    'category',
  );
  await migrateTaxonomy(
    airtableDisciplines,
    prisma.taxonomyDiscipline,
    disciplineSlugs,
    disciplineUuid,
    'discipline',
  );
  await migrateTaxonomy(airtablePhases, prisma.taxonomyPhase, phaseSlugs, phaseUuid, 'phase');

  // ── Step 5: vendors (those linked to a promoted product) ────────────────────
  const referencedVendorIds = new Set<string>();
  for (const p of promotedProducts)
    for (const vId of links(p.fields, 'vendors')) referencedVendorIds.add(vId);

  log.log(`Migrating ${referencedVendorIds.size} referenced vendors…`);
  for (const recId of referencedVendorIds) {
    const rec = vendorsById.get(recId);
    if (!rec) {
      log.warn(`[vendor] referenced rec ${recId} not found in Vendors table — skipping`);
      continue;
    }
    result.vendors.scanned += 1;

    const existing = await alreadyMigrated(rec, prisma.vendor);
    if (existing) {
      vendorUuid.set(recId, existing);
      const row = (await prisma.vendor.findUnique({
        where: { id: existing },
        select: { slug: true },
      })) as { slug: string } | null;
      if (row) vendorSlugByRecId.set(recId, row.slug);
      result.vendors.skipped += 1;
      continue;
    }

    const name = str(rec.fields, 'company_name');
    const canonical = canonicalSlug(name);
    if (!canonical.ok) {
      log.warn(`[vendor] ${recId} ${JSON.stringify(name)} → ERRORED (${canonical.reason})`);
      result.vendors.errored += 1;
      continue;
    }
    const slug = disambiguateSlug(canonical.slug, [...vendorSlugs]);
    vendorSlugs.add(slug);
    const id = randomUUID();
    vendorUuid.set(recId, id);
    vendorSlugByRecId.set(recId, slug);
    log.log(`[vendor] ${name} → ${slug} ${dryRun ? '(WOULD WRITE)' : '(INSERT)'}`);

    await insertWithAudit(
      (tx) =>
        tx.vendor
          .create({
            data: {
              id,
              slug,
              companyName: name,
              description: str(rec.fields, 'description'),
              website: str(rec.fields, 'website'),
              headquarters: str(rec.fields, 'headquarters'),
              foundedYear: num(rec.fields, 'founded_year'),
              publicPrivate: str(rec.fields, 'public_private'),
              parentCompany: str(rec.fields, 'parent_company'),
              linkedinUrl: str(rec.fields, 'linkedin_url'),
              crunchbaseUrl: str(rec.fields, 'crunchbase_url'),
              wikiUrl: str(rec.fields, 'wiki_url'),
              sourceUrl: str(rec.fields, 'source_url'),
              githubOrg: str(rec.fields, 'github_org'),
              phoneNumber: str(rec.fields, 'phone_number'),
              contactEmail: str(rec.fields, 'contact_email'),
              logoUrl: str(rec.fields, 'logo_url'),
              vqsCredibility: num(rec.fields, 'vqs_credibility'),
              vqsMomentum: num(rec.fields, 'vqs_momentum'),
              vqsFit: num(rec.fields, 'vqs_fit'),
              vqsTotal: num(rec.fields, 'vqs_score'),
              adminNotes: str(rec.fields, 'admin_notes'),
              verified: false,
              promotionStatus: 'promoted',
            },
          })
          .then(() => undefined),
      { actorType: 'system', action: 'vendor.created', entityType: 'vendor', entityId: id },
    );
    result.vendors.inserted += 1;
    newVendorWriteback.push({ id: recId, fields: { [SUPABASE_UUID_FIELD]: id } });
  }

  // ── Step 6: products (+ product_vendors, taxonomy joins) ────────────────────
  // Pass A: assign UUIDs up front so extension self-links resolve in Pass C.
  const migratedProductRecIds = new Set<string>();
  for (const p of promotedProducts) {
    const existing = await alreadyMigrated(p, prisma.product);
    if (existing) {
      productUuid.set(p.id, existing);
      migratedProductRecIds.add(p.id);
    } else {
      productUuid.set(p.id, randomUUID());
    }
  }

  log.log(`Migrating ${promotedProducts.length} promoted products…`);
  for (const p of promotedProducts) {
    result.products.scanned += 1;
    const id = productUuid.get(p.id)!;

    if (migratedProductRecIds.has(p.id)) {
      result.products.skipped += 1;
      continue;
    }

    const name = str(p.fields, 'Name');
    const vendorRecIds = links(p.fields, 'vendors').filter((v) => vendorUuid.has(v));
    const primaryVendorSlug = vendorRecIds[0] ? vendorSlugByRecId.get(vendorRecIds[0]) : undefined;
    const canonical = canonicalSlug(name);
    if (!canonical.ok) {
      log.warn(`[product] ${p.id} ${JSON.stringify(name)} → ERRORED (${canonical.reason})`);
      result.products.errored += 1;
      continue;
    }
    const slug = disambiguateSlug(canonical.slug, [...productSlugs], primaryVendorSlug);
    productSlugs.add(slug);
    log.log(`[product] ${name} → ${slug} ${dryRun ? '(WOULD WRITE)' : '(INSERT)'}`);

    const categoryIds = links(p.fields, 'category')
      .map((r) => categoryUuid.get(r))
      .filter((x): x is string => !!x);
    const disciplineIds = links(p.fields, 'supported_disciplines')
      .map((r) => disciplineUuid.get(r))
      .filter((x): x is string => !!x);
    const phaseIds = links(p.fields, 'supported_project_phases')
      .map((r) => phaseUuid.get(r))
      .filter((x): x is string => !!x);

    await insertWithAudit(
      async (tx) => {
        await tx.product.create({
          data: {
            id,
            slug,
            name,
            description: str(p.fields, 'description'),
            website: str(p.fields, 'website'),
            toolIntegrationsUrl: str(p.fields, 'tool_integrations_url'),
            apiDocsUrl: str(p.fields, 'api_docs_url'),
            hasApiDocs: bool(p.fields, 'has_api_docs'),
            toolIntegrationCheckNotes: str(p.fields, 'tool_integration_check_notes'),
            productRole: str(p.fields, 'product_role') ?? 'application',
            researchStatus: str(p.fields, 'research_status') ?? 'pending',
            researchNotes: str(p.fields, 'research_notes'),
            priorityTier: str(p.fields, 'priority_tier'),
            priorityScore: num(p.fields, 'priority_score'),
            googleTrendsIndex: num(p.fields, 'google_trends_index'),
            searchVolumeMonthly: num(p.fields, 'search_volume_monthly'),
            redditMentions24mo: num(p.fields, 'reddit_mentions_24mo'),
            adminNotes: str(p.fields, 'admin_notes'),
            promotionStatus: 'promoted',
          },
        });
        if (vendorRecIds.length) {
          await tx.productVendor.createMany({
            data: vendorRecIds.map((vRec, i) => ({
              productId: id,
              vendorId: vendorUuid.get(vRec)!,
              isPrimary: i === 0,
            })),
            skipDuplicates: true,
          });
        }
        if (categoryIds.length) {
          await tx.productCategory.createMany({
            data: categoryIds.map((categoryId) => ({ productId: id, categoryId })),
            skipDuplicates: true,
          });
        }
        if (disciplineIds.length) {
          await tx.productDiscipline.createMany({
            data: disciplineIds.map((disciplineId) => ({ productId: id, disciplineId })),
            skipDuplicates: true,
          });
        }
        if (phaseIds.length) {
          await tx.productPhase.createMany({
            data: phaseIds.map((phaseId) => ({ productId: id, phaseId })),
            skipDuplicates: true,
          });
        }
      },
      { actorType: 'system', action: 'product.created', entityType: 'product', entityId: id },
    );

    result.products.inserted += 1;
    newProductWriteback.push({ id: p.id, fields: { [SUPABASE_UUID_FIELD]: id } });
  }

  // Pass C: product_extensions (now every promoted product UUID is known).
  // Uses insertWithAudit so each extension batch commits atomically with its
  // audit row. insertWithAudit already no-ops on dry run.
  for (const p of promotedProducts) {
    const productId = productUuid.get(p.id);
    if (!productId) continue;
    const hostIds = links(p.fields, 'extension_of')
      .filter((r) => promotedProductIds.has(r))
      .map((r) => productUuid.get(r))
      .filter((x): x is string => !!x);
    if (!hostIds.length) continue;
    await insertWithAudit(
      (tx) =>
        tx.productExtension
          .createMany({
            data: hostIds.map((hostProductId) => ({ productId, hostProductId })),
            skipDuplicates: true,
          })
          .then(() => undefined),
      {
        actorType: 'system',
        action: 'product.extension_created',
        entityType: 'product',
        entityId: productId,
      },
    );
  }

  // ── Step 7: integrations (both endpoints promoted) ──────────────────────────
  log.log('Migrating integrations…');
  for (const intg of allIntegrations) {
    const sourceRec = links(intg.fields, 'Source Tool')[0];
    const targetRec = links(intg.fields, 'Target Tool')[0];
    const sourceId = sourceRec ? productUuid.get(sourceRec) : undefined;
    const targetId = targetRec ? productUuid.get(targetRec) : undefined;
    if (!sourceId || !targetId) {
      result.integrationsSkippedUnmigratedEndpoint += 1;
      continue;
    }
    result.integrations.scanned += 1;

    const existing = await alreadyMigrated(intg, prisma.integration);
    if (existing) {
      result.integrations.skipped += 1;
      continue;
    }

    const id = randomUUID();
    const builtByRec = links(intg.fields, 'built_by')[0];
    const poweredByRec = links(intg.fields, 'powered_by_product')[0];
    const builtByVendorId = builtByRec ? (vendorUuid.get(builtByRec) ?? null) : null;
    const poweredByProductId = poweredByRec ? (productUuid.get(poweredByRec) ?? null) : null;

    log.log(
      `[integration] ${str(intg.fields, 'Name') ?? '(unnamed)'} ${dryRun ? '(WOULD WRITE)' : '(INSERT)'}`,
    );
    await insertWithAudit(
      (tx) =>
        tx.integration
          .create({
            data: {
              id,
              name: str(intg.fields, 'Name'),
              sourceProductId: sourceId,
              targetProductId: targetId,
              mechanismKind: str(intg.fields, 'mechanism_kind'),
              mechanismName: str(intg.fields, 'mechanism_name'),
              direction: str(intg.fields, 'direction'),
              builtByVendorId,
              poweredByProductId,
              description: str(intg.fields, 'Description'),
              listingUrl: str(intg.fields, 'listing_url'),
              docsUrl: str(intg.fields, 'docs_url'),
              website: str(intg.fields, 'website'),
              mechanismUrl: str(intg.fields, 'mechanism_url'),
              pricingModel: str(intg.fields, 'pricing_model'),
              maturity: str(intg.fields, 'maturity'),
              notes: str(intg.fields, 'notes'),
            },
          })
          .then(() => undefined),
      {
        actorType: 'system',
        action: 'integration.created',
        entityType: 'integration',
        entityId: id,
      },
    );
    result.integrations.inserted += 1;
    newIntegrationWriteback.push({ id: intg.id, fields: { [SUPABASE_UUID_FIELD]: id } });
  }

  // ── Step 8: recompute denormalized product counts ───────────────────────────
  // Shared helper recomputes integration_count, review_count, and the rating
  // averages from source rows (AECI-104). review aggregates resolve to 0/NULL
  // here since the migration writes no reviews, but the single code path keeps
  // this in lock-step with every other write path.
  if (!dryRun) {
    log.log('Recomputing denormalized product counts…');
    await recomputeProductCounts(prisma, productUuid.values());
  }

  // ── Step 9: write supabase_uuid back to Airtable ────────────────────────────
  if (!dryRun) {
    if (newVendorWriteback.length) await airtable.patchRecords(TABLES.vendors, newVendorWriteback);
    if (newProductWriteback.length)
      await airtable.patchRecords(TABLES.products, newProductWriteback);
    if (newIntegrationWriteback.length)
      await airtable.patchRecords(TABLES.integrations, newIntegrationWriteback);
  }

  // ── Step 10: verify counts ──────────────────────────────────────────────────
  const expectedProducts = promotedProducts.length;
  const expectedVendors = referencedVendorIds.size;
  const expectedIntegrations = result.integrations.scanned;
  if (!dryRun) {
    result.verification.products = {
      expected: expectedProducts,
      actual: await prisma.product.count({ where: { id: { in: [...productUuid.values()] } } }),
    };
    result.verification.vendors = {
      expected: expectedVendors,
      actual: await prisma.vendor.count({ where: { id: { in: [...vendorUuid.values()] } } }),
    };
    result.verification.integrations = {
      expected: expectedIntegrations,
      actual: result.integrations.inserted + result.integrations.skipped,
    };
    const v = result.verification;
    v.ok =
      v.products.expected === v.products.actual &&
      v.vendors.expected === v.vendors.actual &&
      v.integrations.expected === v.integrations.actual;
    if (!v.ok) {
      log.error(
        `VERIFICATION FAILED: products ${v.products.expected}/${v.products.actual}, ` +
          `vendors ${v.vendors.expected}/${v.vendors.actual}, ` +
          `integrations ${v.integrations.expected}/${v.integrations.actual}`,
      );
    }
  }

  return result;
}

// ─── CLI entry ────────────────────────────────────────────────────────────────
/**
 * Best-effort Datadog forwarder for the CLI. Fire-and-forget (returns void
 * immediately, mirroring the Worker's `ctx.waitUntil`) so it never holds an
 * audit transaction open on a network call. Collects in-flight promises so
 * `main()` can drain them before exit. No-op when `DD_API_KEY` is unset.
 */
function createCliForwarder(pending: Promise<unknown>[]): AuditLogForwarder | undefined {
  const apiKey = process.env.DD_API_KEY;
  if (!apiKey) return undefined;
  const site = process.env.DD_SITE || 'us5.datadoghq.com';
  const url = `https://http-intake.logs.${site}/api/v2/logs`;
  return (entry) => {
    pending.push(
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'dd-api-key': apiKey },
        body: JSON.stringify({
          message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
          status: 'info',
          service: 'aeci-api',
          ddsource: 'cli',
          ddtags: 'app:aeci,worker:airtable-migrate',
          ...entry,
        }),
      }).catch((e) => console.warn('cli forwarder: forward failed', e)),
    );
  };
}

function formatCounters(label: string, c: EntityCounters): string {
  return `${label}: scanned=${c.scanned} inserted=${c.inserted} skipped=${c.skipped} errored=${c.errored}`;
}

async function main() {
  console.warn(
    '[DEPRECATED] This pull-based bulk migration is superseded by POST /api/promote ' +
      '(push from the review app). See docs/REVIEW_APP_PROMOTE_API.md. Continuing…',
  );
  const dryRun = process.argv.includes('--dry-run');
  const directUrl = process.env.DIRECT_URL;
  const pat = process.env.AIRTABLE_PAT;
  const baseId = process.env.AIRTABLE_BASE_ID;

  const missing = [
    !directUrl && 'DIRECT_URL',
    !pat && 'AIRTABLE_PAT',
    !baseId && 'AIRTABLE_BASE_ID',
  ].filter(Boolean);
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(', ')} (set in apps/api/.dev.vars).`);
    process.exit(1);
  }

  // Vanilla client over DIRECT_URL (privileged role, bypasses RLS). NOT
  // Accelerate / edge — that rule is for the Worker runtime, not this CLI.
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: directUrl });
  const airtable = createAirtableGateway({ pat: pat!, baseId: baseId! });
  const pending: Promise<unknown>[] = [];
  const forward = createCliForwarder(pending);

  console.log(`Airtable → Supabase bulk migration starting (dryRun=${dryRun}).`);
  try {
    const result = await bulkMigrate(
      { airtable, prisma: prisma as unknown as MigratePrisma, forward },
      { dryRun },
    );
    await Promise.allSettled(pending);

    console.log('─── Summary ─────────────────────────────────────────');
    console.log(formatCounters('taxonomy', result.taxonomy));
    console.log(formatCounters('vendors', result.vendors));
    console.log(formatCounters('products', result.products));
    console.log(formatCounters('integrations', result.integrations));
    console.log(
      `integrations skipped (endpoint not promoted): ${result.integrationsSkippedUnmigratedEndpoint}`,
    );

    const errored =
      result.taxonomy.errored +
      result.vendors.errored +
      result.products.errored +
      result.integrations.errored;
    if (dryRun) {
      console.log('Dry run complete — no rows written.');
    } else if (!result.verification.ok) {
      process.exitCode = 1;
    } else if (errored > 0) {
      console.warn(`Completed with ${errored} ERRORED record(s) — review the log above.`);
      process.exitCode = 2;
    } else {
      console.log('Verification passed.');
    }
  } finally {
    await (prisma as unknown as { $disconnect(): Promise<void> }).$disconnect();
  }
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('airtable-to-supabase-bulk-migrate.ts') ||
    process.argv[1].endsWith('airtable-to-supabase-bulk-migrate.js'));
if (invokedDirectly) {
  void main();
}

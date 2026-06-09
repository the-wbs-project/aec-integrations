/**
 * `POST /api/promote` — push-based Airtable → Supabase promotion.
 *
 * The review application sends one product plus its dependencies; this handler
 * upserts the whole bundle in a single transaction and returns the resulting
 * IDs (see `@aeci/shared` `PromotePayloadSchema` / `PromoteResponse` for the
 * contract and the idempotency model). Supersedes the pull-based CLI script
 * `scripts/airtable-to-supabase-bulk-migrate.ts` (now deprecated).
 *
 * Design notes:
 *   - **Upsert by caller-supplied `supabaseId`.** Present → update; absent →
 *     create. The review app holds the IDs (no `external_id` column exists).
 *   - **Slugs are server-owned.** Generated on create via `@aeci/shared/slug`
 *     (`slugify` + `disambiguateSlug`); kept stable on update.
 *   - **Atomic.** The whole bundle runs inside one interactive
 *     `prisma.$transaction`; an audit row is written for every create/update in
 *     the same transaction (Stage 1 Spec §26.1 — failure to log rolls back).
 *   - **Joins are replaced, not merged.** On update, the product's
 *     vendor/taxonomy/extension join rows are deleted and re-inserted so they
 *     reflect the pushed state exactly.
 *   - **Endpoint resolution.** Integrations whose source/target can't be
 *     resolved (the other product isn't promoted yet) are reported in
 *     `skipped[]` rather than failing the request — this preserves the
 *     product-driven "both endpoints promoted" rule from AECI-83.
 *
 * Cache purge (AECI-105): promotion mutates cacheable product / vendor /
 * taxonomy pages, so after the transaction commits the handler purges the
 * affected `Cache-Tag`s by calling Cloudflare's purge-by-tag API **directly**
 * (`@aeci/shared` `callCloudflarePurge`). It used to call the SSR Worker's
 * `POST /admin/purge` over a `WEB` service binding; that web↔api cycle was
 * removed in Option B (`docs/adr/0010-promote-purges-cloudflare-directly.md`) —
 * the API now holds its own `Zone.Cache Purge`-scoped token. Tags are derived in
 * `cacheTagsForPromote` to match what SSR emits (`docs/CACHE_STRATEGY.md` §2).
 * The purge is **best-effort and post-commit**: it runs via `ctx.waitUntil`
 * (never blocks or fails the already-committed promote) and a failure is logged
 * to Datadog — worst-case staleness reverts to the edge TTL (≤15 min), i.e. no
 * regression vs. before this change. When `CF_PURGE_API_TOKEN` / `CF_ZONE_ID`
 * are unset (e.g. local `pnpm dev:bound`, PR previews) the purge is a graceful
 * no-op.
 *
 * Two known, bounded staleness gaps remain out of scope (documented in
 * `docs/REVIEW_APP_PROMOTE_API.md`): embedded reverse-tagging is Phase 4, and
 * integration tags wait on AECI-86 re-enabling integration seeding below.
 */

import {
  callCloudflarePurge,
  CF_PURGE_MAX_TAGS,
  PromotePayloadSchema,
  type EntityRef,
  type PromoteEntityResult,
  type PromoteIntegrationResult,
  type PromoteResponse,
  type PromoteSkipped,
  type PromoteTaxonomyResult,
  type PromoteVendor,
  type PromoteProduct,
  type PromoteIntegration,
} from '@aeci/shared';
import { type AlgoliaEnv } from '@aeci/shared/algolia';
import { appendAuditLog, type AuditLogEntry, type AuditLogForwarder } from '@aeci/shared/audit-log';
import { disambiguateSlug, SlugReservedError, slugify } from '@aeci/shared/slug';
import type { Context } from 'hono';

import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import { syncPromoteTargets, type AlgoliaSyncPrisma } from '../lib/algolia-sync';
import type { PrismaFactory } from '../lib/handler-utils';
import { recomputeProductCounts } from '../lib/product-counts';
import { getPrisma } from '../prisma';
import { cacheTagsForPromote } from './promote-cache-tags';

// ─── Loose structural Prisma surface ─────────────────────────────────────────
// Mirrors the decoupling approach in the bulk-migrate script: we touch a small,
// known slice of the generated client, so we type it structurally rather than
// dragging in the full generated types (which differ between the edge and node
// clients). A real accelerated client and a test fake both satisfy this.
type Row = { id: string; slug?: string } & Record<string, unknown>;

type ModelDelegate = {
  create(args: { data: Record<string, unknown> }): Promise<Row>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<Row>;
  createMany(args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }): Promise<unknown>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  findUnique(args: {
    where: Record<string, unknown>;
    select?: Record<string, boolean>;
  }): Promise<Row | null>;
  findMany(args?: {
    where?: Record<string, unknown>;
    select?: Record<string, boolean>;
  }): Promise<Row[]>;
  count(args?: { where?: Record<string, unknown> }): Promise<number>;
};

type PromoteTx = {
  vendor: ModelDelegate;
  product: ModelDelegate;
  integration: ModelDelegate;
  productVendor: ModelDelegate;
  productCategory: ModelDelegate;
  productAudience: ModelDelegate;
  productPhase: ModelDelegate;
  productExtension: ModelDelegate;
  taxonomyCategory: ModelDelegate;
  taxonomyAudience: ModelDelegate;
  taxonomyPhase: ModelDelegate;
  // `recomputeProductCounts` reads approved reviews to refresh `review_count` and
  // the rating averages alongside `integration_count`, so it needs `review` with
  // both `count` and `aggregate` (the latter is absent from `ModelDelegate`).
  review: {
    count(args?: { where?: Record<string, unknown> }): Promise<number>;
    aggregate(args: { where?: Record<string, unknown>; _avg: Record<string, true> }): Promise<{
      _avg: Record<string, number | string | { toString(): string } | null | undefined>;
    }>;
  };
  auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
};

type PromoteClient = {
  vendor: Pick<ModelDelegate, 'findMany'>;
  product: Pick<ModelDelegate, 'findMany'>;
  $transaction<T>(fn: (tx: PromoteTx) => Promise<T>, options?: Record<string, unknown>): Promise<T>;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
/** Drop keys whose value is `undefined` so Prisma leaves them untouched. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/** Generate a slug or throw a typed 400 for the two expected failure modes. */
function generateSlug(name: string, existing: Set<string>, vendorSlug?: string): string {
  let base: string;
  try {
    base = slugify(name);
  } catch (err) {
    if (err instanceof SlugReservedError) {
      throw new ApiError(400, 'VALIDATION_FAILED', `Name "${name}" maps to a reserved slug`, {
        field: 'name',
      });
    }
    throw new ApiError(400, 'VALIDATION_FAILED', `Name "${name}" cannot be converted to a slug`, {
      field: 'name',
    });
  }
  const slug = disambiguateSlug(base, [...existing], vendorSlug);
  existing.add(slug);
  return slug;
}

/**
 * True when `err` is a Prisma `P2002` (unique-constraint violation) on a `slug`
 * column/index. Slugs are preloaded *before* the transaction (`loadSlugs`), so
 * two concurrent first-time promotes can both generate the same slug and the
 * second `tx.create` then trips `vendors_slug_key` / `products_slug_key`. That
 * is a caller-resolvable conflict, not a server fault — the handler translates
 * it to a documented `409 SLUG_CONFLICT` (AECI-98) instead of a generic 500.
 *
 * Duck-typed (rather than `instanceof Prisma.PrismaClientKnownRequestError`) so
 * it stays trivially testable and doesn't pull the edge client's error class
 * into the runtime path. `meta.target` is matched in both shapes Prisma emits:
 * an array of columns (`['slug']`) and a constraint-name string
 * (`'vendors_slug_key'`). Non-slug `P2002`s return false and fall through to the
 * generic 500 so unrelated unique violations are never mislabeled.
 */
function isSlugUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; meta?: { target?: unknown } };
  if (e.code !== 'P2002') return false;
  const target = e.meta?.target;
  const asStr = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return asStr.toLowerCase().includes('slug');
}

function vendorEditableData(v: PromoteVendor): Record<string, unknown> {
  return compact({
    description: v.description,
    website: v.website,
    headquarters: v.headquarters,
    foundedYear: v.foundedYear,
    publicPrivate: v.publicPrivate,
    parentCompany: v.parentCompany,
    linkedinUrl: v.linkedinUrl,
    crunchbaseUrl: v.crunchbaseUrl,
    wikiUrl: v.wikiUrl,
    sourceUrl: v.sourceUrl,
    githubOrg: v.githubOrg,
    phoneNumber: v.phoneNumber,
    contactEmail: v.contactEmail,
    logoUrl: v.logoUrl,
    verified: v.verified,
  });
}

function productEditableData(p: PromoteProduct): Record<string, unknown> {
  return compact({
    description: p.description,
    website: p.website,
    toolIntegrationsUrl: p.toolIntegrationsUrl,
    apiDocsUrl: p.apiDocsUrl,
    hasApiDocs: p.hasApiDocs,
    toolIntegrationCheckNotes: p.toolIntegrationCheckNotes,
    logoUrl: p.logoUrl,
    productRole: p.productRole,
    researchStatus: p.researchStatus,
    researchNotes: p.researchNotes,
    priorityTier: p.priorityTier,
    priorityScore: p.priorityScore,
    googleTrendsIndex: p.googleTrendsIndex,
    searchVolumeMonthly: p.searchVolumeMonthly,
    redditMentions24mo: p.redditMentions24mo,
    adminNotes: p.adminNotes,
  });
}

// Field projection for the integration upsert in the seeding block below.
function integrationEditableData(intg: PromoteIntegration): Record<string, unknown> {
  return compact({
    name: intg.name,
    mechanismKind: intg.mechanismKind,
    mechanismName: intg.mechanismName,
    direction: intg.direction,
    description: intg.description,
    listingUrl: intg.listingUrl,
    docsUrl: intg.docsUrl,
    website: intg.website,
    mechanismUrl: intg.mechanismUrl,
    pricingModel: intg.pricingModel,
    maturity: intg.maturity,
    notes: intg.notes,
  });
}

function makeForwarder(c: Context<{ Bindings: Env }>): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: 'review-app-promote',
    });
  };
}

const AUDIT_META = { source: 'review-app-promote' } as const;

// ─── Cache purge (AECI-105) ──────────────────────────────────────────────────
// Cloudflare's purge-by-tag API accepts ≤CF_PURGE_MAX_TAGS (30) tags per call;
// a promote rarely touches that many, so chunking is defensive.

/**
 * Best-effort, post-commit edge-cache purge for a promote. No-ops when
 * `CF_PURGE_API_TOKEN` / `CF_ZONE_ID` is absent, or when nothing cacheable
 * changed. Batches are fired concurrently; each batch's outcome is recorded as
 * `aeci.cache.purge{source:promote,outcome:ok|cf_failed}` (preserving the
 * dashboard series the web Worker used to emit) and a failed batch is logged
 * (Datadog `warn`) and swallowed so it never affects the already-committed
 * promote.
 */
async function purgeAfterPromote(
  c: Context<{ Bindings: Env }>,
  response: PromoteResponse,
): Promise<void> {
  const creds = { apiToken: c.env.CF_PURGE_API_TOKEN, zoneId: c.env.CF_ZONE_ID };
  if (!creds.apiToken || !creds.zoneId) return;

  const tags = cacheTagsForPromote(response);
  if (tags.length === 0) return;

  const batches: string[][] = [];
  for (let i = 0; i < tags.length; i += CF_PURGE_MAX_TAGS) {
    batches.push(tags.slice(i, i + CF_PURGE_MAX_TAGS));
  }

  await Promise.allSettled(
    batches.map(async (batch) => {
      const outcome = await callCloudflarePurge(fetch, creds, batch);
      submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.cache.purge', 1, [
        'source:promote',
        `outcome:${outcome.ok ? 'ok' : 'cf_failed'}`,
      ]);
      if (!outcome.ok) {
        logPurgeFailure(c, batch, `cf_${outcome.status}: ${outcome.message}`);
      }
    }),
  );
}

function logPurgeFailure(c: Context<{ Bindings: Env }>, batch: string[], reason: string): void {
  logToDatadog(c.executionCtx, c.env, c.req.raw, {
    level: 'warn',
    message: 'aeci.api.promote.cache_purge_failed',
    source: 'review-app-promote',
    reason,
    tags: batch.join(','),
    tags_count: batch.length,
  });
}

// ─── Algolia index sync (AECI-139) ───────────────────────────────────────────
// Closes the "viewable on promote (purge) but not searchable until 03:00" gap:
// after the commit, push the just-promoted records to Algolia immediately so the
// index matches the freshly-purged pages. Best-effort and post-commit — fired via
// `waitUntil` (never blocks/fails the promote), gated on the Algolia secrets, and
// each entity's outcome is recorded as `aeci.algolia.sync{trigger:promote,...}`
// (the cron emits the same metric with `trigger:cron`). A promote only ever
// writes `promotionStatus:'promoted'`, so this path upserts; the delete path
// (retract/reject) is the daily cron's job. Index membership + transport live in
// `lib/algolia-sync.ts`.

/**
 * Best-effort post-commit Algolia upsert for a promote. Re-queries the touched
 * rows by id (the response carries ids, not full denormalized records) and pushes
 * them to the env's indexes via the shared sync core. No-ops for an entity the
 * promote didn't touch. Never throws (the sync core is never-throw; the outer
 * try/catch is belt-and-suspenders so a bug can't reject the `waitUntil`).
 */
async function syncAlgoliaAfterPromote(
  c: Context<{ Bindings: Env }>,
  response: PromoteResponse,
  prisma: AlgoliaSyncPrisma,
): Promise<void> {
  const creds = { appId: c.env.ALGOLIA_APP_ID, apiKey: c.env.ALGOLIA_ADMIN_KEY };
  const env: AlgoliaEnv = c.env.ENV ?? 'development';
  try {
    const results = await syncPromoteTargets(prisma, fetch, creds, env, {
      product: response.product ? { id: response.product.id } : null,
      vendors: response.vendors.map((v) => ({ id: v.id })),
      integrations: response.integrations.map((i) => ({ id: i.id })),
    });
    for (const result of results) {
      submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.algolia.sync', 1, [
        'trigger:promote',
        `entity:${result.entity}`,
        `outcome:${result.ok ? 'ok' : 'failed'}`,
      ]);
      if (!result.ok) logAlgoliaSyncFailure(c, result.entity, result.error ?? 'unknown');
    }
  } catch (error) {
    logAlgoliaSyncFailure(c, 'all', error instanceof Error ? error.message : String(error));
  }
}

function logAlgoliaSyncFailure(
  c: Context<{ Bindings: Env }>,
  entity: string,
  reason: string,
): void {
  logToDatadog(c.executionCtx, c.env, c.req.raw, {
    level: 'warn',
    message: 'aeci.api.promote.algolia_sync_failed',
    source: 'review-app-promote',
    entity,
    reason,
  });
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export function createPromoteHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
    }

    const payload = PromotePayloadSchema.parse(raw);
    const prisma = prismaFor(c.env) as unknown as PromoteClient;
    const forward = makeForwarder(c);

    // Preload existing slugs once for collision-free generation (mirrors the
    // bulk-migrate script). Done outside the transaction to keep it short.
    const loadSlugs = async (m: Pick<ModelDelegate, 'findMany'>) =>
      new Set((await m.findMany({ select: { slug: true } })).map((r) => r.slug as string));
    const vendorSlugs = await loadSlugs(prisma.vendor);
    const productSlugs = await loadSlugs(prisma.product);

    const promoted = prisma.$transaction(
      async (tx) => {
        const audit = (entry: AuditLogEntry) =>
          appendAuditLog(tx, { ...entry, metadata: AUDIT_META }, forward);

        const vendorIdByRef = new Map<string, string>();
        const skipped: PromoteSkipped[] = [];

        // ── Vendors ──────────────────────────────────────────────────────────
        const vendorResults: PromoteEntityResult[] = [];
        let firstVendorSlug: string | undefined;
        for (const v of payload.vendors) {
          if (v.supabaseId) {
            const row = await tx.vendor.update({
              where: { id: v.supabaseId },
              data: {
                companyName: v.companyName,
                promotionStatus: 'promoted',
                ...vendorEditableData(v),
              },
            });
            vendorIdByRef.set(v.ref, row.id);
            vendorResults.push({
              ref: v.ref,
              id: row.id,
              slug: row.slug as string,
              operation: 'updated',
            });
            firstVendorSlug ??= row.slug as string;
            await audit({
              actorType: 'system',
              action: 'vendor.updated',
              entityType: 'vendor',
              entityId: row.id,
            });
          } else {
            const slug = generateSlug(v.companyName, vendorSlugs);
            const row = await tx.vendor.create({
              data: {
                slug,
                companyName: v.companyName,
                promotionStatus: 'promoted',
                ...vendorEditableData(v),
              },
            });
            vendorIdByRef.set(v.ref, row.id);
            vendorResults.push({ ref: v.ref, id: row.id, slug, operation: 'created' });
            firstVendorSlug ??= slug;
            await audit({
              actorType: 'system',
              action: 'vendor.created',
              entityType: 'vendor',
              entityId: row.id,
            });
          }
        }

        // ── Taxonomy (find-or-create by canonical slug) ──────────────────────
        const resolveTaxonomy = async (
          names: string[],
          model: ModelDelegate,
          entity: 'category' | 'audience' | 'phase',
        ): Promise<{ ids: string[]; results: PromoteTaxonomyResult[] }> => {
          const existing = await model.findMany({ select: { id: true, slug: true } });
          const bySlug = new Map(existing.map((r) => [r.slug as string, r.id]));
          const slugSet = new Set(bySlug.keys());
          const ids: string[] = [];
          const results: PromoteTaxonomyResult[] = [];
          const seen = new Set<string>();
          for (const name of names) {
            const canonical = slugify(name);
            const found = bySlug.get(canonical);
            if (found) {
              if (!seen.has(found)) {
                ids.push(found);
                results.push({ slug: canonical, id: found, operation: 'reused' });
                seen.add(found);
              }
              continue;
            }
            const slug = disambiguateSlug(canonical, [...slugSet]);
            slugSet.add(slug);
            const row = await model.create({ data: { slug, name } });
            bySlug.set(canonical, row.id);
            ids.push(row.id);
            results.push({ slug, id: row.id, operation: 'created' });
            seen.add(row.id);
            await audit({
              actorType: 'system',
              action: `${entity}.created`,
              entityType: entity,
              entityId: row.id,
            });
          }
          return { ids, results };
        };

        // Taxonomy is product-driven: a vendor-only / integration-only push (no
        // `product`) skips it entirely.
        const p = payload.product;
        const emptyTax = { ids: [] as string[], results: [] as PromoteTaxonomyResult[] };
        const categories = p
          ? await resolveTaxonomy(p.categories, tx.taxonomyCategory, 'category')
          : emptyTax;
        const audiences = p
          ? await resolveTaxonomy(p.audiences, tx.taxonomyAudience, 'audience')
          : emptyTax;
        const phases = p ? await resolveTaxonomy(p.phases, tx.taxonomyPhase, 'phase') : emptyTax;

        // ── Resolvers (used by extensions + integrations) ─────────────────────
        // `productId` is filled in by the product block below; resolvers read it
        // via closure, so they must be called after that block runs.
        let productResult: PromoteEntityResult | null = null;
        let productId: string | undefined;

        const productExists = async (id: string): Promise<boolean> =>
          (await tx.product.findUnique({ where: { id }, select: { id: true } })) !== null;

        const resolveProduct = async (ref: EntityRef): Promise<string | null> => {
          if (ref.ref) return p && ref.ref === p.ref ? (productId ?? null) : null;
          if (ref.supabaseId) return (await productExists(ref.supabaseId)) ? ref.supabaseId : null;
          return null;
        };

        // Resolves an integration's `builtByVendor` reference to a vendor id.
        const resolveVendor = async (ref: EntityRef): Promise<string | null> => {
          if (ref.ref) return vendorIdByRef.get(ref.ref) ?? null;
          if (ref.supabaseId) {
            const row = await tx.vendor.findUnique({
              where: { id: ref.supabaseId },
              select: { id: true },
            });
            return row ? ref.supabaseId : null;
          }
          return null;
        };

        // ── Product (+ join rows + extensions) ────────────────────────────────
        if (p) {
          if (p.supabaseId) {
            const row = await tx.product.update({
              where: { id: p.supabaseId },
              data: { name: p.name, promotionStatus: 'promoted', ...productEditableData(p) },
            });
            productResult = {
              ref: p.ref,
              id: row.id,
              slug: row.slug as string,
              operation: 'updated',
            };
            await audit({
              actorType: 'system',
              action: 'product.updated',
              entityType: 'product',
              entityId: row.id,
            });
          } else {
            const slug = generateSlug(p.name, productSlugs, firstVendorSlug);
            const row = await tx.product.create({
              data: { slug, name: p.name, promotionStatus: 'promoted', ...productEditableData(p) },
            });
            productResult = { ref: p.ref, id: row.id, slug, operation: 'created' };
            await audit({
              actorType: 'system',
              action: 'product.created',
              entityType: 'product',
              entityId: row.id,
            });
          }
          productId = productResult.id;

          // Replace join rows to reflect the pushed state exactly.
          await tx.productVendor.deleteMany({ where: { productId } });
          await tx.productCategory.deleteMany({ where: { productId } });
          await tx.productAudience.deleteMany({ where: { productId } });
          await tx.productPhase.deleteMany({ where: { productId } });
          await tx.productExtension.deleteMany({ where: { productId } });

          if (payload.vendors.length) {
            await tx.productVendor.createMany({
              data: payload.vendors.map((v, i) => ({
                productId,
                vendorId: vendorIdByRef.get(v.ref)!,
                isPrimary: v.isPrimary ?? i === 0,
              })),
              skipDuplicates: true,
            });
          }
          if (categories.ids.length) {
            await tx.productCategory.createMany({
              data: categories.ids.map((categoryId) => ({ productId, categoryId })),
              skipDuplicates: true,
            });
          }
          if (audiences.ids.length) {
            await tx.productAudience.createMany({
              data: audiences.ids.map((audienceId) => ({ productId, audienceId })),
              skipDuplicates: true,
            });
          }
          if (phases.ids.length) {
            await tx.productPhase.createMany({
              data: phases.ids.map((phaseId) => ({ productId, phaseId })),
              skipDuplicates: true,
            });
          }

          // Extensions: host products must already be promoted (by supabaseId).
          const hostIds: string[] = [];
          for (const host of p.extensionOf) {
            const hostId = await resolveProduct(host);
            if (!hostId || hostId === productId) {
              skipped.push({
                ref: p.ref,
                kind: 'extension',
                reason: `host product ${host.supabaseId ?? host.ref} not found or self-referential`,
              });
              continue;
            }
            hostIds.push(hostId);
          }
          if (hostIds.length) {
            await tx.productExtension.createMany({
              data: hostIds.map((hostProductId) => ({ productId, hostProductId })),
              skipDuplicates: true,
            });
            await audit({
              actorType: 'system',
              action: 'product.extension_created',
              entityType: 'product',
              entityId: productId,
            });
          }
        }

        // ── Integrations ──────────────────────────────────────────────────────
        // Integrations whose source/target can't both be resolved (the other
        // product isn't promoted yet) are reported in `skipped[]` rather than
        // failing the request — the product-driven "both endpoints promoted" rule
        // from AECI-83. `affectedProducts` accumulates every product whose
        // `integration_count` may have changed, recomputed once after the loop.
        const integrationResults: PromoteIntegrationResult[] = [];
        const affectedProducts = new Set<string>();
        if (productId) affectedProducts.add(productId);
        for (const intg of payload.integrations) {
          const sourceId = await resolveProduct(intg.sourceProduct);
          const targetId = await resolveProduct(intg.targetProduct);
          if (!sourceId || !targetId) {
            skipped.push({
              ref: intg.ref,
              kind: 'integration',
              reason: 'source or target product is not promoted yet',
            });
            continue;
          }
          if (sourceId === targetId) {
            skipped.push({
              ref: intg.ref,
              kind: 'integration',
              reason: 'source and target resolve to the same product (self-link not allowed)',
            });
            continue;
          }
          const builtByVendorId = intg.builtByVendor
            ? await resolveVendor(intg.builtByVendor)
            : null;
          const poweredByProductId = intg.poweredByProduct
            ? await resolveProduct(intg.poweredByProduct)
            : null;

          const linkData = {
            sourceProductId: sourceId,
            targetProductId: targetId,
            builtByVendorId,
            poweredByProductId,
          };

          if (intg.supabaseId) {
            // An update may MOVE an endpoint. Capture the pre-update source/target
            // so the OLD products are recomputed too — otherwise their stored
            // `integration_count` lags (the AECI-86 drift bug). The new endpoints
            // are added below; recompute is idempotent per id, so overlap is safe.
            const existing = await tx.integration.findUnique({
              where: { id: intg.supabaseId },
              select: { sourceProductId: true, targetProductId: true },
            });
            if (existing) {
              affectedProducts.add(existing.sourceProductId as string);
              affectedProducts.add(existing.targetProductId as string);
            }
            const row = await tx.integration.update({
              where: { id: intg.supabaseId },
              data: { ...integrationEditableData(intg), ...linkData },
            });
            integrationResults.push({ ref: intg.ref, id: row.id, operation: 'updated' });
            await audit({
              actorType: 'system',
              action: 'integration.updated',
              entityType: 'integration',
              entityId: row.id,
            });
          } else {
            const row = await tx.integration.create({
              data: { ...integrationEditableData(intg), ...linkData },
            });
            integrationResults.push({ ref: intg.ref, id: row.id, operation: 'created' });
            await audit({
              actorType: 'system',
              action: 'integration.created',
              entityType: 'integration',
              entityId: row.id,
            });
          }
          affectedProducts.add(sourceId);
          affectedProducts.add(targetId);
        }

        // ── Recompute denormalized counts for touched products (AECI-104) ─────
        // Maintains integration_count, review_count, and the rating averages from
        // source rows in the same transaction so they never lag.
        await recomputeProductCounts(tx, affectedProducts);

        const result: PromoteResponse = {
          vendors: vendorResults,
          product: productResult,
          integrations: integrationResults,
          taxonomy: {
            categories: categories.results,
            audiences: audiences.results,
            phases: phases.results,
          },
          skipped,
        };
        return result;
      },
      // Prisma Accelerate caps interactive-transaction `timeout` at 15_000ms
      // globally — anything higher is rejected at parameter validation (P6005)
      // before the transaction runs, surfacing as a BadRequestError. The cap is
      // only raisable via a Prisma support/plan request, not from code, so stay
      // at the max for the most headroom. Keep this bundle short (preload slugs
      // outside the tx; batch with createMany) to fit comfortably inside it.
      { maxWait: 10_000, timeout: 15_000 },
    );

    // AECI-98: a concurrent first-time promote can generate a duplicate slug; the
    // racing `tx.create` then trips a `*_slug_key` unique constraint (Prisma
    // P2002). Translate that to the documented 409 SLUG_CONFLICT (canonical
    // envelope, no Datadog alert) rather than a generic 500 — the caller can
    // safely retry, since `loadSlugs` re-reads per request and disambiguates.
    // Any other failure rethrows and still surfaces as 500.
    const response = await promoted.catch((err: unknown): never => {
      if (isSlugUniqueViolation(err)) {
        throw new ApiError(
          409,
          'SLUG_CONFLICT',
          'A concurrent promote generated a duplicate slug; retry the request.',
          { details: { target: (err as { meta?: { target?: unknown } }).meta?.target } },
        );
      }
      throw err;
    });

    // AECI-105: purge the edge-cache tags this promote invalidated. Best-effort
    // and post-commit — fired via `waitUntil` so it never blocks or fails the
    // response. No-ops when `CF_PURGE_API_TOKEN` / `CF_ZONE_ID` are unset.
    if (c.env.CF_PURGE_API_TOKEN && c.env.CF_ZONE_ID) {
      c.executionCtx.waitUntil(purgeAfterPromote(c, response));
    }

    // AECI-139: push the promoted records to Algolia immediately so they're
    // searchable now, not at the next 03:00 cron. Independent best-effort task
    // (separate `waitUntil`, so it never blocks the purge or the response).
    // No-ops when the Algolia secrets are unset (local / preview).
    if (c.env.ALGOLIA_APP_ID && c.env.ALGOLIA_ADMIN_KEY) {
      c.executionCtx.waitUntil(
        syncAlgoliaAfterPromote(c, response, prisma as unknown as AlgoliaSyncPrisma),
      );
    }

    return json(response);
  };
}

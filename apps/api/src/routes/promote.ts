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
 * affected `Cache-Tag`s via the web Worker's `POST /admin/purge` (over the
 * `WEB` service binding, `?source=promote`). Tags are derived in
 * `cacheTagsForPromote` to match what SSR emits (`docs/CACHE_STRATEGY.md` §2).
 * The purge is **best-effort and post-commit**: it runs via `ctx.waitUntil`
 * (never blocks or fails the already-committed promote) and a failure is logged
 * to Datadog — worst-case staleness reverts to the edge TTL (≤15 min), i.e. no
 * regression vs. before this change. When `WEB` / `ADMIN_PURGE_TOKEN` are unset
 * (e.g. local `pnpm dev:bound`) the purge is a graceful no-op.
 *
 * Two known, bounded staleness gaps remain out of scope (documented in
 * `docs/REVIEW_APP_PROMOTE_API.md`): embedded reverse-tagging is Phase 4, and
 * integration tags wait on AECI-86 re-enabling integration seeding below.
 */

import {
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
import { appendAuditLog, type AuditLogEntry, type AuditLogForwarder } from '@aeci/shared/audit-log';
import { disambiguateSlug, SlugReservedError, slugify } from '@aeci/shared/slug';
import type { Context } from 'hono';

import { logToDatadog } from '../datadog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import type { PrismaFactory } from '../lib/handler-utils';
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
  productDiscipline: ModelDelegate;
  productPhase: ModelDelegate;
  productExtension: ModelDelegate;
  taxonomyCategory: ModelDelegate;
  taxonomyDiscipline: ModelDelegate;
  taxonomyPhase: ModelDelegate;
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

// Used by the integration seeding block that is temporarily disabled under
// AECI-86; kept here so re-enabling that block is a pure uncomment.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
// `POST /admin/purge` (web Worker) accepts ≤30 tags per call (mirrors
// `PurgeRequestSchema.max(30)`); a promote rarely touches that many, so chunking
// is defensive. The host in the URL is irrelevant for a service-binding fetch —
// the web Worker routes on the path — so we use an internal sentinel host.
const PURGE_TAG_BATCH = 30;
const PURGE_URL = 'https://internal/admin/purge?source=promote';

/**
 * Best-effort, post-commit edge-cache purge for a promote. No-ops when the `WEB`
 * binding or `ADMIN_PURGE_TOKEN` is absent, or when nothing cacheable changed.
 * Batches are fired concurrently; a failed batch is logged (Datadog `warn`) and
 * swallowed so it never affects the already-committed promote. The web Worker
 * records each call's outcome as `aeci.cache.purge{source:promote,outcome:*}` —
 * the API-side log here covers only the case where the call never reaches it.
 */
async function purgeAfterPromote(
  c: Context<{ Bindings: Env }>,
  response: PromoteResponse,
): Promise<void> {
  const web = c.env.WEB;
  const token = c.env.ADMIN_PURGE_TOKEN;
  if (!web || !token) return;

  const tags = cacheTagsForPromote(response);
  if (tags.length === 0) return;

  const batches: string[][] = [];
  for (let i = 0; i < tags.length; i += PURGE_TAG_BATCH) {
    batches.push(tags.slice(i, i + PURGE_TAG_BATCH));
  }

  await Promise.allSettled(
    batches.map(async (batch) => {
      try {
        const res = await web.fetch(PURGE_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ tags: batch }),
        });
        if (!res.ok) logPurgeFailure(c, batch, `admin/purge responded ${res.status}`);
      } catch (err) {
        logPurgeFailure(c, batch, err instanceof Error ? err.message : String(err));
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

    const response = await prisma.$transaction(
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
          entity: 'category' | 'discipline' | 'phase',
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
        const disciplines = p
          ? await resolveTaxonomy(p.disciplines, tx.taxonomyDiscipline, 'discipline')
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

        // Used by the integration seeding block that is temporarily disabled
        // under AECI-86; kept so re-enabling that block is a pure uncomment.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
          await tx.productDiscipline.deleteMany({ where: { productId } });
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
          if (disciplines.ids.length) {
            await tx.productDiscipline.createMany({
              data: disciplines.ids.map((disciplineId) => ({ productId, disciplineId })),
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
        const integrationResults: PromoteIntegrationResult[] = [];
        // TODO(AECI-86): Integration seeding temporarily disabled while we validate
        // the vendor/product promote flow on staging. Re-enable (and uncomment the
        // block below) once the site looks correct without integration data.
        //
        // PM DECISION: skipping integrations on this endpoint right now is a
        // deliberate product call (per PM direction) — not an oversight or a bug.
        // Integrations are intentionally NOT promoted via POST /api/promote for the
        // moment; the AECI-83 bulk-migrate script remains the integration migration
        // path in the interim. Re-enable under AECI-86 when product gives the go.
        // https://linear.app/aec-integrations/issue/AECI-86
        /*
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
        // When AECI-86 re-enables this block, also add `review: ModelDelegate`
        // to PromoteTx and import recomputeProductCounts from '../lib/product-counts'
        // so this resolves: it maintains integration_count, review_count, and the
        // rating averages from source rows in the same transaction.
        await recomputeProductCounts(tx, affectedProducts);
        */

        const result: PromoteResponse = {
          vendors: vendorResults,
          product: productResult,
          integrations: integrationResults,
          taxonomy: {
            categories: categories.results,
            disciplines: disciplines.results,
            phases: phases.results,
          },
          skipped,
        };
        return result;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );

    // AECI-105: purge the edge-cache tags this promote invalidated. Best-effort
    // and post-commit — fired via `waitUntil` so it never blocks or fails the
    // response. No-ops when `WEB` / `ADMIN_PURGE_TOKEN` are unset.
    if (c.env.WEB && c.env.ADMIN_PURGE_TOKEN) {
      c.executionCtx.waitUntil(purgeAfterPromote(c, response));
    }

    return json(response);
  };
}

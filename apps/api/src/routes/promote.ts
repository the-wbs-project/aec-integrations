/**
 * `POST /api/promote` — push-based Airtable → app-DB promotion — Drizzle/D1
 * (ADR 0016 / AECI-253, AECI-249).
 *
 * The review application sends one product plus its dependencies; this handler
 * upserts the whole bundle and returns the resulting IDs (see `@aeci/shared`
 * `PromotePayloadSchema` / `PromoteResponse` for the contract and idempotency
 * model).
 *
 * D1 has no interactive transactions, so the handler is **plan-then-batch**:
 *   1. **Plan (reads + id generation, NO writes).** Preload slugs; read the
 *      slugs of any rows being updated; resolve taxonomy (find-or-create) and
 *      usefulness against existing+to-be-created terms; resolve every
 *      integration/extension endpoint (refs → planned ids, supabaseIds →
 *      existence reads); read an updated integration's OLD endpoints for the
 *      recompute. All new ids are app-generated `crypto.randomUUID()` up front,
 *      so nothing depends on a write's return value.
 *   2. **One atomic `db.batch`** of vendor/product/integration upserts +
 *      join-table delete/recreate + extension inserts + an `audit_log` row per
 *      create/update (Stage 1 Spec §26.1 — every state change logs, atomically).
 *      Statements are ordered to satisfy FKs statement-by-statement (vendors →
 *      taxonomy → product → joins → integrations → audits).
 *   3. **Post-batch recompute** of the denormalized counts for the touched
 *      products (`lib/recompute-counts.ts`; the brief lag is the drift sweep's
 *      backstop), then the best-effort §26.5 audit forwards, edge-cache purge,
 *      and Algolia upsert via `ctx.waitUntil`.
 *
 *   - **Upsert by caller-supplied `supabaseId`.** Present → update; absent →
 *     create. The review app holds the IDs (no `external_id` column exists).
 *   - **Slugs are server-owned.** Generated on create via `@aeci/shared/slug`;
 *     kept stable on update.
 *   - **Joins are replaced, not merged.** On update, the product's
 *     vendor/taxonomy/extension join rows are deleted and re-inserted.
 *   - **Endpoint resolution.** Integrations whose source/target can't be
 *     resolved (the other product isn't promoted yet) are reported in `skipped[]`
 *     rather than failing the request (the product-driven "both endpoints
 *     promoted" rule, AECI-83).
 *
 * Cache purge (AECI-105) is best-effort + post-commit (`ctx.waitUntil` →
 * `callCloudflarePurge` directly, ADR 0010); no-op without
 * `CF_PURGE_API_TOKEN`/`CF_ZONE_ID`. Algolia sync (AECI-139) is an injectable
 * post-commit seam over the Drizzle `algolia-sync` core, no-op without the
 * Algolia secrets.
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
  type PromoteUsefulnessGroup,
  type UsefulnessGroup,
} from '@aeci/shared';
import { type AlgoliaEnv } from '@aeci/shared/algolia';
import {
  forwardAuditLog,
  type AuditLogEntry,
  type AuditLogForwarder,
} from '@aeci/shared/audit-log';
import { disambiguateSlug, SlugReservedError, slugify } from '@aeci/shared/slug';
import { eq, inArray, type Table } from 'drizzle-orm';
import { type SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import {
  integrations,
  productAudiences,
  productCategories,
  productExtensions,
  productPhases,
  products,
  productVendors,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
  vendors,
} from '../db/schema';
import { logToDatadog, submitCount, submitDistribution } from '../datadog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import { syncPromoteTargets } from '../lib/algolia-sync';
import { emitAlgoliaSyncMetrics, type SyncMetricSink } from '../lib/algolia-sync-metrics';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { callGoogleIndexing } from '../lib/google-indexing';
import type { DbFactory } from '../lib/handler-utils';
import { callIndexNow } from '../lib/indexnow';
import { recomputeProductCounts } from '../lib/recompute-counts';
import { cacheTagsForPromote } from './promote-cache-tags';
import { affectedUrlsForPromote } from './promote-indexnow-urls';

// ─── Helpers ─────────────────────────────────────────────────────────────────
/** Drop keys whose value is `undefined` so the column is left untouched. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Slugify for matching, never throwing. Usefulness resolution looks an input
 * `slug`/`name` up against existing terms; an input that maps to a reserved or
 * empty slug simply can't match anything, so we return `null` (→ unresolvable →
 * `skipped`) rather than 500-ing the whole promote the way the facet path's bare
 * `slugify` would.
 */
function safeSlugify(value: string): string | null {
  try {
    return slugify(value);
  } catch {
    return null;
  }
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
 * True when `err` is a SQLite/D1 UNIQUE-constraint violation on a `slug` column.
 * Slugs are preloaded *before* the batch (`loadSlugs`), so two concurrent
 * first-time promotes can both generate the same slug and the second insert then
 * trips `vendors_slug_key` / `products_slug_key`. That is a caller-resolvable
 * conflict, not a server fault — the handler translates it to a documented
 * `409 SLUG_CONFLICT` (AECI-98) instead of a generic 500.
 *
 * Duck-typed across the D1 and better-sqlite3 error shapes (message + code), like
 * `routes/reviews.ts`'s duplicate check. SQLite reports `UNIQUE constraint
 * failed: products.slug`; a non-slug UNIQUE violation returns false and falls
 * through to the generic 500 so unrelated violations are never mislabeled.
 */
function isSlugUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { message?: unknown; code?: unknown };
  const msg =
    `${typeof e.message === 'string' ? e.message : ''} ${String(e.code ?? '')}`.toLowerCase();
  return msg.includes('unique') && msg.includes('slug');
}

/** Columns named in a `UNIQUE constraint failed: <table>.<col>, …` message →
 *  `['slug']` etc. (the `details.target` for the 409 envelope). */
function slugConflictTarget(err: unknown): string[] {
  const msg = String((err as { message?: unknown })?.message ?? '');
  const m = msg.match(/unique constraint failed:\s*(.+)/i);
  if (!m) return ['slug'];
  return m[1]!
    .split(',')
    .map((s) => s.trim().split('.').pop() ?? s.trim())
    .filter(Boolean);
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
    xUrl: v.xUrl,
    facebookUrl: v.facebookUrl,
    instagramUrl: v.instagramUrl,
    youtubeUrl: v.youtubeUrl,
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

// Field projection for the integration upsert.
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

/**
 * Best-effort, post-commit edge-cache purge for a promote. No-ops when
 * `CF_PURGE_API_TOKEN` / `CF_ZONE_ID` is absent, or when nothing cacheable
 * changed. Batches are fired concurrently; each batch's outcome is recorded as
 * `aeci.cache.purge{source:promote,outcome:ok|cf_failed}` and a failed batch is
 * logged (Datadog `warn`) and swallowed so it never affects the committed promote.
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

/**
 * Post-commit Algolia upsert seam. Default re-queries the touched rows by id and
 * pushes them to the env's indexes via the Drizzle `algolia-sync` core, gated on
 * the Algolia secrets. Injected for tests. Never throws.
 */
export type PromoteAlgoliaSync = (
  c: Context<{ Bindings: Env }>,
  response: PromoteResponse,
) => Promise<void>;

const defaultAlgoliaSync: PromoteAlgoliaSync = (c, response) =>
  syncAlgoliaAfterPromote(c, response, getDb(c.env).db);

async function syncAlgoliaAfterPromote(
  c: Context<{ Bindings: Env }>,
  response: PromoteResponse,
  db: Db,
): Promise<void> {
  const creds = { appId: c.env.ALGOLIA_APP_ID, apiKey: c.env.ALGOLIA_ADMIN_KEY };
  const env: AlgoliaEnv = c.env.ENV ?? 'development';
  const started = Date.now();
  try {
    const results = await syncPromoteTargets(db, fetch, creds, env, {
      product: response.product ? { id: response.product.id } : null,
      vendors: response.vendors.map((v) => ({ id: v.id })),
      integrations: response.integrations.map((i) => ({ id: i.id })),
    });
    const sink: SyncMetricSink = {
      count: (metric, value, tags) =>
        submitCount(c.executionCtx, c.env, c.req.raw, metric, value, tags),
      distribution: (metric, value, tags) =>
        submitDistribution(c.executionCtx, c.env, c.req.raw, metric, value, tags),
    };
    emitAlgoliaSyncMetrics(sink, 'promote', results, Date.now() - started);
    for (const result of results) {
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

// ─── IndexNow notification (AECI-236) ────────────────────────────────────────

/**
 * Post-commit IndexNow submission seam. Default builds the affected public URLs
 * from the promote response (`affectedUrlsForPromote`) and submits them to
 * IndexNow (Bing/Yandex/…) via `callIndexNow`, gated on `INDEXNOW_KEY` +
 * `PUBLIC_SITE_URL`. Records `aeci.indexnow.submit{source:promote,outcome:ok|failed}`
 * and warn-logs a failure (Datadog) — never throws, never blocks the committed
 * promote (§20.2 / §20.5). Injected for tests (mirrors the Algolia seam).
 */
export type PromoteIndexNowNotify = (
  c: Context<{ Bindings: Env }>,
  response: PromoteResponse,
) => Promise<void>;

const defaultIndexNowNotify: PromoteIndexNowNotify = (c, response) =>
  notifyIndexNowAfterPromote(c, response);

async function notifyIndexNowAfterPromote(
  c: Context<{ Bindings: Env }>,
  response: PromoteResponse,
): Promise<void> {
  const key = c.env.INDEXNOW_KEY;
  const siteUrl = c.env.PUBLIC_SITE_URL;
  if (!key || !siteUrl) return;

  const urlList = affectedUrlsForPromote(response, siteUrl);
  if (urlList.length === 0) return;

  let host: string;
  let keyLocation: string;
  try {
    host = new URL(siteUrl).host;
    keyLocation = `${siteUrl.replace(/\/+$/, '')}/${key}.txt`;
  } catch {
    // PUBLIC_SITE_URL isn't a valid URL — misconfiguration; skip rather than throw.
    logIndexNowFailure(c, urlList.length, 'invalid_public_site_url');
    return;
  }

  const outcome = await callIndexNow(fetch, { host, key, keyLocation, urlList });
  submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.indexnow.submit', 1, [
    'source:promote',
    `outcome:${outcome.ok ? 'ok' : 'failed'}`,
  ]);
  if (!outcome.ok) {
    logIndexNowFailure(c, urlList.length, `indexnow_${outcome.status}: ${outcome.message}`);
  }
}

function logIndexNowFailure(
  c: Context<{ Bindings: Env }>,
  urlsCount: number,
  reason: string,
): void {
  logToDatadog(c.executionCtx, c.env, c.req.raw, {
    level: 'warn',
    message: 'aeci.api.promote.indexnow_failed',
    source: 'review-app-promote',
    reason,
    urls_count: urlsCount,
  });
}

// ─── Google Indexing API ping (AECI-263) ─────────────────────────────────────

/**
 * Post-commit Google Indexing API submission seam. Default builds the SAME
 * affected public URLs as IndexNow (`affectedUrlsForPromote` — no second deriver,
 * §20.2 acceptance criterion) and pings Google's Indexing API via
 * `callGoogleIndexing`, gated on the service-account creds + `PUBLIC_SITE_URL`.
 * Records `aeci.google_indexing.submit{source:promote,outcome:ok|failed}` and
 * warn-logs a token failure or a partial publish (Datadog) — never throws, never
 * blocks the committed promote (§20.2 / §20.5). Best-effort: Google officially
 * supports only `JobPosting`/`BroadcastEvent`, so this is an additive signal on
 * top of the sitemap `<lastmod>` (§20.5 step 5). Injected for tests.
 */
export type PromoteGoogleIndexingNotify = (
  c: Context<{ Bindings: Env }>,
  response: PromoteResponse,
) => Promise<void>;

const defaultGoogleIndexingNotify: PromoteGoogleIndexingNotify = (c, response) =>
  notifyGoogleIndexingAfterPromote(c, response);

async function notifyGoogleIndexingAfterPromote(
  c: Context<{ Bindings: Env }>,
  response: PromoteResponse,
): Promise<void> {
  const clientEmail = c.env.GOOGLE_INDEXING_SA_EMAIL;
  const privateKey = c.env.GOOGLE_INDEXING_SA_PRIVATE_KEY;
  const siteUrl = c.env.PUBLIC_SITE_URL;
  if (!clientEmail || !privateKey || !siteUrl) return;

  const urlList = affectedUrlsForPromote(response, siteUrl);
  if (urlList.length === 0) return;

  const outcome = await callGoogleIndexing(fetch, {
    serviceAccount: { clientEmail, privateKey },
    urlList,
  });
  const failed = !outcome.ok || outcome.failed > 0;
  submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.google_indexing.submit', 1, [
    'source:promote',
    `outcome:${failed ? 'failed' : 'ok'}`,
  ]);
  if (!outcome.ok) {
    logGoogleIndexingFailure(
      c,
      urlList.length,
      `google_indexing_${outcome.status}: ${outcome.message}`,
    );
  } else if (outcome.failed > 0) {
    logGoogleIndexingFailure(
      c,
      urlList.length,
      `google_indexing_partial: ${outcome.failed} of ${urlList.length} failed`,
    );
  }
}

function logGoogleIndexingFailure(
  c: Context<{ Bindings: Env }>,
  urlsCount: number,
  reason: string,
): void {
  logToDatadog(c.executionCtx, c.env, c.req.raw, {
    level: 'warn',
    message: 'aeci.api.promote.google_indexing_failed',
    source: 'review-app-promote',
    reason,
    urls_count: urlsCount,
  });
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/** A taxonomy facet model (table + the columns the find-or-create reads). The
 *  generic `Table` type doesn't expose columns, so they're passed explicitly. */
interface TaxonomyTable {
  table: Table;
  idCol: SQLiteColumn;
  slugCol: SQLiteColumn;
  nameCol: SQLiteColumn;
}

export function createPromoteHandler(
  dbFor: DbFactory = getDb,
  syncAlgolia: PromoteAlgoliaSync = defaultAlgoliaSync,
  notifyIndexNow: PromoteIndexNowNotify = defaultIndexNowNotify,
  notifyGoogleIndexing: PromoteGoogleIndexingNotify = defaultGoogleIndexingNotify,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
    }

    const payload = PromotePayloadSchema.parse(raw);
    const { db } = dbFor(c.env);

    // ── PLAN: reads + id generation. Writes are accumulated, not executed. ──
    const stmts: BatchStmt[] = [];
    const auditEntries: AuditLogEntry[] = [];
    const audit = (entry: AuditLogEntry) => auditEntries.push({ ...entry, metadata: AUDIT_META });
    const skipped: PromoteSkipped[] = [];

    // Preload existing slugs for collision-free generation (outside the batch).
    const loadSlugs = async (col: SQLiteColumn) =>
      new Set(
        (await db.select({ slug: col }).from(col.table as Table)).map((r) => r.slug as string),
      );
    const vendorSlugs = await loadSlugs(vendors.slug);
    const productSlugs = await loadSlugs(products.slug);

    // Read the current slugs of vendors being updated (for `firstVendorSlug` + the
    // response `slug`, which the update doesn't return).
    const updatedVendorIds = payload.vendors
      .map((v) => v.supabaseId)
      .filter((id): id is string => Boolean(id));
    const vendorSlugById = new Map<string, string>();
    if (updatedVendorIds.length) {
      const rows = await db.query.vendors.findMany({
        columns: { id: true, slug: true },
        where: inArray(vendors.id, updatedVendorIds),
      });
      for (const r of rows) vendorSlugById.set(r.id, r.slug);
    }

    // ── Vendors ──────────────────────────────────────────────────────────────
    const vendorIdByRef = new Map<string, string>();
    const vendorResults: PromoteEntityResult[] = [];
    let firstVendorSlug: string | undefined;
    for (const v of payload.vendors) {
      if (v.supabaseId) {
        const slug = vendorSlugById.get(v.supabaseId) ?? '';
        stmts.push(
          db
            .update(vendors)
            .set({
              companyName: v.companyName,
              promotionStatus: 'promoted',
              ...vendorEditableData(v),
            })
            .where(eq(vendors.id, v.supabaseId)),
        );
        vendorIdByRef.set(v.ref, v.supabaseId);
        vendorResults.push({ ref: v.ref, id: v.supabaseId, slug, operation: 'updated' });
        firstVendorSlug ??= slug;
        audit({
          actorType: 'system',
          action: 'vendor.updated',
          entityType: 'vendor',
          entityId: v.supabaseId,
        });
      } else {
        const slug = generateSlug(v.companyName, vendorSlugs);
        const id = crypto.randomUUID();
        stmts.push(
          db.insert(vendors).values({
            id,
            slug,
            companyName: v.companyName,
            promotionStatus: 'promoted',
            ...vendorEditableData(v),
          }),
        );
        vendorIdByRef.set(v.ref, id);
        vendorResults.push({ ref: v.ref, id, slug, operation: 'created' });
        firstVendorSlug ??= slug;
        audit({
          actorType: 'system',
          action: 'vendor.created',
          entityType: 'vendor',
          entityId: id,
        });
      }
    }

    // ── Taxonomy (find-or-create by canonical slug) ───────────────────────────
    // Each facet returns the resolved ids + the public results, AND records a
    // `{slug → {slug,name}}` map (existing + just-created) for usefulness to
    // resolve against. New-term inserts are appended to the batch.
    const resolveTaxonomy = async (
      names: string[],
      model: TaxonomyTable,
      entity: 'category' | 'audience' | 'phase',
    ): Promise<{
      ids: string[];
      results: PromoteTaxonomyResult[];
      termBySlug: Map<string, { slug: string; name: string }>;
    }> => {
      const existing = (await db
        .select({ id: model.idCol, slug: model.slugCol, name: model.nameCol })
        .from(model.table)) as Array<{ id: string; slug: string; name: string }>;
      const bySlug = new Map(existing.map((r) => [r.slug, r.id]));
      const termBySlug = new Map(existing.map((r) => [r.slug, { slug: r.slug, name: r.name }]));
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
        const id = crypto.randomUUID();
        stmts.push(db.insert(model.table).values({ id, slug, name } as Record<string, unknown>));
        bySlug.set(canonical, id);
        termBySlug.set(slug, { slug, name });
        ids.push(id);
        results.push({ slug, id, operation: 'created' });
        seen.add(id);
        audit({
          actorType: 'system',
          action: `${entity}.created`,
          entityType: entity,
          entityId: id,
        });
      }
      return { ids, results, termBySlug };
    };

    const p = payload.product;
    const emptyTax = {
      ids: [] as string[],
      results: [] as PromoteTaxonomyResult[],
      termBySlug: new Map<string, { slug: string; name: string }>(),
    };
    const categories = p
      ? await resolveTaxonomy(
          p.categories,
          {
            table: taxonomyCategories,
            idCol: taxonomyCategories.id,
            slugCol: taxonomyCategories.slug,
            nameCol: taxonomyCategories.name,
          },
          'category',
        )
      : emptyTax;
    const audiences = p
      ? await resolveTaxonomy(
          p.audiences,
          {
            table: taxonomyAudiences,
            idCol: taxonomyAudiences.id,
            slugCol: taxonomyAudiences.slug,
            nameCol: taxonomyAudiences.name,
          },
          'audience',
        )
      : emptyTax;
    const phases = p
      ? await resolveTaxonomy(
          p.phases,
          {
            table: taxonomyPhases,
            idCol: taxonomyPhases.id,
            slugCol: taxonomyPhases.slug,
            nameCol: taxonomyPhases.name,
          },
          'phase',
        )
      : emptyTax;

    // ── Usefulness (find-only resolution against existing+new terms) ───────────
    const resolveUsefulnessFacet = (
      groups: PromoteUsefulnessGroup[],
      termBySlug: Map<string, { slug: string; name: string }>,
      productRef: string,
    ): UsefulnessGroup[] => {
      const resolveOne = (value?: string) => {
        if (!value) return undefined;
        const key = safeSlugify(value);
        return key ? termBySlug.get(key) : undefined;
      };
      const merged = new Map<string, UsefulnessGroup>();
      for (const g of groups) {
        const term = resolveOne(g.slug) ?? resolveOne(g.name);
        if (!term) {
          skipped.push({
            ref: productRef,
            kind: 'usefulness',
            reason: `usefulness group "${g.slug ?? g.name}" did not resolve to an existing term`,
          });
          continue;
        }
        const existing = merged.get(term.slug);
        if (existing) existing.points.push(...g.points);
        else merged.set(term.slug, { slug: term.slug, name: term.name, points: [...g.points] });
      }
      return [...merged.values()];
    };

    // `undefined` → column untouched (omitted from the write); `null` → cleared to
    // SQL NULL (the `Prisma.DbNull` footgun is gone under Drizzle json mode);
    // object → the resolved value.
    let usefulnessData:
      | { audiences: UsefulnessGroup[]; phases: UsefulnessGroup[] }
      | null
      | undefined;
    if (p) {
      if (p.usefulness === null) {
        usefulnessData = null;
      } else if (p.usefulness) {
        usefulnessData = {
          audiences: resolveUsefulnessFacet(p.usefulness.audiences, audiences.termBySlug, p.ref),
          phases: resolveUsefulnessFacet(p.usefulness.phases, phases.termBySlug, p.ref),
        };
      }
    }

    // ── Resolvers (used by extensions + integrations) ─────────────────────────
    let productResult: PromoteEntityResult | null = null;
    let productId: string | undefined;

    const productExists = async (id: string): Promise<boolean> =>
      (await db.query.products.findFirst({ columns: { id: true }, where: eq(products.id, id) })) !==
      undefined;

    const resolveProduct = async (ref: EntityRef): Promise<string | null> => {
      if (ref.ref) return p && ref.ref === p.ref ? (productId ?? null) : null;
      if (ref.supabaseId) return (await productExists(ref.supabaseId)) ? ref.supabaseId : null;
      return null;
    };

    const resolveVendor = async (ref: EntityRef): Promise<string | null> => {
      if (ref.ref) return vendorIdByRef.get(ref.ref) ?? null;
      if (ref.supabaseId) {
        const row = await db.query.vendors.findFirst({
          columns: { id: true },
          where: eq(vendors.id, ref.supabaseId),
        });
        return row ? ref.supabaseId : null;
      }
      return null;
    };

    // ── Product (+ join rows + extensions) ────────────────────────────────────
    if (p) {
      if (p.supabaseId) {
        const existing = await db.query.products.findFirst({
          columns: { slug: true },
          where: eq(products.id, p.supabaseId),
        });
        const slug = existing?.slug ?? '';
        productId = p.supabaseId;
        productResult = { ref: p.ref, id: p.supabaseId, slug, operation: 'updated' };
        stmts.push(
          db
            .update(products)
            .set(
              compact({
                name: p.name,
                promotionStatus: 'promoted',
                usefulness: usefulnessData,
                ...productEditableData(p),
              }),
            )
            .where(eq(products.id, p.supabaseId)),
        );
        audit({
          actorType: 'system',
          action: 'product.updated',
          entityType: 'product',
          entityId: p.supabaseId,
        });
      } else {
        const slug = generateSlug(p.name, productSlugs, firstVendorSlug);
        const id = crypto.randomUUID();
        productId = id;
        productResult = { ref: p.ref, id, slug, operation: 'created' };
        stmts.push(
          db.insert(products).values({
            id,
            slug,
            name: p.name,
            promotionStatus: 'promoted',
            ...(usefulnessData === undefined ? {} : { usefulness: usefulnessData }),
            ...productEditableData(p),
          }),
        );
        audit({
          actorType: 'system',
          action: 'product.created',
          entityType: 'product',
          entityId: id,
        });
      }

      // Replace join rows to reflect the pushed state exactly. Deletes are no-ops
      // for a fresh product; on update they clear the prior joins.
      const pid = productId;
      stmts.push(db.delete(productVendors).where(eq(productVendors.productId, pid)));
      stmts.push(db.delete(productCategories).where(eq(productCategories.productId, pid)));
      stmts.push(db.delete(productAudiences).where(eq(productAudiences.productId, pid)));
      stmts.push(db.delete(productPhases).where(eq(productPhases.productId, pid)));
      stmts.push(db.delete(productExtensions).where(eq(productExtensions.productId, pid)));

      if (payload.vendors.length) {
        stmts.push(
          db
            .insert(productVendors)
            .values(
              payload.vendors.map((v, i) => ({
                productId: pid,
                vendorId: vendorIdByRef.get(v.ref)!,
                isPrimary: v.isPrimary ?? i === 0,
              })),
            )
            .onConflictDoNothing(),
        );
      }
      if (categories.ids.length) {
        stmts.push(
          db
            .insert(productCategories)
            .values(categories.ids.map((categoryId) => ({ productId: pid, categoryId })))
            .onConflictDoNothing(),
        );
      }
      if (audiences.ids.length) {
        stmts.push(
          db
            .insert(productAudiences)
            .values(audiences.ids.map((audienceId) => ({ productId: pid, audienceId })))
            .onConflictDoNothing(),
        );
      }
      if (phases.ids.length) {
        stmts.push(
          db
            .insert(productPhases)
            .values(phases.ids.map((phaseId) => ({ productId: pid, phaseId })))
            .onConflictDoNothing(),
        );
      }

      // Extensions: host products must already be promoted (by supabaseId).
      const hostIds: string[] = [];
      for (const host of p.extensionOf) {
        const hostId = await resolveProduct(host);
        if (!hostId || hostId === pid) {
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
        stmts.push(
          db
            .insert(productExtensions)
            .values(hostIds.map((hostProductId) => ({ productId: pid, hostProductId })))
            .onConflictDoNothing(),
        );
        audit({
          actorType: 'system',
          action: 'product.extension_created',
          entityType: 'product',
          entityId: pid,
        });
      }
    }

    // ── Integrations ──────────────────────────────────────────────────────────
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
      const builtByVendorId = intg.builtByVendor ? await resolveVendor(intg.builtByVendor) : null;
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
        // An update may MOVE an endpoint. Capture the pre-update source/target so
        // the OLD products are recomputed too (the AECI-86 drift fix); the new
        // endpoints are added below. Read pre-batch.
        const existing = await db.query.integrations.findFirst({
          columns: { sourceProductId: true, targetProductId: true },
          where: eq(integrations.id, intg.supabaseId),
        });
        if (existing) {
          affectedProducts.add(existing.sourceProductId);
          affectedProducts.add(existing.targetProductId);
        }
        stmts.push(
          db
            .update(integrations)
            .set({ ...integrationEditableData(intg), ...linkData })
            .where(eq(integrations.id, intg.supabaseId)),
        );
        integrationResults.push({ ref: intg.ref, id: intg.supabaseId, operation: 'updated' });
        audit({
          actorType: 'system',
          action: 'integration.updated',
          entityType: 'integration',
          entityId: intg.supabaseId,
        });
      } else {
        const id = crypto.randomUUID();
        stmts.push(
          db.insert(integrations).values({ id, ...integrationEditableData(intg), ...linkData }),
        );
        integrationResults.push({ ref: intg.ref, id, operation: 'created' });
        audit({
          actorType: 'system',
          action: 'integration.created',
          entityType: 'integration',
          entityId: id,
        });
      }
      affectedProducts.add(sourceId);
      affectedProducts.add(targetId);
    }

    // ── Audit rows (appended last; same atomic batch as the writes above) ─────
    for (const entry of auditEntries) stmts.push(auditInsert(db, entry));

    const response: PromoteResponse = {
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

    // ── BATCH: one atomic unit (§26.1). A racing duplicate slug trips a UNIQUE
    //    violation → 409 SLUG_CONFLICT (AECI-98); any other failure rethrows → 500.
    if (stmts.length) {
      try {
        await db.batch(stmts as BatchTuple);
      } catch (err) {
        if (isSlugUniqueViolation(err)) {
          throw new ApiError(
            409,
            'SLUG_CONFLICT',
            'A concurrent promote generated a duplicate slug; retry the request.',
            { details: { target: slugConflictTarget(err) } },
          );
        }
        throw err;
      }
    }

    // ── Post-batch: recompute the denormalized counts for touched products
    //    (AECI-104; the brief lag is the drift sweep's backstop). Separate
    //    read+write under D1 (no interactive tx).
    if (affectedProducts.size) await recomputeProductCounts(db, affectedProducts);

    // Best-effort §26.5 audit forwards AFTER the commit. Only scheduled when
    // Datadog is configured — the forwarder is a no-op otherwise, so there is
    // nothing to await.
    const forward = makeForwarder(c);
    if (forward && auditEntries.length) {
      c.executionCtx.waitUntil(
        Promise.all(auditEntries.map((entry) => forwardAuditLog(entry, forward))),
      );
    }

    // AECI-105: purge the edge-cache tags this promote invalidated. Best-effort,
    // post-commit; no-ops without CF creds.
    if (c.env.CF_PURGE_API_TOKEN && c.env.CF_ZONE_ID) {
      c.executionCtx.waitUntil(purgeAfterPromote(c, response));
    }

    // AECI-139: push the promoted records to Algolia immediately (independent
    // best-effort task). No-ops without the Algolia secrets.
    if (c.env.ALGOLIA_APP_ID && c.env.ALGOLIA_ADMIN_KEY) {
      c.executionCtx.waitUntil(syncAlgolia(c, response));
    }

    // AECI-236: notify IndexNow of the affected public URLs so Bing/Yandex/…
    // re-crawl quickly (§20.2/§20.5). Best-effort, post-commit; no-ops without
    // INDEXNOW_KEY + PUBLIC_SITE_URL. Those are provisioned ONLY at launch
    // (alongside `ALLOW_INDEXING=true`): pinging IndexNow for a noindex'd site is
    // a correctness bug, so the secret's absence is the gate.
    if (c.env.INDEXNOW_KEY && c.env.PUBLIC_SITE_URL) {
      c.executionCtx.waitUntil(notifyIndexNow(c, response));
    }

    // AECI-263: best-effort Google Indexing API ping for the SAME affected URLs
    // (§20.2). Additive to IndexNow; no-ops without the service-account creds +
    // PUBLIC_SITE_URL, which are provisioned ONLY at launch (alongside
    // `ALLOW_INDEXING=true`) — pinging Google for a noindex'd site is the same
    // correctness bug the secret's absence guards against. Never blocks the write.
    if (
      c.env.GOOGLE_INDEXING_SA_EMAIL &&
      c.env.GOOGLE_INDEXING_SA_PRIVATE_KEY &&
      c.env.PUBLIC_SITE_URL
    ) {
      c.executionCtx.waitUntil(notifyGoogleIndexing(c, response));
    }

    return json(response);
  };
}

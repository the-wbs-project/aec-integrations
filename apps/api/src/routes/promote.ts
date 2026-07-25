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
 * Cache purge (AECI-105 → WC-5 / AECI-319) is best-effort + post-commit
 * (`ctx.waitUntil` → enqueue onto `CACHE_PURGE_QUEUE`; the SSR Worker's queue
 * consumer issues the `ctx.cache.purge()` — ADR 0020 §3, since the API Worker's own
 * zone-HTTP purge is inert against native Workers Cache); no-op without the queue
 * binding (local/preview). Algolia sync (AECI-139) is an injectable post-commit seam
 * over the Drizzle `algolia-sync` core, no-op without the Algolia secrets.
 */

import {
  CACHE_PURGE_QUEUE_MAX_TAGS,
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
  attestations,
  claims,
  integrations,
  productAudiences,
  productCategories,
  productExtensions,
  productPhases,
  products,
  productVendors,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyDataObjects,
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
import { loadClaimedVendorIds } from '../lib/claimed-vendors';
import { callGoogleIndexing } from '../lib/google-indexing';
import { writeDb, type DbFactory } from '../lib/handler-utils';
import { runHomeStats, type HomeStatsResult } from '../lib/home-stats';
import { emitHomeStatsMetrics, type StatsMetricSink } from '../lib/home-stats-metrics';
import { callIndexNow } from '../lib/indexnow';
import { recomputeProductCounts } from '../lib/recompute-counts';
import { cacheTagsForPromote } from './promote-cache-tags';
import { affectedUrlsForPromote } from './promote-indexnow-urls';

// ─── Claimed-vendor block reasons (AECI-520) ─────────────────────────────────
// Constants, not interpolated strings: the review app surfaces `skipped[].reason`
// verbatim, and the causal vendor ids belong in the `promote.blocked` audit row,
// not in a message specs and operators have to pattern-match.
const BLOCKED_VENDOR_REASON =
  'vendor is claimed by a vendor admin; review-app writes to claimed vendors are blocked';
const BLOCKED_PRODUCT_REASON =
  'product belongs to a claimed vendor; review-app writes to claimed vendors are blocked';
const BLOCKED_INTEGRATION_REASON =
  'an endpoint product belongs to a claimed vendor; review-app writes to claimed vendors are blocked';

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

/**
 * The vendor columns a promote may write.
 *
 * `verified` is deliberately ABSENT (AECI-520). It is the paid-entitlement bit
 * — set by the claim→account grant (`STAGE_2_VENDOR_PORTAL_SPEC.md` §3) and
 * cleared only by a deliberate entitlement action. Letting the review app write
 * it meant an ordinary Airtable push could silently un-verify a paying vendor.
 * The field stays accepted-and-ignored in `PromoteVendorSchema` so this needed
 * no lockstep review-app deploy.
 */
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
 * Best-effort, post-commit cache-purge *enqueue* for a promote (WC-5 / ADR 0020 §3).
 * Enqueues the invalidated `Cache-Tag`s onto `CACHE_PURGE_QUEUE`; the SSR Worker's
 * queue consumer issues the actual `ctx.cache.purge()` and emits the
 * `aeci.cache.purge` metric — the API Worker's own zone-HTTP purge is inert against
 * native Workers Cache. No-ops when the queue binding is absent (local/preview) or
 * nothing cacheable changed. One message per ≤`CACHE_PURGE_QUEUE_MAX_TAGS` (1000, the
 * `ctx.cache.purge` tag cap) batch — a promote's tag set virtually always fits one; a
 * `queue.send` rejection is logged (Datadog `warn`) and swallowed so it never affects
 * the committed promote.
 */
async function purgeAfterPromote(
  c: Context<{ Bindings: Env }>,
  response: PromoteResponse,
): Promise<void> {
  const queue = c.env.CACHE_PURGE_QUEUE;
  if (!queue) return;

  const tags = cacheTagsForPromote(response);
  if (tags.length === 0) return;

  const batches: string[][] = [];
  for (let i = 0; i < tags.length; i += CACHE_PURGE_QUEUE_MAX_TAGS) {
    batches.push(tags.slice(i, i + CACHE_PURGE_QUEUE_MAX_TAGS));
  }

  await Promise.allSettled(
    batches.map(async (batch) => {
      try {
        await queue.send({ tags: batch, source: 'promote' });
      } catch (error) {
        logPurgeEnqueueFailure(c, batch, error instanceof Error ? error.message : String(error));
      }
    }),
  );
}

function logPurgeEnqueueFailure(
  c: Context<{ Bindings: Env }>,
  batch: string[],
  reason: string,
): void {
  logToDatadog(c.executionCtx, c.env, c.req.raw, {
    level: 'warn',
    message: 'aeci.api.promote.cache_purge_enqueue_failed',
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
  // Post-commit best-effort re-read for indexing. It re-queries the just-promoted
  // rows by id, so it MUST see its own write: resume the write session via its
  // bookmark (`dbCtx` stashed by `writeDb`) rather than starting a fresh
  // `'first-unconstrained'` session — otherwise a lagging replica could index
  // stale/missing rows once read replication is enabled. Falls back to the read
  // default when no bookmark exists (single-DB local/test). (AECI-250)
  syncAlgoliaAfterPromote(
    c,
    response,
    getDb(c.env, { bookmark: c.get('dbCtx')?.getBookmark() ?? null }).db,
  );

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

// ─── Home-stats refresh (AECI-305) ───────────────────────────────────────────

/** The edge-cache tag the home page (`/`) carries — the SSR emitter is
 *  `apps/web/src/server/cache-tags.ts` → `cacheTagInputsForPath('/')`. Kept in
 *  lockstep with that side per `docs/CACHE_STRATEGY.md` §2: purging it here evicts
 *  the cached home HTML so it repaints with the fresh counts. */
const HOME_CACHE_TAG = 'index:home';

/**
 * Post-commit home-stats refresh seam. The home page's credibility strip + stats
 * cards read the `home.*` `stats_cache` keys, which are **never live-aggregated**
 * (`routes/stats.ts` / §10) and were previously written ONLY by the daily 07:00 UTC
 * cron (`scheduled.ts`). So a promote that added products/vendors/integrations left
 * the home banner frozen at the last cron snapshot until the next run. This
 * recomputes the cache immediately after the promote commits, then purges the home
 * page's edge cache so the next render repaints with the fresh numbers.
 *
 * Ordering is load-bearing: refresh `stats_cache` FIRST, purge `/` SECOND, so any
 * render after the purge reads the already-fresh cache (and never re-caches stale
 * HTML for another edge TTL). Injected for tests; never throws. Mirrors the Algolia
 * seam above.
 */
export type PromoteHomeStatsRefresh = (c: Context<{ Bindings: Env }>) => Promise<void>;

const defaultHomeStatsRefresh: PromoteHomeStatsRefresh = (c) =>
  // Re-read with the promote's write bookmark (`dbCtx` stashed by `writeDb`) so the
  // recompute's COUNT(*)s see the just-committed rows even once D1 read replication
  // is enabled — otherwise a lagging replica would recount the stale catalog. Falls
  // back to the read default when no bookmark exists (single-DB local/test). (AECI-250)
  refreshHomeStatsAfterPromote(
    c,
    getDb(c.env, { bookmark: c.get('dbCtx')?.getBookmark() ?? null }).db,
  );

/** Exported for the promote spec: recompute the `home.*` `stats_cache` keys, then
 *  purge the home page. Not the injected seam (`PromoteHomeStatsRefresh`) — that's
 *  the thin `getDb`-binding wrapper above; this is the testable body. */
export async function refreshHomeStatsAfterPromote(
  c: Context<{ Bindings: Env }>,
  db: Db,
): Promise<void> {
  const started = Date.now();
  let result: HomeStatsResult;
  try {
    result = await runHomeStats(db, new Date());
  } catch (error) {
    // `runHomeStats` is per-key best-effort and never throws on a compute/write
    // failure, so reaching here is a pre-compute crash. Count an outright failure +
    // error-log; never rethrow — the promote already committed (this is a
    // post-commit task).
    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.stats.compute', 1, [
      'trigger:promote',
      'outcome:failed',
    ]);
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'error',
      message: 'aeci.stats.compute.crashed',
      source: 'review-app-promote',
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const sink: StatsMetricSink = {
    count: (metric, value, tags) =>
      submitCount(c.executionCtx, c.env, c.req.raw, metric, value, tags),
    distribution: (metric, value, tags) =>
      submitDistribution(c.executionCtx, c.env, c.req.raw, metric, value, tags),
  };
  emitHomeStatsMetrics(sink, 'promote', result, Date.now() - started);
  for (const k of result.keys) {
    if (k.status !== 'failed') continue;
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: `aeci.stats.compute ${k.key} status=failed`,
      source: 'review-app-promote',
      key: k.key,
      ...(k.error ? { reason: k.error } : {}),
    });
  }

  // Enqueue the home page's purge now that `stats_cache` is fresh, so the next render
  // repaints with the new counts. Ordering is load-bearing: the `stats_cache`
  // recompute above ran FIRST, so the SSR consumer's purge can't race ahead of it
  // (WC-5 / ADR 0020 §3). Best-effort, post-refresh; no-ops without the queue binding
  // (local/preview don't edge-cache, so the refresh above already suffices). Wrapped so
  // a `queue.send` rejection can't reject this post-commit task — logged, never
  // rethrown. The SSR consumer issues the purge + emits `aeci.cache.purge`.
  const queue = c.env.CACHE_PURGE_QUEUE;
  if (!queue) return;
  try {
    await queue.send({ tags: [HOME_CACHE_TAG], source: 'promote' });
  } catch (error) {
    logPurgeEnqueueFailure(
      c,
      [HOME_CACHE_TAG],
      error instanceof Error ? error.message : String(error),
    );
  }
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
  refreshHomeStats: PromoteHomeStatsRefresh = defaultHomeStatsRefresh,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
    }

    const payload = PromotePayloadSchema.parse(raw);
    const { db } = writeDb(c, dbFor);

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

    // ── Claimed-vendor guard (AECI-520) ──────────────────────────────────────
    // Once AECi grants a vendor-portal seat, that vendor's row — and every
    // product it owns — is vendor-owned: the vendor edits it through
    // `/api/vendor/*`, and this endpoint writes exactly the same columns. So the
    // review app is blocked from overwriting them (STAGE_2_VENDOR_PORTAL_SPEC.md
    // §4; the AECI-520 decision). Everything else in the payload still promotes.
    //
    // Both reads run BEFORE the first `stmts.push`, because the decision has to
    // be available to the taxonomy resolution ~100 lines below — that step mints
    // terms and would otherwise leave orphans behind for a product we never write.
    const existingProductVendorIds = payload.product?.supabaseId
      ? (
          await db.query.productVendors.findMany({
            columns: { vendorId: true },
            where: eq(productVendors.productId, payload.product.supabaseId),
          })
        ).map((r) => r.vendorId)
      : [];

    // A vendor with no `supabaseId` is being created, so it cannot be claimed —
    // a payload that only creates pays no extra read at all.
    const claimedVendorIds = await loadClaimedVendorIds(db, [
      ...updatedVendorIds,
      ...existingProductVendorIds,
    ]);

    // An EXISTING product is blocked when a claimed vendor owns it today, or
    // when this payload would hand it to one. Creation is never blocked: nothing
    // vendor-owned exists yet, and blocking it would stall catalog growth for
    // every vendor that has signed up.
    const productBlocked =
      Boolean(payload.product?.supabaseId) &&
      [...existingProductVendorIds, ...updatedVendorIds].some((id) => claimedVendorIds.has(id));

    // ── Vendors ──────────────────────────────────────────────────────────────
    const vendorIdByRef = new Map<string, string>();
    const vendorResults: PromoteEntityResult[] = [];
    let firstVendorSlug: string | undefined;
    for (const v of payload.vendors) {
      if (v.supabaseId && claimedVendorIds.has(v.supabaseId)) {
        const slug = vendorSlugById.get(v.supabaseId) ?? '';
        // Still register the id: blocking means "don't overwrite this vendor's
        // own row", not "pretend it doesn't exist". An unrelated integration may
        // legitimately point `built_by_vendor_id` at it, and a NEW product in
        // this payload still needs the join row (and the slug suffix below).
        vendorIdByRef.set(v.ref, v.supabaseId);
        firstVendorSlug ??= slug;
        skipped.push({ ref: v.ref, kind: 'vendor', reason: BLOCKED_VENDOR_REASON });
        audit({
          actorType: 'system',
          action: 'promote.blocked',
          entityType: 'vendor',
          entityId: v.supabaseId,
        });
        continue;
      }
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
    // `writesProduct` gates every step that plans a write for the payload's
    // product (AECI-520). It has to gate taxonomy resolution too, not just the
    // product block below: `resolveTaxonomy` MINTS missing terms, so a blocked
    // promote would otherwise create orphan terms in the nav and purge every
    // browse page it merely mentioned.
    const writesProduct = Boolean(p) && !productBlocked;
    const emptyTax = {
      ids: [] as string[],
      results: [] as PromoteTaxonomyResult[],
      termBySlug: new Map<string, { slug: string; name: string }>(),
    };
    const categories =
      writesProduct && p
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
    const audiences =
      writesProduct && p
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
    const phases =
      writesProduct && p
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
    if (writesProduct && p) {
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
    // Gating the whole block is what suppresses every product write at once: the
    // column UPDATE, the `product_vendors` delete+reinsert (which would otherwise
    // ORPHAN THE CLAIM by re-parenting the product away from the claimed vendor),
    // all three taxonomy join rewrites, extensions, and their audit rows.
    // `productBlocked` implies `p.supabaseId`, so the create branch below stays
    // reachable — a new product is never blocked.
    if (writesProduct && p) {
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
    } else if (p && productBlocked) {
      // `productId`/`productResult` stay unset, so the product is OMITTED from
      // the response — which is what keeps it out of the cache purge, IndexNow,
      // Google Indexing, and the Algolia sync without touching any of them.
      skipped.push({ ref: p.ref, kind: 'product', reason: BLOCKED_PRODUCT_REASON });
      audit({
        actorType: 'system',
        action: 'promote.blocked',
        entityType: 'product',
        entityId: p.supabaseId as string,
      });
    }

    // ── Data-object resolver (find-only, for claims — §6.2) ───────────────────
    // Claims resolve their `dataObject` against the seeded, frozen
    // `taxonomy_data_objects` vocabulary by slug OR alias (never find-or-create —
    // an unmatched term lands in `skipped[]` with `kind: 'claim'`). Load once and
    // only when a claim is actually present, mirroring the usefulness find-only
    // path (`resolveUsefulnessFacet`). `safeSlugify` normalizes both the seeded
    // keys and the incoming value so case/spacing don't matter.
    const anyClaims = payload.integrations.some((i) => i.claims.length > 0);
    const dataObjectIdByKey = new Map<string, string>();
    if (anyClaims) {
      const doRows = await db
        .select({
          id: taxonomyDataObjects.id,
          slug: taxonomyDataObjects.slug,
          aliases: taxonomyDataObjects.aliases,
        })
        .from(taxonomyDataObjects);
      const addKey = (value: string | null | undefined, id: string) => {
        const key = value ? safeSlugify(value) : null;
        if (key && !dataObjectIdByKey.has(key)) dataObjectIdByKey.set(key, id);
      };
      for (const row of doRows) {
        addKey(row.slug, row.id);
        for (const alias of row.aliases ?? []) addKey(alias, row.id);
      }
    }
    const resolveDataObject = (value: string): string | undefined => {
      const key = safeSlugify(value);
      return key ? dataObjectIdByKey.get(key) : undefined;
    };

    // ── Integrations ──────────────────────────────────────────────────────────
    const integrationResults: PromoteIntegrationResult[] = [];
    // Endpoint product ids per integration result (parallel to `integrationResults`),
    // used to backfill `sourceSlug`/`targetSlug` after the loop (§6.2 → pair derivers).
    const integrationEndpoints: Array<{
      result: PromoteIntegrationResult;
      sourceId: string;
      targetId: string;
    }> = [];
    const affectedProducts = new Set<string>();
    if (productId) affectedProducts.add(productId);
    // An integration IS a relationship on both of its endpoints, so one that
    // touches the blocked product changes that product's integration surface (and
    // its `integration_count`) — it cascades. Checked explicitly rather than left
    // to `resolveProduct` returning null, for two reasons: the implicit path would
    // report the misleading "not promoted yet" reason for a product that is fully
    // promoted, and it only covers the `ref` form. `PromotePayloadSchema`'s
    // superRefine constrains only `ref` endpoints, so `{ supabaseId: <the blocked
    // product> }` is a legal payload that would otherwise slip straight through.
    const touchesBlockedProduct = (ref: EntityRef): boolean =>
      productBlocked &&
      ((ref.ref !== undefined && ref.ref === p?.ref) ||
        (ref.supabaseId != null && ref.supabaseId === p?.supabaseId));

    for (const intg of payload.integrations) {
      if (touchesBlockedProduct(intg.sourceProduct) || touchesBlockedProduct(intg.targetProduct)) {
        skipped.push({ ref: intg.ref, kind: 'integration', reason: BLOCKED_INTEGRATION_REASON });
        continue;
      }
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

      let integrationId: string;
      let result: PromoteIntegrationResult;
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
        integrationId = intg.supabaseId;
        result = { ref: intg.ref, id: intg.supabaseId, operation: 'updated' };
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
        integrationId = id;
        result = { ref: intg.ref, id, operation: 'created' };
        audit({
          actorType: 'system',
          action: 'integration.created',
          entityType: 'integration',
          entityId: id,
        });
      }
      integrationResults.push(result);
      integrationEndpoints.push({ result, sourceId, targetId });

      // ── Claims (replace-by-integration — §6.2) ──────────────────────────────
      // Claims attach to THIS mechanism row and are replaced to exactly match the
      // payload (same merge-by-replacement semantics as the product-join sets
      // above): clear the integration's existing claims — their attestations
      // cascade via the `attestations.claim_id ON DELETE CASCADE` FK — then
      // re-insert. Runs for every resolved integration that is an update (so an
      // empty `claims[]` clears prior claims) or that carries claims (a fresh
      // integration's delete is a harmless no-op). Statement order stays FK-safe:
      // integration → delete claims → claims → attestations → audits (last).
      if (intg.supabaseId || intg.claims.length) {
        stmts.push(db.delete(claims).where(eq(claims.integrationId, integrationId)));
        const seenClaims = new Set<string>();
        for (const claim of intg.claims) {
          const dataObjectId = resolveDataObject(claim.dataObject);
          if (!dataObjectId) {
            skipped.push({
              ref: intg.ref,
              kind: 'claim',
              reason: `dataObject "${claim.dataObject}" did not resolve to the seeded vocabulary`,
            });
            continue;
          }
          // Collapse identity duplicates within the payload so the re-insert never
          // orphans an attestation on a claim the unique index would reject.
          const identity = `${dataObjectId}|${claim.direction}`;
          if (seenClaims.has(identity)) continue;
          seenClaims.add(identity);

          const claimId = crypto.randomUUID();
          stmts.push(
            db
              .insert(claims)
              .values({ id: claimId, integrationId, dataObjectId, direction: claim.direction }),
          );
          audit({
            actorType: 'system',
            action: 'claim.created',
            entityType: 'claim',
            entityId: claimId,
          });
          for (const att of claim.attestations) {
            const attestationId = crypto.randomUUID();
            stmts.push(
              db.insert(attestations).values({
                id: attestationId,
                claimId,
                source: att.source,
                asserted: att.asserted,
                introducedAt: att.introducedAt ?? null,
                deprecatedAt: att.deprecatedAt ?? null,
                note: att.note ?? null,
              }),
            );
            audit({
              actorType: 'system',
              action: 'attestation.created',
              entityType: 'attestation',
              entityId: attestationId,
            });
          }
        }
      }

      affectedProducts.add(sourceId);
      affectedProducts.add(targetId);
    }

    // ── Backfill integration result slugs (§6.2 → pair cache tag + pair URLs) ──
    // The pair derivers need both endpoint slugs. Seed the map with the in-payload
    // product (a freshly-created product is not yet readable from D1), then read
    // the slugs of any endpoints referenced by `supabaseId` in one batched query.
    if (integrationEndpoints.length) {
      const slugByProductId = new Map<string, string>();
      if (productId && productResult) slugByProductId.set(productId, productResult.slug);
      const needSlugs = new Set<string>();
      for (const { sourceId, targetId } of integrationEndpoints) {
        if (!slugByProductId.has(sourceId)) needSlugs.add(sourceId);
        if (!slugByProductId.has(targetId)) needSlugs.add(targetId);
      }
      if (needSlugs.size) {
        const rows = await db.query.products.findMany({
          columns: { id: true, slug: true },
          where: inArray(products.id, [...needSlugs]),
        });
        for (const row of rows) slugByProductId.set(row.id, row.slug);
      }
      for (const { result, sourceId, targetId } of integrationEndpoints) {
        result.sourceSlug = slugByProductId.get(sourceId);
        result.targetSlug = slugByProductId.get(targetId);
      }
    }

    // Snapshot BEFORE the audit rows are appended: this is "did catalog state
    // actually change?", which is what the home-stats refresh below gates on. A
    // fully-blocked promote (AECI-520) writes only `promote.blocked` audit rows,
    // so counting `stmts` after the append would schedule a refresh for a promote
    // that changed nothing. Identical to the previous behaviour for every other
    // case — until now no audit row existed without an accompanying write.
    const catalogWrites = stmts.length;

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

    // AECI-105 → WC-5: enqueue a purge of the edge-cache tags this promote
    // invalidated; the SSR queue consumer does the `ctx.cache.purge()`. Best-effort,
    // post-commit; no-ops without the queue binding (local/preview).
    if (c.env.CACHE_PURGE_QUEUE) {
      c.executionCtx.waitUntil(purgeAfterPromote(c, response));
    }

    // AECI-305: refresh the `home.*` `stats_cache` keys the home page reads, then
    // purge `/` so its credibility strip + stats cards repaint with the new counts.
    // Those numbers come from the cache, not a live count, so without this the home
    // banner lags the catalog until the daily cron. Gate on an actual write (an
    // all-skipped promote changed nothing); best-effort, post-commit — the seam
    // never throws and self-gates the purge on CF creds.
    if (catalogWrites) {
      c.executionCtx.waitUntil(refreshHomeStats(c));
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

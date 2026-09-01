/**
 * Push-based Airtable → app-DB promotion ingest — Drizzle/D1 (ADR 0016 / AECI-253,
 * AECI-249).
 *
 * The review application sends one product plus its dependencies; this module
 * upserts the whole bundle and returns the resulting IDs (see `@aeci/shared`
 * `PromotePayloadSchema` / `PromoteResponse` for the contract and idempotency
 * model).
 *
 * **This is no longer an HTTP handler (AECI-563 / ADR 0021).** `POST /api/promote`
 * (`routes/promote-kickoff.ts`) validates the payload, starts the promote Workflow,
 * and returns `202 { jobId }`; the Workflow (`workflows/promote-workflow.ts`) runs
 * {@link runPromoteIngest} inside one non-retried step and then
 * {@link dispatchPromoteHooks}, and `GET /api/promote/jobs/:id`
 * (`routes/promote-jobs.ts`) serves the ID map. That split exists because the
 * commit used to be lost to a client timeout: the batch committed, the response
 * carrying the assigned IDs never arrived, and the product went live with no way
 * to recover its IDs (AECI-561).
 *
 * D1 has no interactive transactions, so the ingest is **plan-then-batch**:
 *   1. **Plan (reads + id generation, NO writes).** Preload slugs; read the
 *      slugs of any rows being updated; resolve taxonomy (find-or-create for
 *      categories/audiences/phases, find-ONLY for trades — AECI-542) and
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
 *   - **Upsert by caller-supplied `supabaseId`.** Present *and still resolvable*
 *     → update; absent → create. The review app holds the IDs (no `external_id`
 *     column exists). A `supabaseId` whose row is **gone** (retracted, pruned,
 *     deleted) falls back to **create** rather than issuing a no-op
 *     `UPDATE … WHERE id = <gone>` that silently writes nothing and reports an
 *     empty slug (AECI-568). The fallback is reported on
 *     `PromoteIngestResult.staleSupabaseIds` → `aeci.api.promote.stale_id`.
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
  type PromotePayload,
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
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import { disambiguateSlug, SlugReservedError, slugify } from '@aeci/shared/slug';
import { eq, inArray, sql, type Table } from 'drizzle-orm';
import { type SQLiteColumn } from 'drizzle-orm/sqlite-core';

import { getDb, type Db, type DbContext } from '../db/client';
import {
  attestations,
  claims,
  integrations,
  productAudiences,
  productCategories,
  productExtensions,
  productPhases,
  products,
  productTrades,
  productVendors,
  promoteJobs,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyDataObjects,
  taxonomyPhases,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import {
  logBatchToDatadog,
  logToDatadog,
  submitCount,
  submitDistribution,
  type DdLogEvent,
} from '../datadog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { syncPromoteTargets } from '../lib/algolia-sync';
import { emitAlgoliaSyncMetrics, type SyncMetricSink } from '../lib/algolia-sync-metrics';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { type DbFactory } from '../lib/handler-utils';
import { runHomeStats, type HomeStatsResult } from '../lib/home-stats';
import { emitHomeStatsMetrics, type StatsMetricSink } from '../lib/home-stats-metrics';
import { callIndexNow } from '../lib/indexnow';
import { recomputeProductCounts } from '../lib/recompute-counts';
import { cacheTagsForPromote, touchedTradeSlugs } from './promote-cache-tags';
import { affectedUrlsForPromote, type AffectedUrlOptions } from './promote-indexnow-urls';
import { resolvePublishedTradeSlugs } from './promote-trade-publication';

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

/**
 * True when `err` is the `promote_jobs` primary-key violation — i.e. this job id has
 * already committed and the batch we just attempted IS a replay (AECI-571).
 *
 * Sibling of {@link isSlugUniqueViolation}, duck-typed the same way because D1 and
 * better-sqlite3 both report constraint failures only in the message. Note the trap:
 * SQLite reports a conflict on a TEXT PRIMARY KEY as `UNIQUE constraint failed:
 * promote_jobs.job_id` (extended code `SQLITE_CONSTRAINT_PRIMARYKEY`) — the words
 * "primary key" never appear in the message, so this matches on the TABLE name instead.
 * D1 wraps the identical text as `D1_ERROR: UNIQUE constraint failed:
 * promote_jobs.job_id: SQLITE_CONSTRAINT`.
 *
 * The message carries no `slug`, and a slug violation carries no `promote_jobs`, so this
 * predicate and {@link isSlugUniqueViolation} are disjoint by construction.
 */
function isPromoteJobDuplicate(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { message?: unknown; code?: unknown };
  const msg =
    `${typeof e.message === 'string' ? e.message : ''} ${String(e.code ?? '')}`.toLowerCase();
  return msg.includes('constraint') && msg.includes('promote_jobs');
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

/**
 * The §26.5 Datadog envelope for one `audit_log` row. Split out from the old
 * `AuditLogForwarder` closure so the whole set can be posted in ONE request —
 * see the `logBatchToDatadog` call in {@link dispatchPromoteHooks}.
 */
function auditLogEvent(entry: Omit<AuditLogEntry, 'metadata'>): DdLogEvent {
  return {
    level: 'info',
    message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
    action: entry.action,
    entity_type: entry.entityType ?? undefined,
    entity_id: entry.entityId ?? undefined,
    source: 'review-app-promote',
  };
}

/**
 * Ceiling on how long a post-commit hook may stay unsettled before this gives up
 * on it (AECI-666).
 *
 * Not a request timeout — the hooks are already fire-and-forget and nothing is
 * waiting on them. It exists because a `fetch` the runtime cancels for holding a
 * connection too long returns a promise that **never settles at all**: no
 * resolve, no reject, so the transport's own `catch` cannot see it. Left
 * unguarded, that promise sits in `waitUntil` until the runtime kills the whole
 * invocation as hung, taking every *other* in-flight hook with it. Losing one
 * hook is survivable; losing the invocation is what turned this into a silent
 * outage across ~8% of production promotes.
 *
 * 20s, not 30s: `waitUntil` is documented to extend execution for *up to* 30s
 * after the response, so a 30s watchdog races the platform tearing the
 * invocation down and the warning — the whole point — might never be emitted.
 * 20s is ~20x the slowest healthy hook (a few D1 reads plus 1-3 Algolia batch
 * calls) and comfortably inside the budget.
 *
 * Note the watchdog also suppresses the hang *detector* for its whole duration:
 * a pending timer means the event loop is not empty, which is the condition the
 * runtime kills on. So the invocation ends cleanly on the timeout path rather
 * than being cancelled part-way through the other hooks.
 */
const HOOK_SETTLE_TIMEOUT_MS = 20_000;

/**
 * Hand `task` to `waitUntil` behind a watchdog: whichever way it ends, the
 * promise `waitUntil` sees always settles.
 *
 * The timeout branch is the whole point — it converts a wedged transport from an
 * invocation-killing hang into one `console.warn` line in Workers Observability,
 * which is the signal that was missing while this failure mode ran undetected.
 */
function dispatchHook(rc: PromoteRunCtx, name: string, task: Promise<unknown>): void {
  rc.waitUntil(
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(
          `promote hook "${name}" did not settle within ${HOOK_SETTLE_TIMEOUT_MS}ms — abandoning it`,
        );
        resolve();
      }, HOOK_SETTLE_TIMEOUT_MS);
      task
        .catch((error: unknown) => {
          // The transports swallow their own failures, so reaching here means an
          // unexpected throw. Never let it become an unhandled rejection.
          console.warn(`promote hook "${name}" threw`, error);
        })
        .finally(() => {
          clearTimeout(timer);
          resolve();
        });
    }),
  );
}

const AUDIT_META = { source: 'review-app-promote' } as const;

// ─── Cache purge (AECI-105) ──────────────────────────────────────────────────

/**
 * Best-effort, post-commit edge-cache purge for a promote. No-ops when
 * `CF_PURGE_API_TOKEN` / `CF_ZONE_ID` is absent, or when nothing cacheable
 * changed. Batches are fired concurrently; each batch's outcome is recorded as
 * `aeci.cache.purge{source:promote,outcome:ok|cf_failed}` and a failed batch is
 * logged (Datadog `warn`) and swallowed so it never affects the committed promote.
 *
 * `removedTradeSlugs` carries the trades this promote *dropped* from the product
 * (AECI-542). The response echoes only what was SET, so a re-promote that clears a
 * trade would otherwise purge nothing — and because the trade facet is publication-
 * gated (`TRADE_PUBLISH_MIN_PRODUCTS`), a removal can un-publish a term and change
 * `/trades`, the facet sidebar, and the sitemap. See `CACHE_STRATEGY.md` §2.
 */
async function purgeAfterPromote(
  rc: PromoteRunCtx,
  response: PromoteResponse,
  removedTradeSlugs: string[] = [],
): Promise<void> {
  const creds = { apiToken: rc.env.CF_PURGE_API_TOKEN, zoneId: rc.env.CF_ZONE_ID };
  if (!creds.apiToken || !creds.zoneId) return;

  const tags = cacheTagsForPromote(response, { removedTradeSlugs });
  if (tags.length === 0) return;

  const batches: string[][] = [];
  for (let i = 0; i < tags.length; i += CF_PURGE_MAX_TAGS) {
    batches.push(tags.slice(i, i + CF_PURGE_MAX_TAGS));
  }

  await Promise.allSettled(
    batches.map(async (batch) => {
      const outcome = await callCloudflarePurge(fetch, creds, batch);
      submitCount(rc, rc.env, rc.request, 'aeci.cache.purge', 1, [
        'source:promote',
        `outcome:${outcome.ok ? 'ok' : 'cf_failed'}`,
      ]);
      if (!outcome.ok) {
        logPurgeFailure(rc, batch, `cf_${outcome.status}: ${outcome.message}`);
      }
    }),
  );
}

function logPurgeFailure(rc: PromoteRunCtx, batch: string[], reason: string): void {
  logToDatadog(rc, rc.env, rc.request, {
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
export type PromoteAlgoliaSync = (rc: PromoteRunCtx, response: PromoteResponse) => Promise<void>;

const defaultAlgoliaSync: PromoteAlgoliaSync = (rc, response) =>
  // Post-commit best-effort re-read for indexing. It re-queries the just-promoted
  // rows by id, so it MUST see its own write: resume the write session via its
  // bookmark (`rc.bookmark()`, filled in from the commit step's result) rather than
  // starting a fresh `'first-unconstrained'` session — otherwise a lagging replica could index
  // stale/missing rows once read replication is enabled. Falls back to the read
  // default when no bookmark exists (single-DB local/test). (AECI-250)
  syncAlgoliaAfterPromote(rc, response, getDb(rc.env, { bookmark: rc.bookmark() }).db);

async function syncAlgoliaAfterPromote(
  rc: PromoteRunCtx,
  response: PromoteResponse,
  db: Db,
): Promise<void> {
  const creds = { appId: rc.env.ALGOLIA_APP_ID, apiKey: rc.env.ALGOLIA_ADMIN_KEY };
  const env: AlgoliaEnv = rc.env.ENV ?? 'development';
  const started = Date.now();
  try {
    const results = await syncPromoteTargets(db, fetch, creds, env, {
      product: response.product ? { id: response.product.id } : null,
      vendors: response.vendors.map((v) => ({ id: v.id })),
      integrations: response.integrations.map((i) => ({ id: i.id })),
    });
    const sink: SyncMetricSink = {
      count: (metric, value, tags) => submitCount(rc, rc.env, rc.request, metric, value, tags),
      distribution: (metric, value, tags) =>
        submitDistribution(rc, rc.env, rc.request, metric, value, tags),
    };
    emitAlgoliaSyncMetrics(sink, 'promote', results, Date.now() - started);
    for (const result of results) {
      if (!result.ok) logAlgoliaSyncFailure(rc, result.entity, result.error ?? 'unknown');
    }
  } catch (error) {
    logAlgoliaSyncFailure(rc, 'all', error instanceof Error ? error.message : String(error));
  }
}

function logAlgoliaSyncFailure(rc: PromoteRunCtx, entity: string, reason: string): void {
  logToDatadog(rc, rc.env, rc.request, {
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
 *
 * `tradeUrls` carries the trade inputs the response can't supply (AECI-546): the
 * touched trades that are PUBLISHED post-commit, plus the removed slugs. It
 * arrives as a promise so the one D1 read backing it is shared with the Google
 * seam and never awaited on the request path — see `resolveTradeUrlOptions`.
 */
export type PromoteIndexNowNotify = (
  rc: PromoteRunCtx,
  response: PromoteResponse,
  tradeUrls: Promise<AffectedUrlOptions>,
) => Promise<void>;

const defaultIndexNowNotify: PromoteIndexNowNotify = (rc, response, tradeUrls) =>
  notifyIndexNowAfterPromote(rc, response, tradeUrls);

async function notifyIndexNowAfterPromote(
  rc: PromoteRunCtx,
  response: PromoteResponse,
  tradeUrls: Promise<AffectedUrlOptions>,
): Promise<void> {
  const key = rc.env.INDEXNOW_KEY;
  const siteUrl = rc.env.PUBLIC_SITE_URL;
  if (!key || !siteUrl) return;

  const urlList = affectedUrlsForPromote(response, siteUrl, await tradeUrls);
  if (urlList.length === 0) return;

  let host: string;
  let keyLocation: string;
  try {
    host = new URL(siteUrl).host;
    keyLocation = `${siteUrl.replace(/\/+$/, '')}/${key}.txt`;
  } catch {
    // PUBLIC_SITE_URL isn't a valid URL — misconfiguration; skip rather than throw.
    logIndexNowFailure(rc, urlList.length, 'invalid_public_site_url');
    return;
  }

  const outcome = await callIndexNow(fetch, { host, key, keyLocation, urlList });
  submitCount(rc, rc.env, rc.request, 'aeci.indexnow.submit', 1, [
    'source:promote',
    `outcome:${outcome.ok ? 'ok' : 'failed'}`,
  ]);
  if (!outcome.ok) {
    logIndexNowFailure(rc, urlList.length, `indexnow_${outcome.status}: ${outcome.message}`);
  }
}

function logIndexNowFailure(rc: PromoteRunCtx, urlsCount: number, reason: string): void {
  logToDatadog(rc, rc.env, rc.request, {
    level: 'warn',
    message: 'aeci.api.promote.indexnow_failed',
    source: 'review-app-promote',
    reason,
    urls_count: urlsCount,
  });
}

/**
 * Resolves the publication-gated trade inputs both indexing pings need
 * (AECI-546), as a promise the caller creates but never awaits.
 *
 * Three things this shape buys:
 *   - **One D1 read, two consumers.** IndexNow and Google share the deriver by
 *     design ("no second deriver", §20.2); they must share the floor read too, or
 *     the two pings could disagree about what's published.
 *   - **No added latency.** The read starts as the handler returns and resolves
 *     inside `waitUntil`, so the promote response never waits on it.
 *   - **Fails to the safe side.** A rejected read resolves to `{}`, which submits
 *     no trade URLs at all rather than risking a sub-floor (noindex) submission.
 *
 * Skipped entirely when no ping is configured or no trade was touched, so the
 * overwhelming majority of promotes — trades are sparse by design — pay nothing.
 */
function resolveTradeUrlOptions(
  rc: PromoteRunCtx,
  db: Db,
  response: PromoteResponse,
  removedTradeSlugs: string[],
): Promise<AffectedUrlOptions> {
  const siteUrl = rc.env.PUBLIC_SITE_URL;
  // IndexNow is the only ping left (AECI-747 removed the Google Indexing API
  // submission — Google supports it for `JobPosting`/`BroadcastEvent` only, which
  // is nothing we publish).
  const pingConfigured = Boolean(siteUrl) && Boolean(rc.env.INDEXNOW_KEY);
  const touched = touchedTradeSlugs(response, removedTradeSlugs);
  if (!pingConfigured || touched.length === 0) return Promise.resolve({});

  return resolvePublishedTradeSlugs(db, touched)
    .then((publishedTradeSlugs) => ({ publishedTradeSlugs, removedTradeSlugs }))
    .catch(() => ({}));
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
export type PromoteHomeStatsRefresh = (rc: PromoteRunCtx) => Promise<void>;

const defaultHomeStatsRefresh: PromoteHomeStatsRefresh = (rc) =>
  // Re-read with the promote's write bookmark (`rc.bookmark()`, filled in from the
  // commit step's result) so the
  // recompute's COUNT(*)s see the just-committed rows even once D1 read replication
  // is enabled — otherwise a lagging replica would recount the stale catalog. Falls
  // back to the read default when no bookmark exists (single-DB local/test). (AECI-250)
  refreshHomeStatsAfterPromote(rc, getDb(rc.env, { bookmark: rc.bookmark() }).db);

/** Exported for the promote spec: recompute the `home.*` `stats_cache` keys, then
 *  purge the home page. Not the injected seam (`PromoteHomeStatsRefresh`) — that's
 *  the thin `getDb`-binding wrapper above; this is the testable body. */
export async function refreshHomeStatsAfterPromote(rc: PromoteRunCtx, db: Db): Promise<void> {
  const started = Date.now();
  let result: HomeStatsResult;
  try {
    result = await runHomeStats(db, new Date());
  } catch (error) {
    // `runHomeStats` is per-key best-effort and never throws on a compute/write
    // failure, so reaching here is a pre-compute crash. Count an outright failure +
    // error-log; never rethrow — the promote already committed (this is a
    // post-commit task).
    submitCount(rc, rc.env, rc.request, 'aeci.stats.compute', 1, [
      'trigger:promote',
      'outcome:failed',
    ]);
    logToDatadog(rc, rc.env, rc.request, {
      level: 'error',
      message: 'aeci.stats.compute.crashed',
      source: 'review-app-promote',
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const sink: StatsMetricSink = {
    count: (metric, value, tags) => submitCount(rc, rc.env, rc.request, metric, value, tags),
    distribution: (metric, value, tags) =>
      submitDistribution(rc, rc.env, rc.request, metric, value, tags),
  };
  emitHomeStatsMetrics(sink, 'promote', result, Date.now() - started);
  for (const k of result.keys) {
    if (k.status !== 'failed') continue;
    logToDatadog(rc, rc.env, rc.request, {
      level: 'warn',
      message: `aeci.stats.compute ${k.key} status=failed`,
      source: 'review-app-promote',
      key: k.key,
      ...(k.error ? { reason: k.error } : {}),
    });
  }

  // Purge the home page's edge cache now that `stats_cache` is fresh, so the next
  // render repaints with the new counts. Best-effort, post-refresh; no-ops without
  // CF creds (local/preview don't edge-cache, so the refresh above already suffices).
  // Wrapped so a network-level `fetch` throw can't reject this post-commit task —
  // the CF error is recorded, never rethrown.
  const creds = { apiToken: rc.env.CF_PURGE_API_TOKEN, zoneId: rc.env.CF_ZONE_ID };
  if (!creds.apiToken || !creds.zoneId) return;
  try {
    const outcome = await callCloudflarePurge(fetch, creds, [HOME_CACHE_TAG]);
    submitCount(rc, rc.env, rc.request, 'aeci.cache.purge', 1, [
      'source:promote',
      `outcome:${outcome.ok ? 'ok' : 'cf_failed'}`,
    ]);
    if (!outcome.ok) {
      logPurgeFailure(rc, [HOME_CACHE_TAG], `cf_${outcome.status}: ${outcome.message}`);
    }
  } catch (error) {
    submitCount(rc, rc.env, rc.request, 'aeci.cache.purge', 1, [
      'source:promote',
      'outcome:cf_failed',
    ]);
    logPurgeFailure(rc, [HOME_CACHE_TAG], error instanceof Error ? error.message : String(error));
  }
}

// ─── Skipped-entity observability ────────────────────────────────────────────

/**
 * Surface a promote's `skipped[]` (§4) in Datadog. A promote returns `200` even
 * when it could not link some entities — an integration/extension whose far
 * endpoint isn't promoted yet, a usefulness group, a claim `dataObject`, or a
 * trade that didn't resolve — so the response looks like a clean success and the
 * metrics layer (`aeci.api.query.duration_ms{status_class:2xx}`) is blind to the
 * partial data loss. Without this the only record of a curator's silently-dropped
 * push lives in the HTTP response body, which the review app must itself inspect.
 *
 * Emits a single `warn` log detailing every `{ ref, kind, reason }` plus per-kind
 * counts, and an `aeci.api.promote.skipped` count (value = per-kind skip count,
 * so query with `sum:`; `kind` tag ∈ integration/extension/usefulness/claim/trade)
 * as the alertable signal. Best-effort + fire-and-forget: the transport self-gates
 * on `DD_API_KEY` and dispatches via `ctx.waitUntil`, so this never affects the
 * committed promote. No-op when nothing was skipped.
 */
function logPromoteSkips(rc: PromoteRunCtx, skipped: PromoteSkipped[]): void {
  if (skipped.length === 0) return;

  const countByKind = skipped.reduce<Record<string, number>>((acc, s) => {
    acc[s.kind] = (acc[s.kind] ?? 0) + 1;
    return acc;
  }, {});

  logToDatadog(rc, rc.env, rc.request, {
    level: 'warn',
    message: 'aeci.api.promote.partial_skipped',
    source: 'review-app-promote',
    outcome: 'partial',
    skipped_count: skipped.length,
    // Per-kind counts as flat scalars for faceting, plus the full detail array so
    // Datadog alone answers "what didn't land and why" (each `{ref, kind, reason}`).
    ...Object.fromEntries(Object.entries(countByKind).map(([k, n]) => [`skipped_${k}`, n])),
    skipped,
  });

  for (const [kind, n] of Object.entries(countByKind)) {
    submitCount(rc, rc.env, rc.request, 'aeci.api.promote.skipped', n, [
      'source:promote',
      `kind:${kind}`,
    ]);
  }
}

/**
 * Surface a promote's stale-`supabaseId` fallbacks (AECI-568) in Datadog. The ingest
 * upserts by the caller-supplied id, so an id whose row no longer exists used to
 * produce a no-op `UPDATE` reported as `operation: 'updated'` with an empty slug —
 * invisible everywhere. The ingest now falls back to **create**, which self-heals the
 * dead pointer on the next write-back, but a silent self-heal is how the *next* drift
 * ships: it means the review app's copy of that id was wrong, and nothing else says so.
 *
 * Mirrors {@link logPromoteSkips}: one `warn` log with every `{ ref, kind, supabaseId }`
 * plus an `aeci.api.promote.stale_id` count (value = per-kind count, so query with
 * `sum:`; `kind` tag ∈ vendor/product/integration). Fire-and-forget over the same
 * self-gating transport, so it never affects the committed promote. No-op when clean.
 */
function logPromoteStaleIds(rc: PromoteRunCtx, staleSupabaseIds: PromoteStaleId[]): void {
  if (staleSupabaseIds.length === 0) return;

  const countByKind = staleSupabaseIds.reduce<Record<string, number>>((acc, s) => {
    acc[s.kind] = (acc[s.kind] ?? 0) + 1;
    return acc;
  }, {});

  logToDatadog(rc, rc.env, rc.request, {
    level: 'warn',
    message: 'aeci.api.promote.stale_supabase_id',
    source: 'review-app-promote',
    outcome: 'recreated',
    stale_id_count: staleSupabaseIds.length,
    ...Object.fromEntries(Object.entries(countByKind).map(([k, n]) => [`stale_${k}`, n])),
    stale_supabase_ids: staleSupabaseIds,
  });

  for (const [kind, n] of Object.entries(countByKind)) {
    submitCount(rc, rc.env, rc.request, 'aeci.api.promote.stale_id', n, [
      'source:promote',
      `kind:${kind}`,
    ]);
  }
}

/**
 * Surface an absorbed commit replay (AECI-571) in Datadog.
 *
 * This is the ONLY direct evidence that the Workflows at-least-once window actually
 * fired: before the `promote_jobs` ledger, the runbook could only ask an operator to
 * notice a duplicated product and infer it after the fact. A non-zero
 * `aeci.api.promote.replay` means the engine really did replay a committed step and the
 * primary key absorbed it — the promote is correct and needs no action, but the job id
 * is worth capturing.
 *
 * `via` distinguishes the two paths: `pre-read` (the ordinary replay, short-circuited
 * before the plan phase) and `batch-conflict` (a replay that raced the original
 * attempt's batch, caught by the in-batch primary key). Fire-and-forget over the same
 * self-gating transport as {@link logPromoteSkips}.
 */
function logPromoteReplay(
  rc: PromoteRunCtx,
  jobId: string,
  via: PromoteReplayPath,
  ledger: PromoteJobLedger,
): void {
  logToDatadog(rc, rc.env, rc.request, {
    level: 'warn',
    message: 'aeci.api.promote.replay_detected',
    source: 'review-app-promote',
    outcome: 'replayed',
    job_id: jobId,
    via,
    // The ids the replay is about to return, so the log alone answers "which rows".
    product_id: ledger.response.product?.id,
    truncated: ledger.truncated,
  });

  submitCount(rc, rc.env, rc.request, 'aeci.api.promote.replay', 1, [
    'source:promote',
    `via:${via}`,
  ]);
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

/**
 * Everything the ingest and its post-commit seams need from their caller, which
 * since AECI-563 is a Workflow step rather than a Hono request. Deliberately four
 * members — the ingest never wanted a `Context`, only these:
 *
 *   - `env` — the Worker bindings (`DB`, CF/Algolia/IndexNow/Google creds, `DD_*`).
 *   - `waitUntil` — dispatch for the best-effort post-commit tasks AND for the
 *     Datadog transport, which is fire-and-forget by design (`@aeci/shared/datadog`).
 *     `PromoteRunCtx` satisfies that transport's `{ waitUntil }` shape directly, so
 *     it is passed as the ctx argument.
 *   - `request` — used ONLY to derive the Datadog `hostname` dimension. The Workflow
 *     rebuilds one from the kick-off request's URL so workflow-originated promote
 *     logs stay on the same `hostname` facet as before.
 *   - `bookmark` — the latest D1 session bookmark of this promote's write (AECI-250).
 *     Mutable by design: the post-commit re-reads (Algolia, home-stats, the trade
 *     publication floor) must resume the write's session, and the bookmark only
 *     exists once the commit step has returned, so the Workflow's implementation
 *     reads a holder it fills in from {@link PromoteIngestResult}. Returns `null`
 *     before the commit and in single-DB local/test setups.
 */
export type PromoteRunCtx = {
  env: Env;
  waitUntil(promise: Promise<unknown>): void;
  request: Request;
  bookmark(): string | null;
};

/** Injectable seams, all defaulted. Tests pass no-op/spy implementations so the real
 *  transports (D1 binding, Cloudflare purge, Algolia, IndexNow) are never hit. */
export type PromoteIngestDeps = {
  dbFor?: DbFactory;
  syncAlgolia?: PromoteAlgoliaSync;
  notifyIndexNow?: PromoteIndexNowNotify;
  refreshHomeStats?: PromoteHomeStatsRefresh;
};

/** What the committed ingest hands back: the caller's ID map plus the inputs the
 *  post-commit tail needs, none of which are derivable from the response alone. */
export type PromoteIngestResult = {
  /** The ID map the review app persists — the former `200` body, now the job result. */
  response: PromoteResponse;
  /** Trades this promote DROPPED from the product; the response echoes only what was
   *  SET, and a removal can still un-publish a trade page (AECI-542/546). */
  removedTradeSlugs: string[];
  /** False for an all-skipped promote, which wrote nothing and so needs no stats refresh.
   *  Computed from the entity statements BEFORE the AECI-571 ledger row joins the batch —
   *  the ledger is bookkeeping, not a change. */
  wrote: boolean;
  /** D1 session bookmark of the commit, for the post-commit re-reads (AECI-250). */
  bookmark: string | null;
  /** Audit rows committed inside the batch, forwarded to Datadog post-commit (§26.5). */
  auditEntries: AuditLogEntry[];
  /** Entities the caller addressed by a `supabaseId` whose row no longer exists, and
   *  which were therefore **created** instead of updated (AECI-568). Deliberately NOT
   *  on `PromoteResponse`: `operation: 'created'` + the new id already tell the review
   *  app everything it must persist, so this is an operator/Datadog signal only and
   *  needs no change to the public contract. */
  staleSupabaseIds: PromoteStaleId[];
};

/** One entity addressed by a `supabaseId` that resolved to nothing (AECI-568). */
export type PromoteStaleId = {
  kind: 'vendor' | 'product' | 'integration';
  /** The payload `ref` the caller used, so the report is actionable on their side. */
  ref: string;
  /** The dead id — what the review app currently has stored for that record. */
  supabaseId: string;
};

/**
 * Per-attempt inputs that are neither run context nor injectable seams (AECI-571).
 *
 * Deliberately a fourth parameter rather than a member of {@link PromoteRunCtx}: one
 * `rc` is legitimately reused across two ingests (the specs' stale-then-healed pair),
 * and a job id living on it would silently turn the second call into a replay. `jobId`
 * scopes one *attempt*; `rc` scopes a *run*.
 */
export type PromoteIngestOptions = {
  /**
   * The promote job id — the Workflow instance id, and the `promote_jobs` primary key.
   * Supplied → the ingest is **exactly-once for this id, for as long as the ledger row
   * lives**. Omitted → pre-AECI-571 behaviour: no ledger row and no replay protection.
   * The Workflow always supplies it; only direct-call tests omit it.
   */
  jobId?: string;
};

/** How a replay was caught — see {@link logPromoteReplay}. */
type PromoteReplayPath = 'pre-read' | 'batch-conflict';

/**
 * What a committed promote leaves behind in `promote_jobs.result` (AECI-571).
 *
 * This is the replay's ONLY source of truth, and it has to carry more than the ID map.
 * The post-commit hooks are dispatched by the Workflow AFTER the commit step resolves,
 * so for the attempt whose result was lost they never ran at all — meaning the replay is
 * what must drive them. Everything {@link dispatchPromoteHooks} reads is therefore here.
 *
 * Deliberately NOT stored:
 *   - `bookmark` — a D1 session token, meaningless in another session. The replay
 *     returns its own, which (having just read this row through the `'first-primary'`
 *     anchor) is already at or past the original commit.
 *   - `AuditLogEntry.metadata` — the same `AUDIT_META` constant on every entry, so it is
 *     re-attached on read rather than stored N times.
 */
export type PromoteJobLedger = {
  /** Envelope version. A row written by a future shape reads as unusable rather than
   *  being silently coerced — see {@link parsePromoteJobLedger}. */
  v: 1;
  /** The ID map. The whole point: a replay returns the same ids and the same slug. */
  response: PromoteResponse;
  /** Hook input: trades this promote DROPPED (purge + trade-URL derivation). Not
   *  recoverable after the fact — it is a diff against pre-commit state. */
  removedTradeSlugs: string[];
  /** Hook input: gates the home-stats refresh. Computed BEFORE the ledger statement
   *  joins the batch — see the `wrote` note in {@link runPromoteIngest}. */
  wrote: boolean;
  /** Hook input: the §26.5 Datadog audit forwards. Stored without `metadata`. */
  auditEntries: Omit<AuditLogEntry, 'metadata'>[];
  /** Hook input: the AECI-568 stale-pointer report. */
  staleSupabaseIds: PromoteStaleId[];
  /** Products whose denormalized counts this promote invalidated. Not a member of
   *  {@link PromoteIngestResult} (the ingest consumes it internally), but it must
   *  survive: `recomputeProductCounts` runs AFTER the batch, outside the transaction, so
   *  the lost attempt may have died before reaching it. Re-running it on the replay is
   *  safe — it recomputes from source rows — and is the only chance to heal the counts
   *  before the daily drift sweep. */
  affectedProducts: string[];
  /** Parts shed to keep the row under {@link PROMOTE_LEDGER_MAX_BYTES}, in drop order.
   *  Diagnostic only; absent for every realistic bundle. */
  truncated?: ('auditEntries' | 'affectedProducts')[];
};

/**
 * Shed-point for the ledger blob. D1 caps a row at 2 MB; 512 KiB leaves >3x headroom and
 * keeps a `SELECT *` on this table sane. A typical bundle serializes to ~10 KB, so only a
 * pathological one (hundreds of integrations, each with claims) can reach this.
 */
const PROMOTE_LEDGER_MAX_BYTES = 512 * 1024;

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Build the ledger envelope, shedding the least valuable parts if the blob would exceed
 * {@link PROMOTE_LEDGER_MAX_BYTES}.
 *
 * Degrades, never fails: this row IS the duplicate guard, so an oversized payload must
 * cost observability rather than block an otherwise valid promote. `response` and
 * `wrote` are never droppable — they are the reason the row exists. Dropping
 * `auditEntries` costs a Datadog forward whose `audit_log` rows committed anyway;
 * dropping `affectedProducts` costs a count recompute the daily drift sweep backstops.
 */
function buildPromoteJobLedger(input: {
  response: PromoteResponse;
  removedTradeSlugs: string[];
  wrote: boolean;
  auditEntries: AuditLogEntry[];
  staleSupabaseIds: PromoteStaleId[];
  affectedProducts: Iterable<string>;
}): PromoteJobLedger {
  const ledger: PromoteJobLedger = {
    v: 1,
    response: input.response,
    removedTradeSlugs: input.removedTradeSlugs,
    wrote: input.wrote,
    auditEntries: input.auditEntries.map(({ metadata: _metadata, ...rest }) => rest),
    staleSupabaseIds: input.staleSupabaseIds,
    affectedProducts: [...input.affectedProducts],
  };

  for (const part of ['auditEntries', 'affectedProducts'] as const) {
    if (jsonByteLength(ledger) <= PROMOTE_LEDGER_MAX_BYTES) break;
    ledger[part] = [];
    (ledger.truncated ??= []).push(part);
  }
  return ledger;
}

/**
 * Narrow a stored `promote_jobs.result` back to a {@link PromoteJobLedger}, or `null` if
 * it can't be trusted. Defensive on purpose: the caller's only safe response to `null` is
 * to fail the job, because the alternative — re-planning — is the duplicate this whole
 * mechanism exists to prevent.
 *
 * Accepts a raw JSON string as well as a parsed object, so a row written by an ops script
 * outside Drizzle still reads back.
 */
function parsePromoteJobLedger(stored: unknown): PromoteJobLedger | null {
  let value = stored;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;

  const candidate = value as Partial<PromoteJobLedger>;
  if (candidate.v !== 1) return null;
  if (!candidate.response || typeof candidate.response !== 'object') return null;

  return {
    v: 1,
    response: candidate.response,
    removedTradeSlugs: candidate.removedTradeSlugs ?? [],
    wrote: candidate.wrote ?? false,
    auditEntries: candidate.auditEntries ?? [],
    staleSupabaseIds: candidate.staleSupabaseIds ?? [],
    affectedProducts: candidate.affectedProducts ?? [],
    ...(candidate.truncated ? { truncated: candidate.truncated } : {}),
  };
}

/**
 * Rebuild the {@link PromoteIngestResult} of a promote that already committed under this
 * job id (AECI-571).
 *
 * Reached two ways — the pre-read hit (`'pre-read'`, the ordinary replay) and the
 * in-batch primary-key rollback (`'batch-conflict'`, a replay that raced the original
 * attempt's batch). Both mean the same thing: the write landed exactly once, and this
 * attempt must produce the same answer without touching a row.
 */
async function replayPromoteJob(
  rc: PromoteRunCtx,
  dbCtx: DbContext,
  jobId: string,
  stored: unknown,
  via: PromoteReplayPath,
): Promise<PromoteIngestResult> {
  const ledger = parsePromoteJobLedger(stored);
  if (!ledger) {
    // The commit HAPPENED; we simply cannot describe it. Failing is the only safe
    // answer — re-planning would mint the duplicate. This is the one `errored` promote
    // job that did write, which is why the message says so (see `docs/RUNBOOKS.md`).
    throw new ApiError(
      500,
      'INTERNAL_ERROR',
      `Promote job "${jobId}" has already committed, but its stored result is unreadable. ` +
        `The rows ARE live — recover the ID map from the KV mirror (promote:result:${jobId}) ` +
        `or from promote_jobs.result. Do NOT re-push this bundle.`,
    );
  }

  logPromoteReplay(rc, jobId, via, ledger);

  // Idempotent, and outside the original transaction — the attempt that committed may
  // have died before running it, so the replay is the first real chance to heal.
  if (ledger.affectedProducts.length) {
    await recomputeProductCounts(dbCtx.db, ledger.affectedProducts);
  }

  return {
    response: ledger.response,
    removedTradeSlugs: ledger.removedTradeSlugs,
    wrote: ledger.wrote,
    // This session's bookmark, not the original's: having just read the ledger row off
    // the `'first-primary'` anchor, it is already at or past the commit — which is all
    // the post-commit re-reads need (AECI-250).
    bookmark: dbCtx.getBookmark(),
    auditEntries: ledger.auditEntries.map((entry) => ({ ...entry, metadata: AUDIT_META })),
    staleSupabaseIds: ledger.staleSupabaseIds,
  };
}

/** A taxonomy facet model (table + the columns the find-or-create reads). The
 *  generic `Table` type doesn't expose columns, so they're passed explicitly. */
interface TaxonomyTable {
  table: Table;
  idCol: SQLiteColumn;
  slugCol: SQLiteColumn;
  nameCol: SQLiteColumn;
}

/**
 * The plan-then-batch ingest. **Not an HTTP handler** — since AECI-563 the only
 * caller is the promote Workflow (`workflows/promote-workflow.ts`), which runs it
 * inside a single non-retried `step.do`. `POST /api/promote` validates the payload
 * and starts that Workflow; it no longer commits inline, so a client that walks
 * away mid-flight can't strand a committed promote's IDs.
 *
 * **Exactly-once when `opts.jobId` is supplied (AECI-571).** Workflows guarantee a step
 * runs *at least* once, so an engine crash between `db.batch` committing and the step
 * result being persisted replays this whole function. Two things absorb that: a pre-read
 * of `promote_jobs` short-circuits the ordinary case, and the ledger INSERT rides the
 * batch as its FIRST statement so a racing replay trips the primary key and D1 rolls the
 * entire batch back. Either way the recorded {@link PromoteIngestResult} is returned —
 * same ids, same slug — so the job completes normally and the hooks (which never fired
 * for the lost attempt) fire exactly once.
 *
 * Throws — never returns a `Response`:
 *   - `ApiError(400, VALIDATION_FAILED)` for a name that can't be slugified
 *     (`generateSlug`), which the caller has no way to detect up front.
 *   - `ApiError(409, SLUG_CONFLICT)` when a racing promote took the slug (AECI-98).
 *   - `ApiError(500, INTERNAL_ERROR)` when this job id already committed but its ledger
 *     row is unreadable — the ONE error that means the promote DID write.
 *   - anything else the DB raises → the Workflow reports `INTERNAL_ERROR`.
 *
 * Post-commit work is deliberately NOT done here: it is returned as
 * {@link PromoteIngestResult} and dispatched by {@link dispatchPromoteHooks} after
 * the step resolves, so a step replay can never double-fire the hooks.
 */
export async function runPromoteIngest(
  rc: PromoteRunCtx,
  payload: PromotePayload,
  deps: PromoteIngestDeps = {},
  opts: PromoteIngestOptions = {},
): Promise<PromoteIngestResult> {
  const dbFor = deps.dbFor ?? getDb;
  // Anchor the D1 session at `'first-primary'` so the plan's pre-write reads see
  // the latest version (no spurious unique-constraint conflicts, no wrong
  // create/update branch). The Hono-only `writeDb` helper can't be used here —
  // there is no request context — and `bookmarkMiddleware` no longer applies to
  // this path, so the outbound bookmark rides `PromoteIngestResult` instead. (AECI-250)
  const dbCtx = dbFor(rc.env, { bookmark: null, constraint: 'first-primary' });
  const { db } = dbCtx;

  // One timestamp for the whole run, so every row this ingest promotes shares a
  // first-promote instant (AECI-581 / §13 D6 — see the product branches below).
  const promotedAtIso = new Date().toISOString();

  // ── REPLAY SHORT-CIRCUIT (AECI-571) ──────────────────────────────────────
  // One indexed primary-key lookup so the common replay case never re-plans. It is the
  // FIRST query on this session — exactly what the `'first-primary'` anchor above
  // covers — so a hit is strongly consistent and a miss can never be a lagging
  // replica's miss. This is an OPTIMIZATION, not the guard: two attempts racing can
  // both miss here, and the in-batch primary key below is what makes that safe.
  if (opts.jobId) {
    const prior = await db.query.promoteJobs.findFirst({
      where: eq(promoteJobs.jobId, opts.jobId),
    });
    if (prior) return replayPromoteJob(rc, dbCtx, opts.jobId, prior.result, 'pre-read');
  }

  // ── PLAN: reads + id generation. Writes are accumulated, not executed. ──
  const stmts: BatchStmt[] = [];
  const auditEntries: AuditLogEntry[] = [];
  const audit = (entry: AuditLogEntry) => auditEntries.push({ ...entry, metadata: AUDIT_META });
  const skipped: PromoteSkipped[] = [];
  // Ids the caller supplied that resolve to nothing — each one falls back to a create
  // below, and is reported post-commit so the dead pointer is visible (AECI-568).
  const staleSupabaseIds: PromoteStaleId[] = [];

  // Preload existing slugs for collision-free generation (outside the batch).
  const loadSlugs = async (col: SQLiteColumn) =>
    new Set((await db.select({ slug: col }).from(col.table as Table)).map((r) => r.slug as string));
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
    // `vendorSlugById` was loaded by `inArray` over exactly these ids, so a miss IS
    // the existence test — a supplied id absent from it names a row that is gone, and
    // updating it would write nothing (AECI-568). Fall through to the create branch.
    const existingVendorSlug = v.supabaseId ? vendorSlugById.get(v.supabaseId) : undefined;
    if (v.supabaseId && existingVendorSlug === undefined) {
      staleSupabaseIds.push({ kind: 'vendor', ref: v.ref, supabaseId: v.supabaseId });
    }
    if (v.supabaseId && existingVendorSlug !== undefined) {
      const slug = existingVendorSlug;
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

  // ── Trades (find-only resolution against the seeded closed vocabulary) ─────
  // The fourth facet (§5.5a / AECI-542) deliberately diverges from the three
  // above: `taxonomy_trades` is a GOVERNED closed vocabulary (ADR 0008 /
  // `docs/TRADES_VOCABULARY.md` §3), so a trade is resolved **find-only** —
  // never find-or-create. A curator minting `paving-contractors` alongside
  // `paving-asphalt` would split a trade page's products across two permanent
  // URLs and destroy the SEO asset the facet exists to build, so an unmatched
  // value is dropped and reported in `skipped[]` (`kind: 'trade'`), exactly like
  // an unresolvable usefulness group or claim `dataObject`. No term is ever
  // created here, so no `trade.created` audit row is possible and every result
  // is `operation: 'reused'`.
  //
  // Matching is by `slug` → `name` → `alias`, case-insensitively
  // (`TRADES_VOCABULARY.md` §4). The three passes below make that precedence
  // structural rather than incidental: an alias can never shadow another term's
  // slug or name, whatever a future vocabulary edit adds. `safeSlugify`
  // normalizes both sides and returns `null` (→ unresolvable → `skipped`) rather
  // than throwing on a reserved or empty slug.
  const resolveTrades = async (
    values: string[],
    productRef: string,
  ): Promise<{ ids: string[]; results: PromoteTaxonomyResult[] }> => {
    const rows = await db
      .select({
        id: taxonomyTrades.id,
        slug: taxonomyTrades.slug,
        name: taxonomyTrades.name,
        aliases: taxonomyTrades.aliases,
      })
      .from(taxonomyTrades);

    const byKey = new Map<string, { id: string; slug: string }>();
    const addKey = (value: string | null | undefined, row: { id: string; slug: string }) => {
      const key = value ? safeSlugify(value) : null;
      if (key && !byKey.has(key)) byKey.set(key, row);
    };
    for (const row of rows) addKey(row.slug, row);
    for (const row of rows) addKey(row.name, row);
    for (const row of rows) for (const alias of row.aliases ?? []) addKey(alias, row);

    const ids: string[] = [];
    const results: PromoteTaxonomyResult[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const key = safeSlugify(value);
      const term = key ? byKey.get(key) : undefined;
      if (!term) {
        skipped.push({
          ref: productRef,
          kind: 'trade',
          reason: `trade "${value}" did not resolve to the seeded vocabulary`,
        });
        continue;
      }
      // Two payload values may name the same term ("HVAC" and "Mechanical" both
      // resolve to `hvac-mechanical`) — collapse them so the join insert can't
      // trip the composite primary key.
      if (seen.has(term.id)) continue;
      seen.add(term.id);
      ids.push(term.id);
      results.push({ slug: term.slug, id: term.id, operation: 'reused' });
    }
    return { ids, results };
  };

  // Load the vocabulary only when the payload actually carries trades — trades are
  // sparse by design, so most promotes skip this read entirely (same gate as the
  // `anyClaims` data-object load below).
  const trades =
    p && p.trades.length
      ? await resolveTrades(p.trades, p.ref)
      : { ids: [] as string[], results: [] as PromoteTaxonomyResult[] };

  // Trades this promote DROPS from the product. The response echoes only what was
  // SET, so without this a re-promote that clears a trade would purge nothing —
  // and because the facet is publication-gated (`TRADE_PUBLISH_MIN_PRODUCTS`), a
  // removal can push a term back under the floor and change `/trades`, the facet
  // sidebar, and the sitemap (`CACHE_STRATEGY.md` §2). Only an UPDATE can have
  // prior join rows, so a create skips the read.
  let removedTradeSlugs: string[] = [];
  if (p?.supabaseId) {
    const prior = await db
      .select({ slug: taxonomyTrades.slug })
      .from(productTrades)
      .innerJoin(taxonomyTrades, eq(taxonomyTrades.id, productTrades.tradeId))
      .where(eq(productTrades.productId, p.supabaseId));
    const kept = new Set(trades.results.map((r) => r.slug));
    removedTradeSlugs = prior.map((r) => r.slug).filter((slug) => !kept.has(slug));
  }

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
    // The existence read the update branch already needed doubles as the guard: a
    // `supabaseId` with no row behind it means the review app's pointer is dead, so
    // create instead of no-op-updating a row that isn't there (AECI-568).
    const existing = p.supabaseId
      ? await db.query.products.findFirst({
          columns: { slug: true },
          where: eq(products.id, p.supabaseId),
        })
      : undefined;
    if (p.supabaseId && !existing) {
      staleSupabaseIds.push({ kind: 'product', ref: p.ref, supabaseId: p.supabaseId });
    }
    if (p.supabaseId && existing) {
      const slug = existing.slug;
      productId = p.supabaseId;
      productResult = { ref: p.ref, id: p.supabaseId, slug, operation: 'updated' };
      stmts.push(
        db
          .update(products)
          .set({
            ...compact({
              name: p.name,
              promotionStatus: 'promoted',
              usefulness: usefulnessData,
              ...productEditableData(p),
            }),
            // Set-once (AECI-581 / §13 D6). This branch re-asserts
            // `promotion_status: 'promoted'` on EVERY re-promote — `product.updated`
            // outnumbers `product.created` ~2.7:1 — so a plain `promotedAt:
            // promotedAtIso` here would mean *last* promoted and buy nothing over
            // `updated_at`. COALESCE fills only a NULL, with no extra read. Sits
            // outside `compact()` because it is an SQL expression, not a value.
            promotedAt: sql`COALESCE(${products.promotedAt}, ${promotedAtIso})`,
          })
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
          // A create IS the first promote, so there is nothing to preserve here.
          promotedAt: promotedAtIso,
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
    stmts.push(db.delete(productTrades).where(eq(productTrades.productId, pid)));
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
    // `taxonomy_trades` rows are seeded (never created here), so this insert has
    // no new-term statement to order behind — unlike the three facets above.
    if (trades.ids.length) {
      stmts.push(
        db
          .insert(productTrades)
          .values(trades.ids.map((tradeId) => ({ productId: pid, tradeId })))
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
  // `poweredById` rides along so the connector product's own page can be purged
  // too (Stage 1.5 Addendum B) — it is NOT added to `affectedProducts`, because
  // `integration_count` stays endpoint-only (count semantics is an open decision).
  const integrationEndpoints: Array<{
    result: PromoteIntegrationResult;
    sourceId: string;
    targetId: string;
    poweredById: string | null;
  }> = [];
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

    let integrationId: string;
    let result: PromoteIntegrationResult;
    // An update may MOVE an endpoint. Capture the pre-update source/target so the OLD
    // products are recomputed too (the AECI-86 drift fix); the new endpoints are added
    // below. Read pre-batch. A miss also means the id is dead, so create instead of
    // no-op-updating (AECI-568).
    const existing = intg.supabaseId
      ? await db.query.integrations.findFirst({
          columns: { sourceProductId: true, targetProductId: true },
          where: eq(integrations.id, intg.supabaseId),
        })
      : undefined;
    if (intg.supabaseId && !existing) {
      staleSupabaseIds.push({ kind: 'integration', ref: intg.ref, supabaseId: intg.supabaseId });
    }
    if (intg.supabaseId && existing) {
      affectedProducts.add(existing.sourceProductId);
      affectedProducts.add(existing.targetProductId);
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
    integrationEndpoints.push({ result, sourceId, targetId, poweredById: poweredByProductId });

    // ── Claims (replace-by-integration — §6.2) ──────────────────────────────
    // Claims attach to THIS mechanism row and are replaced to exactly match the
    // payload (same merge-by-replacement semantics as the product-join sets
    // above): clear the integration's existing claims — their attestations
    // cascade via the `attestations.claim_id ON DELETE CASCADE` FK — then
    // re-insert. Runs for every resolved integration that is an update (so an
    // empty `claims[]` clears prior claims) or that carries claims (a fresh
    // integration's delete is a harmless no-op). Statement order stays FK-safe:
    // integration → delete claims → claims → attestations → audits (last).
    // Keyed off the resolved `operation`, not off `intg.supabaseId`: a stale id took
    // the create branch above, so `integrationId` is brand new and there is nothing to
    // clear (AECI-568).
    if (result.operation === 'updated' || intg.claims.length) {
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
    for (const { sourceId, targetId, poweredById } of integrationEndpoints) {
      if (!slugByProductId.has(sourceId)) needSlugs.add(sourceId);
      if (!slugByProductId.has(targetId)) needSlugs.add(targetId);
      if (poweredById && !slugByProductId.has(poweredById)) needSlugs.add(poweredById);
    }
    if (needSlugs.size) {
      const rows = await db.query.products.findMany({
        columns: { id: true, slug: true },
        where: inArray(products.id, [...needSlugs]),
      });
      for (const row of rows) slugByProductId.set(row.id, row.slug);
    }
    for (const { result, sourceId, targetId, poweredById } of integrationEndpoints) {
      result.sourceSlug = slugByProductId.get(sourceId);
      result.targetSlug = slugByProductId.get(targetId);
      if (poweredById) result.poweredBySlug = slugByProductId.get(poweredById);
    }
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
      trades: trades.results,
    },
    skipped,
  };

  // `wrote` MUST be read here, BEFORE the ledger statement joins the batch. It means
  // "this promote changed something", and the ledger row is bookkeeping, not a change —
  // computing it after the unshift would make an all-skipped promote claim a write and
  // fire a pointless home-stats refresh. (AECI-571)
  const wrote = stmts.length > 0;

  if (opts.jobId) {
    // FIRST in the batch, deliberately: a replay then trips the primary key before any
    // duplicate row is even attempted, and the failing statement is unambiguous in the
    // error message. Safe to lead with — `promote_jobs` has no foreign keys, so it sits
    // outside the vendors → taxonomy → product → joins → integrations → audits ordering
    // contract the rest of this batch depends on.
    stmts.unshift(
      db.insert(promoteJobs).values({
        jobId: opts.jobId,
        result: buildPromoteJobLedger({
          response,
          removedTradeSlugs,
          wrote,
          auditEntries,
          staleSupabaseIds,
          affectedProducts,
        }),
      }),
    );
  }

  // ── BATCH: one atomic unit (§26.1). A replayed commit trips the `promote_jobs`
  //    primary key → the WHOLE batch rolls back and the recorded result is returned
  //    (AECI-571). A racing duplicate slug trips a UNIQUE violation → 409
  //    SLUG_CONFLICT (AECI-98); any other failure rethrows → 500.
  if (stmts.length) {
    try {
      await db.batch(stmts as BatchTuple);
    } catch (err) {
      // Checked FIRST so a replay is always reported as a replay. In practice the ledger
      // insert is statement #1, so no other violation can fire on a replay — but the
      // ordering is load-bearing rather than incidental. Do not reorder.
      if (opts.jobId && isPromoteJobDuplicate(err)) {
        const prior = await db.query.promoteJobs.findFirst({
          where: eq(promoteJobs.jobId, opts.jobId),
        });
        // The primary key tripped but the row is unreadable: that is a genuine fault,
        // not a replay we can serve. Never guess — guessing means re-planning, and
        // re-planning is the duplicate this whole change exists to prevent.
        if (!prior) throw err;
        return replayPromoteJob(rc, dbCtx, opts.jobId, prior.result, 'batch-conflict');
      }
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

  return {
    response,
    removedTradeSlugs,
    wrote,
    bookmark: dbCtx.getBookmark(),
    auditEntries,
    staleSupabaseIds,
  };
}

/**
 * The best-effort, post-commit tail of a promote: §26.5 audit forwards, edge-cache
 * purge, home-stats refresh, Algolia upsert, and the IndexNow / Google Indexing
 * pings. Every one of them is fire-and-forget through `rc.waitUntil` and self-gates
 * on its own credentials, exactly as it did when this ran off the request — the
 * promote is already committed, so nothing here may throw or delay the result.
 *
 * Called by the Workflow AFTER the commit step resolves (not from inside it), so a
 * replayed step can never double-fire these. Synchronous by design: it dispatches
 * and returns, which is what lets the job reach `complete` the instant the batch
 * commits.
 */
export function dispatchPromoteHooks(
  rc: PromoteRunCtx,
  result: PromoteIngestResult,
  deps: PromoteIngestDeps = {},
): void {
  const dbFor = deps.dbFor ?? getDb;
  const syncAlgolia = deps.syncAlgolia ?? defaultAlgoliaSync;
  const notifyIndexNow = deps.notifyIndexNow ?? defaultIndexNowNotify;
  const refreshHomeStats = deps.refreshHomeStats ?? defaultHomeStatsRefresh;
  const { response, removedTradeSlugs, auditEntries, staleSupabaseIds } = result;

  // Best-effort §26.5 audit forwards AFTER the commit, as ONE request carrying
  // every entry (AECI-666). This used to loop `logToDatadog` per entry, so a fat
  // bundle opened a dozen-plus simultaneous connections from a single invocation
  // — on its own enough to exhaust the connection budget and start losing the
  // other hooks below. `logBatchToDatadog` no-ops without `DD_API_KEY`.
  logBatchToDatadog(rc, rc.env, rc.request, auditEntries.map(auditLogEvent));

  // AECI-105: purge the edge-cache tags this promote invalidated. Best-effort,
  // post-commit; no-ops without CF creds.
  if (rc.env.CF_PURGE_API_TOKEN && rc.env.CF_ZONE_ID) {
    dispatchHook(rc, 'cache-purge', purgeAfterPromote(rc, response, removedTradeSlugs));
  }

  // AECI-305: refresh the `home.*` `stats_cache` keys the home page reads, then
  // purge `/` so its credibility strip + stats cards repaint with the new counts.
  // Those numbers come from the cache, not a live count, so without this the home
  // banner lags the catalog until the daily cron. Gate on an actual write (an
  // all-skipped promote changed nothing); best-effort, post-commit — the seam
  // never throws and self-gates the purge on CF creds.
  if (result.wrote) {
    dispatchHook(rc, 'home-stats', refreshHomeStats(rc));
  }

  // AECI-139: push the promoted records to Algolia immediately (independent
  // best-effort task). No-ops without the Algolia secrets.
  if (rc.env.ALGOLIA_APP_ID && rc.env.ALGOLIA_ADMIN_KEY) {
    dispatchHook(rc, 'algolia-sync', syncAlgolia(rc, response));
  }

  // AECI-546: resolve the publication floor for any touched trade ONCE, shared
  // by both pings below. Started here (post-commit, so the count is current) but
  // deliberately not awaited — see `resolveTradeUrlOptions`. Resumes the write's
  // session via `rc.bookmark()` so the floor re-count can't read a lagging
  // replica once D1 read replication is enabled (AECI-250).
  const tradeUrls = resolveTradeUrlOptions(
    rc,
    dbFor(rc.env, { bookmark: rc.bookmark() }).db,
    response,
    removedTradeSlugs,
  );

  // AECI-236: notify IndexNow of the affected public URLs so Bing/Yandex/…
  // re-crawl quickly (§20.2/§20.5). Best-effort, post-commit; no-ops without
  // INDEXNOW_KEY + PUBLIC_SITE_URL. Those are provisioned ONLY at launch
  // (alongside `ALLOW_INDEXING=true`): pinging IndexNow for a noindex'd site is
  // a correctness bug, so the secret's absence is the gate.
  if (rc.env.INDEXNOW_KEY && rc.env.PUBLIC_SITE_URL) {
    dispatchHook(rc, 'indexnow', notifyIndexNow(rc, response, tradeUrls));
  }

  // AECI-263: best-effort Google Indexing API ping for the SAME affected URLs
  // (§20.2). Additive to IndexNow; no-ops without the service-account creds +
  // PUBLIC_SITE_URL, which are provisioned ONLY at launch (alongside
  // `ALLOW_INDEXING=true`) — pinging Google for a noindex'd site is the same
  // correctness bug the secret's absence guards against. Never blocks the write.
  // Surface any `skipped[]` entries (§4) in Datadog: a completed job with skips is
  // a partial promote — entities the push couldn't link — that neither the metrics
  // layer nor a `status: 'complete'` poll response can otherwise reveal.
  logPromoteSkips(rc, response.skipped);

  // Surface any stale-`supabaseId` fallbacks (AECI-568): the entity was created
  // rather than updated because the id the caller sent no longer resolves. The
  // response says `created`, but only this says *why* — that the review app was
  // holding a dead pointer.
  logPromoteStaleIds(rc, staleSupabaseIds);
}

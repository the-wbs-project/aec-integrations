/**
 * Clean full Algolia reindex of a target env, run after a copy or seed (the
 * incremental cron can't self-heal a clone — it syncs by an `updated_at`
 * watermark the clone overwrites, and the referenced `scripts/algolia-bulk-sync.ts`
 * doesn't exist yet). For each entity: rebuild the complete promoted-record set
 * from the freshly-written D1, CLEAR the index (drops orphaned records a clone
 * removed — an incremental upsert can't), then repopulate via `callAlgoliaBatch`.
 *
 * Worker-safe building blocks from `@aeci/shared` (no `algoliasearch` SDK):
 * `indexNamesFor`, `mechanismRank`, `callAlgoliaBatch`, `flattenTradeAliases`.
 * Records are built from raw SQL that mirrors
 * `apps/api/src/lib/algolia-transforms.ts` field-for-field — any non-trivial
 * derivation is imported from `@aeci/shared` rather than reimplemented here
 * (`flattenTradeAliases`, AECI-545), so the two builders cannot drift. The
 * membership rule matches the sync pipeline: products/vendors index iff
 * `promotion_status = 'promoted'`; an integration iff BOTH endpoint products are.
 *
 * `clear` keeps the index's settings + replicas (it only removes records), so the
 * configured ranking/faceting survive. The brief window where the index is empty
 * between clear and repopulate is acceptable for an internal tool (the
 * zero-downtime `replaceAllObjects` needs the Node SDK).
 */
import { type AlgoliaEnv, indexNamesFor, mechanismRank } from '@aeci/shared/algolia';
import { discardResponseBody } from '@aeci/shared/response-drain';
import {
  ALGOLIA_BATCH_MAX,
  type AlgoliaBatchCredentials,
  callAlgoliaBatch,
} from '@aeci/shared/algolia-batch';
import { flattenTradeAliases } from '@aeci/shared/algolia-records';

/** Separator for `group_concat`ed taxonomy names — a multi-char token that can't
 * occur in an AEC taxonomy name. */
const SEP = '|::|';

export const REINDEX_ENTITIES = ['products', 'vendors', 'integrations'] as const;
export type ReindexEntity = (typeof REINDEX_ENTITIES)[number];

function splitNames(value: unknown): string[] {
  return typeof value === 'string' && value.length ? value.split(SEP) : [];
}

/**
 * `taxonomy_trades.aliases` is a JSON-array TEXT column, so `group_concat`ing it
 * yields `["Blacktop","Paving"]|::|["Glazier"]` — one JSON document per linked
 * trade (AECI-545). Split, then parse each chunk independently so one malformed
 * row degrades to "no aliases for that trade" instead of failing the reindex.
 * The flatten/dedupe itself is the SHARED `flattenTradeAliases`, which is what
 * keeps this raw-SQL builder byte-identical to `toAlgoliaProduct`.
 */
function parseAliasGroups(value: unknown): (string[] | null)[] {
  return splitNames(value).map((chunk) => {
    try {
      const parsed: unknown = JSON.parse(chunk);
      return Array.isArray(parsed) ? (parsed as string[]) : null;
    } catch {
      return null;
    }
  });
}

// ── Record builders (raw SQL → the @aeci/shared/algolia-records shapes) ─────────

export async function buildProductRecords(db: D1Database): Promise<Record<string, unknown>[]> {
  const { results } = await db
    .prepare(
      `SELECT
         p.id AS objectID, p.name, p.slug, p.description, p.logo_url, p.has_api_docs,
         p.integration_count, p.review_count, p.rating_overall_avg,
         (SELECT v.company_name FROM product_vendors pv JOIN vendors v ON v.id = pv.vendor_id
            WHERE pv.product_id = p.id ORDER BY pv.is_primary DESC LIMIT 1) AS vendor_name,
         (SELECT v.slug FROM product_vendors pv JOIN vendors v ON v.id = pv.vendor_id
            WHERE pv.product_id = p.id ORDER BY pv.is_primary DESC LIMIT 1) AS vendor_slug,
         (SELECT group_concat(tc.name, '${SEP}') FROM product_categories pc
            JOIN taxonomy_categories tc ON tc.id = pc.category_id WHERE pc.product_id = p.id) AS categories,
         (SELECT group_concat(ta.name, '${SEP}') FROM product_audiences pa
            JOIN taxonomy_audiences ta ON ta.id = pa.audience_id WHERE pa.product_id = p.id) AS audiences,
         (SELECT group_concat(tp.name, '${SEP}') FROM product_phases pp
            JOIN taxonomy_phases tp ON tp.id = pp.phase_id WHERE pp.product_id = p.id) AS phases,
         (SELECT group_concat(tt.name, '${SEP}') FROM product_trades pt
            JOIN taxonomy_trades tt ON tt.id = pt.trade_id WHERE pt.product_id = p.id) AS trades,
         (SELECT group_concat(tt.aliases, '${SEP}') FROM product_trades pt
            JOIN taxonomy_trades tt ON tt.id = pt.trade_id WHERE pt.product_id = p.id) AS trade_aliases
       FROM products p WHERE p.promotion_status = 'promoted'`,
    )
    .all<{
      objectID: string;
      name: string;
      slug: string;
      description: string | null;
      logo_url: string | null;
      has_api_docs: number;
      integration_count: number;
      review_count: number;
      rating_overall_avg: number | null;
      vendor_name: string | null;
      vendor_slug: string | null;
      categories: string | null;
      audiences: string | null;
      phases: string | null;
      trades: string | null;
      trade_aliases: string | null;
    }>();
  return results.map((r) => {
    const trades = splitNames(r.trades);
    return {
      objectID: r.objectID,
      name: r.name,
      slug: r.slug,
      description: r.description,
      vendor_name: r.vendor_name,
      vendor_slug: r.vendor_slug,
      categories: splitNames(r.categories),
      audiences: splitNames(r.audiences),
      phases: splitNames(r.phases),
      trades,
      trade_aliases: flattenTradeAliases(trades, parseAliasGroups(r.trade_aliases)),
      integration_count: r.integration_count,
      review_count: r.review_count,
      rating_overall_avg: r.rating_overall_avg,
      has_api_docs: Boolean(r.has_api_docs),
      logo_url: r.logo_url,
    };
  });
}

export async function buildVendorRecords(db: D1Database): Promise<Record<string, unknown>[]> {
  const { results } = await db
    .prepare(
      `SELECT
         v.id AS objectID, v.company_name, v.slug, v.description, v.headquarters,
         v.founded_year, v.logo_url,
         (SELECT count(*) FROM product_vendors pv WHERE pv.vendor_id = v.id) AS product_count,
         (SELECT count(*) FROM integrations i WHERE i.built_by_vendor_id = v.id) AS integration_count
       FROM vendors v WHERE v.promotion_status = 'promoted'`,
    )
    .all<{
      objectID: string;
      company_name: string;
      slug: string;
      description: string | null;
      headquarters: string | null;
      founded_year: number | null;
      logo_url: string | null;
      product_count: number;
      integration_count: number;
    }>();
  return results.map((r) => ({
    objectID: r.objectID,
    company_name: r.company_name,
    slug: r.slug,
    description: r.description,
    headquarters: r.headquarters,
    founded_year: r.founded_year,
    product_count: r.product_count,
    integration_count: r.integration_count,
    logo_url: r.logo_url,
  }));
}

export async function buildIntegrationRecords(db: D1Database): Promise<Record<string, unknown>[]> {
  const { results } = await db
    .prepare(
      `SELECT
         i.id AS objectID, i.mechanism_kind, i.mechanism_name, i.direction, i.description,
         sp.name AS source_product_name, sp.slug AS source_product_slug,
         tp.name AS target_product_name, tp.slug AS target_product_slug
       FROM integrations i
       JOIN products sp ON sp.id = i.source_product_id
       JOIN products tp ON tp.id = i.target_product_id
       WHERE sp.promotion_status = 'promoted' AND tp.promotion_status = 'promoted'`,
    )
    .all<{
      objectID: string;
      mechanism_kind: string | null;
      mechanism_name: string | null;
      direction: string | null;
      description: string | null;
      source_product_name: string;
      source_product_slug: string;
      target_product_name: string;
      target_product_slug: string;
    }>();
  return results.map((r) => ({
    objectID: r.objectID,
    source_product_name: r.source_product_name,
    source_product_slug: r.source_product_slug,
    target_product_name: r.target_product_name,
    target_product_slug: r.target_product_slug,
    mechanism_kind: r.mechanism_kind,
    mechanism_name: r.mechanism_name,
    direction: r.direction,
    description: r.description,
    mechanism_rank: mechanismRank(r.mechanism_kind),
  }));
}

async function buildRecords(
  db: D1Database,
  entity: ReindexEntity,
): Promise<Record<string, unknown>[]> {
  if (entity === 'products') return buildProductRecords(db);
  if (entity === 'vendors') return buildVendorRecords(db);
  return buildIntegrationRecords(db);
}

// ── Reindex ─────────────────────────────────────────────────────────────────────

interface ClearOutcome {
  ok: boolean;
  status: number;
  message?: string;
}

/** Clear all records from one index (keeps settings + replicas). Never throws. */
async function clearIndex(
  fetchImpl: typeof fetch,
  creds: AlgoliaBatchCredentials,
  indexName: string,
): Promise<ClearOutcome> {
  if (!creds.appId || !creds.apiKey) {
    return { ok: false, status: 0, message: 'algolia_credentials_missing' };
  }
  const url = `https://${creds.appId}.algolia.net/1/indexes/${encodeURIComponent(indexName)}/clear`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'x-algolia-application-id': creds.appId,
        'x-algolia-api-key': creds.apiKey,
        'content-type': 'application/json',
      },
    });
    // NEITHER branch reads the body, and an unread body holds its connection
    // open; a Worker invocation may hold only a bounded number, and past that
    // the runtime cancels the stalled responses into `fetch` promises that never
    // settle (AECI-666). A bulk reindex calls this once per entity.
    discardResponseBody(res);
    return res.ok
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, message: res.statusText || 'algolia_clear_failed' };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : 'algolia_network_error',
    };
  }
}

export interface EntityReindexResult {
  entity: ReindexEntity;
  indexName: string;
  records: number;
  cleared: boolean;
  added: boolean;
  error?: string;
}

export type ReindexResult =
  | { skipped: true; reason: string; entities: [] }
  | { skipped: false; entities: EntityReindexResult[] };

async function reindexEntity(
  fetchImpl: typeof fetch,
  creds: AlgoliaBatchCredentials,
  indexName: string,
  entity: ReindexEntity,
  records: Record<string, unknown>[],
): Promise<EntityReindexResult> {
  const cleared = await clearIndex(fetchImpl, creds, indexName);
  let added = true;
  let error = cleared.ok ? undefined : cleared.message;

  for (let i = 0; i < records.length; i += ALGOLIA_BATCH_MAX) {
    const requests = records
      .slice(i, i + ALGOLIA_BATCH_MAX)
      .map((body) => ({ action: 'updateObject' as const, body }));
    const outcome = await callAlgoliaBatch(fetchImpl, creds, indexName, requests);
    if (!outcome.ok) {
      added = false;
      error = outcome.message;
      break;
    }
  }
  return { entity, indexName, records: records.length, cleared: cleared.ok, added, error };
}

/** Rebuild a target env's indexes from its current D1 contents. `entities`
 * defaults to all three (a copy); pass `['products']` after a seed (only ratings
 * changed). Graceful no-op if the env's Algolia key is absent. */
export async function reindexEnv(
  db: D1Database,
  fetchImpl: typeof fetch,
  creds: AlgoliaBatchCredentials,
  env: AlgoliaEnv,
  entities: readonly ReindexEntity[] = REINDEX_ENTITIES,
): Promise<ReindexResult> {
  if (!creds.appId || !creds.apiKey) {
    return { skipped: true, reason: 'algolia_credentials_missing', entities: [] };
  }
  const names = indexNamesFor(env);
  const results: EntityReindexResult[] = [];
  for (const entity of entities) {
    const records = await buildRecords(db, entity);
    results.push(await reindexEntity(fetchImpl, creds, names[entity], entity, records));
  }
  return { skipped: false, entities: results };
}

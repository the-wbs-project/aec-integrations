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
 * (`flattenTradeAliases`, AECI-545). Sharing derivations does not stop a builder
 * forgetting a whole FIELD, which is how the vendor builder once shipped without a
 * field the API emitted (AECI-1038, the since-removed `verified`, AECI-1266), so
 * `apps/api/src/lib/algolia-builder-parity.spec.ts` builds the same D1 rows
 * through both paths and asserts the records equal. The
 * membership rule matches the sync pipeline: products/vendors index iff
 * `promotion_status = 'promoted'`; an integration iff BOTH endpoint products are.
 *
 * `clear` keeps the index's settings + replicas (it only removes records), so the
 * configured ranking/faceting survive. The brief window where the index is empty
 * between clear and repopulate is acceptable for an internal tool (the
 * zero-downtime `replaceAllObjects` needs the Node SDK).
 */
import {
  CONNECTOR_EVIDENCED_MECHANISM_RANK,
  indexNamesFor,
  mechanismRank,
  type AlgoliaEnv,
} from '@aeci/shared/algolia';
import { discardResponseBody } from '@aeci/shared/response-drain';
import {
  ALGOLIA_BATCH_MAX,
  type AlgoliaBatchCredentials,
  callAlgoliaBatch,
} from '@aeci/shared/algolia-batch';
import {
  algoliaSortKey,
  flattenTradeAliases,
  productSortFields,
} from '@aeci/shared/algolia-records';
import {
  correctionFor,
  publicCompanyFact,
  type StoredCorrection,
} from '@aeci/shared/company-facts-display';
import { listingTierField, productListingTier, vendorListingTier } from '@aeci/shared/listing-tier';
import {
  ddlHasRetiredColumn,
  EVIDENCED_PAIRS_DDL_QUERY,
  evidencedPairsDdlOrThrow,
  INTEGRATIONS_DDL_QUERY,
  integrationsDdlOrThrow,
  liveEvidencedPairSqlIf,
  liveIntegrationSqlIf,
} from '@aeci/shared/live-integration';
import {
  ddlHasHiddenColumn,
  listingDdlOrThrow,
  PRODUCTS_DDL_QUERY,
  VENDORS_DDL_QUERY,
  visibleProductSqlIf,
  visibleVendorSqlIf,
} from '@aeci/shared/listing-visibility';

/**
 * The same probe for `connector_evidenced_pairs`, whose `retired_at` is migration
 * 0049's (AECI-1091). Probed on its own because the two migrations reach a tier at
 * different promotes.
 */
async function hasEvidencedRetiredColumn(db: D1Database): Promise<boolean> {
  const row = await db.prepare(EVIDENCED_PAIRS_DDL_QUERY).first<{ sql: string }>();
  return ddlHasRetiredColumn(evidencedPairsDdlOrThrow(row?.sql));
}

/**
 * Whether this tier's `integrations` has migration 0044's `retired_at` yet (AECI-1010).
 * The datatool runs against deployed tiers whose migration can lag, and a query naming
 * a missing column fails. Without the column no row is retired, so the predicate
 * degrades to always-true. Same probe as the prune's.
 */
async function hasRetiredColumn(db: D1Database): Promise<boolean> {
  const row = await db.prepare(INTEGRATIONS_DDL_QUERY).first<{ sql: string }>();
  return ddlHasRetiredColumn(integrationsDdlOrThrow(row?.sql));
}

/**
 * Whether this tier's `products` / `vendors` has migration 0113's `hidden_at` yet
 * (AECI-1238). Without it no listing is hidden, so the predicates degrade to
 * always-true. An empty read throws, as the retired probes do.
 */
async function hasHiddenColumn(db: D1Database, table: 'products' | 'vendors'): Promise<boolean> {
  const row = await db
    .prepare(table === 'products' ? PRODUCTS_DDL_QUERY : VENDORS_DDL_QUERY)
    .first<{ sql: string }>();
  return ddlHasHiddenColumn(listingDdlOrThrow(row?.sql, table));
}

/**
 * The active value hides on one entity type (AECI-1238 §11d.7), by entity id, so a
 * rebuild nulls a hidden value exactly as the Worker's transforms do. A tier whose
 * migration 0114 has not run has no `field_hides` table, and so no hides: the probe
 * reads `sqlite_master` and an absent table reads as none.
 */
async function activeFieldHides(
  db: D1Database,
  entityType: 'vendor' | 'product' | 'integration' | 'connector_evidenced_pair',
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const table = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'field_hides'`)
    .first<{ name: string }>();
  if (!table) return out;
  // Every active hide, filtered here: the table holds a handful of admin rows, and a
  // constant statement needs no bound value (the parity harness's D1 shim has no `bind`).
  const { results: all } = await db
    .prepare(`SELECT entity_type, entity_id, field FROM field_hides WHERE cleared_at IS NULL`)
    .all<{ entity_type: string; entity_id: string; field: string }>();
  const results = all.filter((row) => row.entity_type === entityType);
  for (const row of results) {
    const set = out.get(row.entity_id) ?? new Set<string>();
    set.add(row.field);
    out.set(row.entity_id, set);
  }
  return out;
}

/**
 * AECi's corrections on a vendor's headquarters and founded year, by vendor id
 * (AECI-1635, §6.23). Every row, lifted or not: whether one still holds is decided by
 * the shared `correctionFor`, the same rule the Worker's `toFieldCorrections` applies.
 * A constant statement, because the parity harness's D1 shim has no `bind`.
 */
async function vendorFactCorrections(db: D1Database): Promise<Map<string, StoredCorrection[]>> {
  const out = new Map<string, StoredCorrection[]>();
  const table = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'field_overrides'`)
    .first<{ name: string }>();
  if (!table) return out;
  const { results } = await db
    .prepare(
      `SELECT id, entity_id, field, value, source_url, set_at FROM field_overrides
         WHERE entity_type = 'vendor' AND field IN ('headquarters', 'founded_year')`,
    )
    .all<{
      id: string;
      entity_id: string;
      field: string;
      value: string | null;
      source_url: string | null;
      set_at: string;
    }>();
  for (const row of results) {
    let value: unknown;
    try {
      value = row.value === null ? null : JSON.parse(row.value);
    } catch {
      // An unreadable value holds against no live value, so it lets nothing show.
      value = undefined;
    }
    const list = out.get(row.entity_id) ?? [];
    list.push({
      id: row.id,
      field: row.field,
      value,
      sourceUrl: row.source_url,
      setAt: row.set_at,
    });
    out.set(row.entity_id, list);
  }
  return out;
}

/** `value`, or `null` when the record's `field` is hidden. The listing tier keeps
 *  reading the stored value, as the Worker's `toAlgolia*` mappers do. */
function unlessHidden<T>(
  hides: ReadonlyMap<string, ReadonlySet<string>>,
  id: string,
  field: string,
  value: T,
): T | null {
  return hides.get(id)?.has(field) ? null : value;
}

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
  const productsHidden = await hasHiddenColumn(db, 'products');
  const hides = await activeFieldHides(db, 'product');
  const { results } = await db
    .prepare(
      `SELECT
         p.id AS objectID, p.name, p.slug, p.description, p.logo_url, p.website,
         p.integration_count, p.review_count, p.rating_overall_avg,
         p.created_at, p.updated_at, p.product_role,
         -- AECI-1618: the claimed test, the same as lib/claimed-vendors.ts.
         EXISTS (SELECT 1 FROM product_vendors cpv JOIN vendors cv ON cv.id = cpv.vendor_id
            WHERE cpv.product_id = p.id AND cv.owned_at IS NOT NULL
              AND cv.claim_ended_at IS NULL) AS claimed,
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
       -- AECI-1238: a hidden product is not a member, so a rebuild must not re-add it.
       FROM products p WHERE p.promotion_status = 'promoted'
         AND ${visibleProductSqlIf('p', productsHidden)}`,
    )
    .all<{
      objectID: string;
      name: string;
      slug: string;
      description: string | null;
      logo_url: string | null;
      website: string | null;
      integration_count: number;
      review_count: number;
      rating_overall_avg: number | null;
      created_at: string;
      updated_at: string;
      product_role: string;
      claimed: number;
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
    const categories = splitNames(r.categories);
    return {
      objectID: r.objectID,
      name: r.name,
      slug: r.slug,
      description: unlessHidden(hides, r.objectID, 'description', r.description),
      vendor_name: r.vendor_name,
      vendor_slug: r.vendor_slug,
      categories,
      audiences: splitNames(r.audiences),
      phases: splitNames(r.phases),
      trades,
      trade_aliases: flattenTradeAliases(trades, parseAliasGroups(r.trade_aliases)),
      // AECI-825 — byte-identical to `toAlgoliaProduct`'s `name_sort`.
      name_sort: algoliaSortKey(r.name),
      integration_count: r.integration_count,
      review_count: r.review_count,
      rating_overall_avg: r.rating_overall_avg,
      // Identical to `toAlgoliaProduct` through the shared helper.
      ...productSortFields({
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        reviewCount: r.review_count,
        ratingOverallAvg: r.rating_overall_avg,
      }),
      // AECI-1618: only while claimed, as `toAlgoliaProduct`. The tier below reads the
      // stored logo, so hiding one cannot move a rank.
      logo_url: r.claimed ? r.logo_url : null,
      // AECI-636 — the SHARED computation, so this builder and `toAlgoliaProduct`
      // cannot disagree about a product's tier. Omitted, not null, when absent.
      ...listingTierField(
        productListingTier({
          name: r.name,
          description: r.description,
          categories,
          website: r.website,
          logo_url: r.logo_url,
        }),
      ),
      // AECI-1086 — display only, never ranked. Identical to `toAlgoliaProduct`;
      // the column is NOT NULL with a CHECK, so the raw value is always a role.
      product_role: r.product_role,
    };
  });
}

export async function buildVendorRecords(db: D1Database): Promise<Record<string, unknown>[]> {
  const retiredColumn = await hasRetiredColumn(db);
  const pairsRetiredColumn = await hasEvidencedRetiredColumn(db);
  const productsHidden = await hasHiddenColumn(db, 'products');
  const vendorsHidden = await hasHiddenColumn(db, 'vendors');
  const hides = await activeFieldHides(db, 'vendor');
  const corrections = await vendorFactCorrections(db);
  const { results } = await db
    .prepare(
      `SELECT
         v.id AS objectID, v.company_name, v.slug, v.description, v.headquarters,
         v.founded_year, v.logo_url, v.website, v.owned_at,
         -- AECI-1635: the §6.23 display rule's inputs, the same columns the Worker reads.
         v.headquarters_source_url, v.headquarters_checked_at,
         v.founded_year_source_url, v.founded_year_checked_at,
         -- AECI-1618: the claimed test, the same as lib/claimed-vendors.ts.
         (v.owned_at IS NOT NULL AND v.claim_ended_at IS NULL) AS claimed,
         -- AECI-1238: visible products only, as the Worker's vendor rule counts them.
         (SELECT count(*) FROM product_vendors pv JOIN products vp ON vp.id = pv.product_id
            WHERE pv.vendor_id = v.id AND ${visibleProductSqlIf('vp', productsHidden)}) AS product_count,
         -- AECI-721 / §13.5 item 6: datatool's independent copy of the VENDOR rule,
         -- which counts what the vendor BUILT rather than reading the denormalized
         -- product column. Both tables, or connector vendors' counts collapse.
         -- Live rows only, in both tables (AECI-1010, AECI-1091).
         ((SELECT count(*) FROM integrations i
             WHERE i.built_by_vendor_id = v.id
               AND ${liveIntegrationSqlIf('i', retiredColumn, productsHidden)})
          + (SELECT count(*) FROM connector_evidenced_pairs cep
             WHERE cep.built_by_vendor_id = v.id
               AND ${liveEvidencedPairSqlIf('cep', pairsRetiredColumn, productsHidden)}))
           AS integration_count
       FROM vendors v WHERE v.promotion_status = 'promoted'
         AND ${visibleVendorSqlIf('v', vendorsHidden)}`,
    )
    .all<{
      objectID: string;
      company_name: string;
      slug: string;
      description: string | null;
      headquarters: string | null;
      founded_year: number | null;
      logo_url: string | null;
      website: string | null;
      owned_at: string | null;
      headquarters_source_url: string | null;
      headquarters_checked_at: string | null;
      founded_year_source_url: string | null;
      founded_year_checked_at: string | null;
      claimed: number;
      product_count: number;
      integration_count: number;
    }>();
  return results.map((r) => {
    // AECI-1635: the §6.23 display rule, through the same shared helper as
    // `toAlgoliaVendor`. The listing tier below still reads the stored value.
    const rows = corrections.get(r.objectID) ?? [];
    const fact = <T>(
      field: string,
      value: T | null,
      sourceUrl: string | null,
      checkedAt: string | null,
    ): T | null =>
      unlessHidden(
        hides,
        r.objectID,
        field,
        publicCompanyFact(value, {
          sourceUrl,
          checkedAt,
          ownedAt: r.owned_at,
          correction: correctionFor(rows, field, value),
        }),
      );
    return {
      objectID: r.objectID,
      company_name: r.company_name,
      // AECI-825 — byte-identical to `toAlgoliaVendor`'s `company_name_sort`.
      company_name_sort: algoliaSortKey(r.company_name),
      slug: r.slug,
      // No `verified` (AECI-1266): the plan mirror is never public. Parity with
      // `toAlgoliaVendor` is asserted by `apps/api/src/lib/algolia-builder-parity.spec.ts`.
      description: unlessHidden(hides, r.objectID, 'description', r.description),
      headquarters: fact(
        'headquarters',
        r.headquarters,
        r.headquarters_source_url,
        r.headquarters_checked_at,
      ),
      founded_year: fact(
        'founded_year',
        r.founded_year,
        r.founded_year_source_url,
        r.founded_year_checked_at,
      ),
      product_count: r.product_count,
      integration_count: r.integration_count,
      // AECI-1618: only while claimed, as `toAlgoliaVendor`.
      logo_url: r.claimed ? r.logo_url : null,
      // AECI-636 — shared with `toAlgoliaVendor`. Content inputs only.
      ...listingTierField(
        vendorListingTier({
          company_name: r.company_name,
          description: r.description,
          headquarters: r.headquarters,
          website: r.website,
          logo_url: r.logo_url,
        }),
      ),
    };
  });
}

/**
 * The `integrations` index, from BOTH delivered-tier tables (AECI-721 / §13.1).
 *
 * datatool keeps its own copy of the rule the API applies in `algolia-sync.ts` —
 * one `UNION ALL` here against two builder arms there, but the same membership
 * (both endpoints promoted) and the same records. The evidenced arm re-orients
 * the canonical pair and pins `mechanism_rank` to the connector-delivered weight;
 * see `toAlgoliaEvidencedPair` for why that is not `mechanismRank(null)`.
 *
 * A bulk reindex that emitted only `integrations` would DELETE nothing but would
 * leave the 19 migrated edges as orphan records the drift guard then reports
 * forever — this is a full-index rebuild, so a missing arm is a missing record.
 */
export async function buildIntegrationRecords(db: D1Database): Promise<Record<string, unknown>[]> {
  const retiredColumn = await hasRetiredColumn(db);
  const pairsRetiredColumn = await hasEvidencedRetiredColumn(db);
  const productsHidden = await hasHiddenColumn(db, 'products');
  const [integrationHides, pairHides] = await Promise.all([
    activeFieldHides(db, 'integration'),
    activeFieldHides(db, 'connector_evidenced_pair'),
  ]);
  const { results } = await db
    .prepare(
      `SELECT
         i.id AS objectID, i.mechanism_kind, i.mechanism_name,
         -- AECI-921: collapsed to the CONTEXT-FREE spelling the index facets on,
         -- exactly as the Worker's \`toAlgoliaIntegration\` does. The column now
         -- stores \`a_to_b\`/\`b_to_a\`/\`both\`; selecting it raw here would make the
         -- two writers of this index disagree about the same attribute, which the
         -- drift guard reports as every integration record being stale, forever.
         CASE i.direction
           WHEN 'a_to_b' THEN 'one-way'
           WHEN 'b_to_a' THEN 'one-way'
           WHEN 'both' THEN 'bidirectional'
         END AS direction,
         i.description,
         sp.name AS source_product_name, sp.slug AS source_product_slug,
         tp.name AS target_product_name, tp.slug AS target_product_slug,
         0 AS is_evidenced
       FROM integrations i
       JOIN products sp ON sp.id = i.source_product_id
       JOIN products tp ON tp.id = i.target_product_id
       -- AECI-1010: a retired row is not a member, so a full rebuild must not
       -- re-add it. Same predicate as the Worker sync's upsert arm.
       WHERE sp.promotion_status = 'promoted' AND tp.promotion_status = 'promoted'
         AND ${liveIntegrationSqlIf('i', retiredColumn, productsHidden)}
       UNION ALL
       SELECT
         cep.id AS objectID,
         NULL AS mechanism_kind,
         cep.mechanism_name,
         CASE cep.direction
           WHEN 'a_to_b' THEN 'one-way'
           WHEN 'b_to_a' THEN 'one-way'
           WHEN 'both' THEN 'bidirectional'
         END AS direction,
         cep.description,
         CASE WHEN cep.direction = 'b_to_a' THEN pb.name ELSE pa.name END AS source_product_name,
         CASE WHEN cep.direction = 'b_to_a' THEN pb.slug ELSE pa.slug END AS source_product_slug,
         CASE WHEN cep.direction = 'b_to_a' THEN pa.name ELSE pb.name END AS target_product_name,
         CASE WHEN cep.direction = 'b_to_a' THEN pa.slug ELSE pb.slug END AS target_product_slug,
         1 AS is_evidenced
       FROM connector_evidenced_pairs cep
       JOIN products pa ON pa.id = cep.product_a_id
       JOIN products pb ON pb.id = cep.product_b_id
       -- AECI-1091: the same rule on the evidenced arm. A retired pair is not re-added.
       WHERE pa.promotion_status = 'promoted' AND pb.promotion_status = 'promoted'
         AND ${liveEvidencedPairSqlIf('cep', pairsRetiredColumn, productsHidden)}`,
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
      is_evidenced: number;
    }>();
  return results.map((r) => {
    const hides = r.is_evidenced ? pairHides : integrationHides;
    return {
      objectID: r.objectID,
      source_product_name: r.source_product_name,
      source_product_slug: r.source_product_slug,
      target_product_name: r.target_product_name,
      target_product_slug: r.target_product_slug,
      mechanism_kind: r.mechanism_kind,
      mechanism_name: unlessHidden(hides, r.objectID, 'mechanism_name', r.mechanism_name),
      direction: r.direction,
      description: unlessHidden(hides, r.objectID, 'description', r.description),
      mechanism_rank: r.is_evidenced
        ? CONNECTOR_EVIDENCED_MECHANISM_RANK
        : mechanismRank(r.mechanism_kind),
    };
  });
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

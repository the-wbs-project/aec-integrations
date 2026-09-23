/**
 * The retrieval corpus: one markdown document per published product.
 *
 * ── THIS IS THE LARGEST LEAK SURFACE IN THE SPIKE ───────────────────────────
 * A tool result is transient — it is built, read once by the model, and gone. A
 * corpus document is not. It is written to R2, indexed by AI Search, and then
 * served back to the model as a retrieved passage on every future question. So a
 * column that leaks in here PERSISTS until the next reindex, and it leaks into
 * conversations nobody was watching when the mistake was made.
 *
 * Two rules follow, and they are the reason this file looks verbose:
 *
 *  1. **Every rendered field is checked against `src/lib/columns.ts`.** Nothing
 *     on {@link DENIED_COLUMNS} is selected and nothing on
 *     {@link DENIED_TABLES} is read. `corpus.spec.ts` asserts both — the column
 *     rule over generated OUTPUT (data-driven off the denylist, the same shape
 *     as `tools/index.spec.ts`), the table rule over this file's SQL text.
 *
 *  2. **The document is built from an EXPLICIT ALLOWLIST of fields, never by
 *     iterating a row object.** {@link renderProductDocument} names every field
 *     it renders, one at a time. That is deliberate: `products` gains columns
 *     upstream (`usefulness_source` and `logo_source` are both recent), and a
 *     `for (const [k, v] of Object.entries(row))` renderer would publish the
 *     next one automatically, silently, and permanently. Adding a field to a
 *     document must be an edit to this file.
 *
 * ── SQL RULES (the same four `find_products` obeys) ─────────────────────────
 * Hand-written, parameterised, explicit column lists, no `SELECT *`. Name
 * ordering is `COLLATE NOCASE` with an id tiebreaker (AECI-825 / AECI-99) via
 * `src/lib/collation.ts`. The model never reaches this module at all — the
 * reindex route is operator-triggered — but the rules are the same so that a
 * future reader does not have to work out which file is allowed to relax them.
 *
 * ── THE INTEGRATION LIST READS BOTH TABLES ──────────────────────────────────
 * The delivered tier is split across `integrations` and
 * `connector_evidenced_pairs` (`STAGE_1_5_SPEC.md` §13.1, AECI-721). A
 * single-table version passes its own happy-path test and is wrong the moment
 * connector rows exist, which they have in production since AECI-764. The rule
 * and the `connector-evidenced` bucket label are taken from
 * `src/tools/count-integrations.ts` so the corpus and the tool cannot disagree;
 * membership is "both endpoints promoted", copied from
 * `apps/api/src/lib/algolia-drift-deps.ts`.
 */
import { liveEvidencedPairSql, liveIntegrationSql } from '@aeci/shared/live-integration';

import { CONNECTOR_EVIDENCED_BUCKET, UNKNOWN_MECHANISM_BUCKET } from '../tools/count-integrations';
import { orderByTextThenId, textThenIdTerms } from './collation';

/**
 * `promotion_status` value that marks a row live on the public site.
 *
 * The published predicate is `promotion_status = 'promoted'`, spelled exactly
 * this way at every read surface in `apps/api` — `lib/algolia-drift-deps.ts:40`,
 * `lib/algolia-sync.ts:60`, `lib/data-quality.ts:82`, `lib/metrics-snapshot.ts`
 * — and already mirrored in `src/tools/find-products.ts`. It is a local constant
 * in each of those modules rather than a shared export, so this mirrors the
 * constant rather than inventing a helper.
 */
const PROMOTED = 'promoted';

/** Key prefix for every corpus object in the R2 bucket. */
export const CORPUS_PREFIX = 'products/';

/**
 * AI Search refuses a source file above 4 MB
 * (https://developers.cloudflare.com/ai-search/platform/limits-pricing/). A
 * document over the ceiling is SKIPPED and reported rather than written, because
 * writing it would succeed at R2 and then fail invisibly at index time.
 */
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

/** The R2 object key for one product's document. */
export function corpusKey(slug: string): string {
  return `${CORPUS_PREFIX}${slug}.md`;
}

/**
 * The five custom metadata fields, and THE WHOLE BUDGET IS SPENT.
 *
 * AI Search allows a maximum of **5 custom metadata fields per instance**, and
 * changing the schema triggers a full re-index of every document
 * (https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/).
 * So a sixth key is not an addition, it is a design change: something here has to
 * come out first, and every already-indexed document has to be rebuilt. Note in
 * particular that there is NO `title` key — a retrieved passage's title is
 * recovered from the document text, not from metadata.
 *
 * Values are strings because R2 `customMetadata` is `Record<string, string>` and
 * AI Search reads it through the S3-compatible `x-amz-meta-*` headers. Only the
 * first 64 UTF-8 bytes of a string are filterable, which is why `vendor` carries
 * the vendor SLUG rather than the company name.
 */
export type CorpusMetadata = {
  /** Document class. Constant today; the seam for a future non-product doc. */
  type: 'product';
  slug: string;
  /** Primary vendor slug, or {@link UNKNOWN_VENDOR} when there is none. */
  vendor: string;
  /** `application` | `connector` | `hybrid`. */
  role: string;
  /** `products.updated_at`, ISO-8601. */
  updated_at: string;
};

/** The five keys, as data, so a spec can assert the budget rather than eyeball it. */
export const CORPUS_METADATA_KEYS = ['type', 'slug', 'vendor', 'role', 'updated_at'] as const;

/** AI Search's documented ceiling on custom metadata fields per instance. */
export const MAX_CUSTOM_METADATA_FIELDS = 5;

/** Metadata `vendor` value for a product with no promoted primary vendor. */
export const UNKNOWN_VENDOR = 'unknown';

/** One rendered document, ready to `put()`. */
export type CorpusDocument = {
  key: string;
  slug: string;
  markdown: string;
  metadata: CorpusMetadata;
};

// ───────────────────────────────────────────────────────────────────────────
// Row shapes. Each is the EXACT column list its statement selects.
// ───────────────────────────────────────────────────────────────────────────

type ProductRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  website: string | null;
  api_docs_url: string | null;
  has_api_docs: number;
  product_role: string;
  usefulness: string | null;
  updated_at: string;
  vendor_slug: string | null;
  vendor_name: string | null;
};

type TermRow = { product_id: string; facet: string; term_name: string; term_slug: string };

type EdgeRow = {
  product_id: string;
  partner_slug: string;
  partner_name: string;
  mechanism: string;
  connector_name: string | null;
  edge_id: string;
};

/** The assembled, still-unrendered input for one document. */
export type ProductCorpusInput = {
  product: ProductRow;
  terms: TermRow[];
  edges: EdgeRow[];
};

// ───────────────────────────────────────────────────────────────────────────
// SQL
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every published product, with its primary vendor.
 *
 * The vendor join is restricted to PROMOTED vendors, the same guard
 * `find_products` uses, so an unpromoted company name cannot ride out on a
 * promoted product.
 */
const PRODUCTS_SQL = `
SELECT p.id AS id,
       p.slug AS slug,
       p.name AS name,
       p.description AS description,
       p.website AS website,
       p.api_docs_url AS api_docs_url,
       p.has_api_docs AS has_api_docs,
       p.product_role AS product_role,
       p.usefulness AS usefulness,
       p.updated_at AS updated_at,
       v.slug AS vendor_slug,
       v.company_name AS vendor_name
FROM products p
LEFT JOIN product_vendors pv ON pv.product_id = p.id AND pv.is_primary = 1
LEFT JOIN vendors v ON v.id = pv.vendor_id AND v.promotion_status = ?
WHERE p.promotion_status = ?
${orderByTextThenId('p.name', 'p.id')}
`;

/**
 * All four taxonomy facets for all published products, in ONE statement.
 *
 * Per-product queries would be four D1 round trips per product; on a catalogue
 * of hundreds that is the shape that turns a reindex into a timeout. Four
 * compound terms, under D1's five-term ceiling on a compound SELECT.
 */
const TERMS_SQL = `
SELECT pc.product_id AS product_id, 'categories' AS facet, tc.name AS term_name, tc.slug AS term_slug
FROM product_categories pc
JOIN taxonomy_categories tc ON tc.id = pc.category_id
JOIN products p ON p.id = pc.product_id AND p.promotion_status = ?

UNION ALL

SELECT pa.product_id, 'audiences', ta.name, ta.slug
FROM product_audiences pa
JOIN taxonomy_audiences ta ON ta.id = pa.audience_id
JOIN products p ON p.id = pa.product_id AND p.promotion_status = ?

UNION ALL

SELECT pp.product_id, 'phases', tp.name, tp.slug
FROM product_phases pp
JOIN taxonomy_phases tp ON tp.id = pp.phase_id
JOIN products p ON p.id = pp.product_id AND p.promotion_status = ?

UNION ALL

SELECT pt.product_id, 'trades', tt.name, tt.slug
FROM product_trades pt
JOIN taxonomy_trades tt ON tt.id = pt.trade_id
JOIN products p ON p.id = pt.product_id AND p.promotion_status = ?

ORDER BY product_id ASC, facet ASC, ${textThenIdTerms('term_name', 'term_slug')}
`;

/**
 * Every delivered edge, emitted ONCE PER ENDPOINT so the grouping key is the
 * product the document belongs to.
 *
 * Four arms, not two: an edge is a fact about both of its endpoints, so each of
 * the two tables contributes a source-side and a target-side row. Written as a
 * UNION rather than an `OR` across the endpoint columns for the reason
 * `apps/api/src/lib/connector-reach.ts` records — SQLite uses neither index
 * through that kind of OR.
 *
 * The CONNECTOR is joined with `LEFT JOIN … AND promotion_status = ?` on
 * purpose. Its own promotion is deliberately not part of membership (the edge
 * still counts), but naming an unpromoted product in a published document would
 * surface a record the site does not show. An unpromoted connector therefore
 * yields a NULL name and the document says "via a connector".
 *
 * Every branch reads LIVE rows only: the `integrations` branches since AECI-1010,
 * the evidenced branches since AECI-1091. A retired edge stays
 * in AI Search until the next `POST /admin/reindex`, because this corpus is rebuilt
 * only on demand.
 */
const EDGES_SQL = `
SELECT src.id AS product_id,
       tgt.slug AS partner_slug,
       tgt.name AS partner_name,
       COALESCE(i.mechanism_kind, ?) AS mechanism,
       NULL AS connector_name,
       i.id AS edge_id
FROM integrations i
JOIN products src ON src.id = i.source_product_id AND src.promotion_status = ?
JOIN products tgt ON tgt.id = i.target_product_id AND tgt.promotion_status = ?
WHERE ${liveIntegrationSql('i')}

UNION ALL

SELECT tgt.id, src.slug, src.name, COALESCE(i.mechanism_kind, ?), NULL, i.id
FROM integrations i
JOIN products src ON src.id = i.source_product_id AND src.promotion_status = ?
JOIN products tgt ON tgt.id = i.target_product_id AND tgt.promotion_status = ?
WHERE ${liveIntegrationSql('i')}

UNION ALL

SELECT pa.id, pb.slug, pb.name, ?, conn.name, cep.id
FROM connector_evidenced_pairs cep
JOIN products pa ON pa.id = cep.product_a_id AND pa.promotion_status = ?
JOIN products pb ON pb.id = cep.product_b_id AND pb.promotion_status = ?
LEFT JOIN products conn ON conn.id = cep.connector_product_id AND conn.promotion_status = ?
WHERE ${liveEvidencedPairSql('cep')}

UNION ALL

SELECT pb.id, pa.slug, pa.name, ?, conn.name, cep.id
FROM connector_evidenced_pairs cep
JOIN products pa ON pa.id = cep.product_a_id AND pa.promotion_status = ?
JOIN products pb ON pb.id = cep.product_b_id AND pb.promotion_status = ?
LEFT JOIN products conn ON conn.id = cep.connector_product_id AND conn.promotion_status = ?
WHERE ${liveEvidencedPairSql('cep')}

ORDER BY product_id ASC, ${textThenIdTerms('partner_name', 'edge_id')}
`;

// ───────────────────────────────────────────────────────────────────────────
// Reads
// ───────────────────────────────────────────────────────────────────────────

/**
 * Read D1 and assemble one {@link ProductCorpusInput} per published product.
 *
 * Three statements for the whole catalogue, grouped in memory. Ordering comes
 * from SQL, so the grouping preserves it and nothing re-sorts here.
 */
export async function readCorpusInputs(db: D1Database): Promise<ProductCorpusInput[]> {
  const products = await db.prepare(PRODUCTS_SQL).bind(PROMOTED, PROMOTED).all<ProductRow>();

  const terms = await db
    .prepare(TERMS_SQL)
    .bind(PROMOTED, PROMOTED, PROMOTED, PROMOTED)
    .all<TermRow>();

  const edges = await db
    .prepare(EDGES_SQL)
    .bind(
      UNKNOWN_MECHANISM_BUCKET,
      PROMOTED,
      PROMOTED,
      UNKNOWN_MECHANISM_BUCKET,
      PROMOTED,
      PROMOTED,
      CONNECTOR_EVIDENCED_BUCKET,
      PROMOTED,
      PROMOTED,
      PROMOTED,
      CONNECTOR_EVIDENCED_BUCKET,
      PROMOTED,
      PROMOTED,
      PROMOTED,
    )
    .all<EdgeRow>();

  const termsByProduct = groupBy(terms.results, (r) => r.product_id);
  const edgesByProduct = groupBy(edges.results, (r) => r.product_id);

  return products.results.map((product) => ({
    product,
    terms: termsByProduct.get(product.id) ?? [],
    edges: edgesByProduct.get(product.id) ?? [],
  }));
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/** Read D1 and render every published product's document. */
export async function buildCorpus(db: D1Database): Promise<CorpusDocument[]> {
  return (await readCorpusInputs(db)).map(renderProductDocument);
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering
// ───────────────────────────────────────────────────────────────────────────

/** The stored shape of `products.usefulness` (`@aeci/shared` `ProductUsefulness`). */
type UsefulnessGroup = { slug: string; name: string; points: string[] };

/**
 * Parse `products.usefulness`, the vendor-authored "How teams use it" narrative
 * (AECI-963, `STAGE_2_5_SPEC.md` §12).
 *
 * Tolerant on purpose: the column is `text(mode: 'json')` and a malformed or
 * partially-shaped blob must drop the SECTION, never the whole document. The
 * group `name` is rendered rather than the slug because `name` is
 * server-resolved from the taxonomy row on every write path and is the label the
 * public product page interpolates verbatim.
 */
function parseUsefulness(raw: string | null): {
  audiences: UsefulnessGroup[];
  phases: UsefulnessGroup[];
} {
  if (!raw) return { audiences: [], phases: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { audiences: [], phases: [] };
  }
  if (parsed === null || typeof parsed !== 'object') return { audiences: [], phases: [] };
  const record = parsed as Record<string, unknown>;
  return {
    audiences: usefulnessGroups(record['audiences']),
    phases: usefulnessGroups(record['phases']),
  };
}

function usefulnessGroups(value: unknown): UsefulnessGroup[] {
  if (!Array.isArray(value)) return [];
  const out: UsefulnessGroup[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const g = item as Record<string, unknown>;
    const name = typeof g['name'] === 'string' ? g['name'] : null;
    const slug = typeof g['slug'] === 'string' ? g['slug'] : null;
    const points = Array.isArray(g['points'])
      ? g['points'].filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      : [];
    if ((name ?? slug) === null || points.length === 0) continue;
    out.push({ slug: slug ?? '', name: name ?? slug ?? '', points });
  }
  return out;
}

const FACET_HEADINGS: ReadonlyArray<[facet: string, heading: string]> = [
  ['categories', 'Categories'],
  ['audiences', 'Audiences'],
  ['phases', 'Project phases'],
  ['trades', 'Trades'],
];

/**
 * Render ONE product's markdown document.
 *
 * ── THE ALLOWLIST ───────────────────────────────────────────────────────────
 * Every field that reaches the document is named below, by hand:
 *
 *   products          slug, name, description, website, api_docs_url,
 *                     has_api_docs, product_role, usefulness, updated_at
 *   vendors           slug, company_name
 *   taxonomy_*        slug, name
 *   integrations      mechanism_kind, and the PARTNER product's slug + name
 *   connector_…pairs  the partner product's slug + name, and the connector's
 *                     name when the connector itself is published
 *
 * Nothing iterates the row. A column added to `products` upstream does not
 * appear here until someone edits this function, which is the entire point:
 * the corpus is written once and served back for weeks, so an accidental field
 * is not a transient mistake.
 */
export function renderProductDocument(input: ProductCorpusInput): CorpusDocument {
  const { product, terms, edges } = input;
  const lines: string[] = [];

  lines.push(`# ${product.name}`, '');

  // ── Facts block. One line per allowlisted scalar field. ──────────────────
  lines.push(`- Slug: ${product.slug}`);
  lines.push(`- Vendor: ${product.vendor_name ?? 'Not on record'}`);
  lines.push(`- Product role: ${product.product_role}`);
  lines.push(`- Website: ${product.website ?? 'Not on record'}`);
  lines.push(
    `- API documentation: ${
      product.has_api_docs ? (product.api_docs_url ?? 'Published') : 'Not published'
    }`,
  );
  lines.push(`- Catalog record updated: ${product.updated_at}`);
  lines.push('');

  lines.push('## Description', '');
  lines.push(product.description ?? 'No description on record.', '');

  // ── Taxonomy ────────────────────────────────────────────────────────────
  lines.push('## Taxonomy', '');
  for (const [facet, heading] of FACET_HEADINGS) {
    const names = terms.filter((t) => t.facet === facet).map((t) => t.term_name);
    lines.push(`- ${heading}: ${names.length > 0 ? names.join(', ') : 'None on record'}`);
  }
  lines.push('');

  // ── How teams use it (vendor-authored, AECI-963) ────────────────────────
  const usefulness = parseUsefulness(product.usefulness);
  const groups = [...usefulness.audiences, ...usefulness.phases];
  if (groups.length > 0) {
    lines.push('## How teams use it', '');
    for (const group of groups) {
      lines.push(`### ${group.name}`, '');
      for (const point of group.points) lines.push(`- ${point}`);
      lines.push('');
    }
  }

  // ── Integrations ────────────────────────────────────────────────────────
  lines.push(`## Integrations (${edges.length})`, '');
  if (edges.length === 0) {
    lines.push('No integrations on record.', '');
  } else {
    for (const edge of edges) lines.push(`- ${renderEdge(edge)}`);
    lines.push('');
  }

  return {
    key: corpusKey(product.slug),
    slug: product.slug,
    markdown: lines.join('\n'),
    metadata: {
      type: 'product',
      slug: product.slug,
      vendor: product.vendor_slug ?? UNKNOWN_VENDOR,
      role: product.product_role,
      updated_at: product.updated_at,
    },
  };
}

function renderEdge(edge: EdgeRow): string {
  const head = `${edge.partner_name} (${edge.partner_slug})`;
  if (edge.mechanism !== CONNECTOR_EVIDENCED_BUCKET) {
    return `${head} — ${edge.mechanism}`;
  }
  const via = edge.connector_name ?? 'a connector';
  return `${head} — ${CONNECTOR_EVIDENCED_BUCKET}, via ${via}`;
}

/** Byte length of a document body, for the {@link MAX_DOCUMENT_BYTES} check. */
export function documentBytes(markdown: string): number {
  return new TextEncoder().encode(markdown).length;
}

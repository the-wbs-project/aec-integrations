/**
 * `count_integrations` — one product's delivered edges, grouped by mechanism.
 *
 * ── IT MUST READ BOTH TABLES. THIS IS NOT A STYLE POINT. ─────────────────────
 * The DELIVERED tier is split across TWO tables (`STAGE_1_5_SPEC.md` §13.1,
 * AECI-721): `integrations` holds first-party and direct edges, and
 * `connector_evidenced_pairs` holds edges delivered THROUGH a connector. Every
 * read surface that counts integrations unions both, and §13.5 enumerates
 * sixteen sites that express the rule.
 *
 * A single-table version of this query still passes its own happy-path test —
 * the numbers only go wrong once rows exist on the other side, and they do:
 * production has carried real connector data since AECI-764. AECI-789 is the
 * precedent, and it was a live defect rather than a reporting one: two sites
 * that expressed the rule as an id SET instead of a count were still
 * single-table, and both hold DELETE authority.
 *
 * The membership rule is copied from `apps/api/src/lib/algolia-drift-deps.ts`:
 * an edge counts when **both endpoints are promoted**. The connector's own
 * promotion is deliberately NOT part of membership.
 *
 * ── WHY THE SECOND ARM'S BUCKET IS NOT A `mechanism_kind` ────────────────────
 * `connector_evidenced_pairs` has no `mechanism_kind` column — the mechanism IS
 * the connector. Those rows are reported under the bucket
 * {@link CONNECTOR_EVIDENCED_BUCKET}, which is labelled as a bucket and not as a
 * member of the `integrations_mechanism_kind_check` vocabulary, so nothing here
 * invents a seventh spelling of that enum (AECI-735 counts six already). The
 * ranking weight those rows carry elsewhere is 4.
 *
 * ── SQL RULES ────────────────────────────────────────────────────────────────
 * Hand-written, parameterised, explicit column list, no `SELECT *`, a bound row
 * cap, and the model supplies only a slug. The group readout is ordered by count
 * then by the bucket name — no `COLLATE NOCASE` here, because these are enum
 * tokens and lowercase by construction, where `BINARY` is already correct
 * (AECI-825's scope note).
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

import { liveEvidencedPairSql, liveIntegrationSql } from '@aeci/shared/live-integration';

/** Ceiling on returned groups. The mechanism vocabulary is seven plus one bucket. */
export const MAX_GROUPS = 20;

/** `promotion_status` value that marks a row live on the public site. */
const PROMOTED = 'promoted';

/**
 * The bucket connector-evidenced pairs are reported under. Deliberately NOT one
 * of the `mechanism_kind` enum values — that table has no such column.
 */
export const CONNECTOR_EVIDENCED_BUCKET = 'connector-evidenced';

/** Bucket for a direct edge whose `mechanism_kind` is NULL upstream. */
export const UNKNOWN_MECHANISM_BUCKET = 'unspecified';

export const CountIntegrationsInput = v.object({
  productSlug: v.pipe(
    v.string(),
    v.description('The product slug, e.g. "procore". Get one from find_products.'),
  ),
});

export type CountIntegrationsArgs = v.InferOutput<typeof CountIntegrationsInput>;

export type MechanismCount = { mechanism: string; count: number };

export type IntegrationCounts = {
  product_slug: string;
  found: boolean;
  total: number;
  by_mechanism: MechanismCount[];
};

/**
 * Both tables, one `UNION ALL` branch per endpoint column, all over the same
 * promoted-endpoint predicate. Four branches rather than an `OR` across the
 * endpoint columns for the reason `lib/connector-reach.ts` records: SQLite uses
 * neither index through that kind of OR.
 *
 * Splitting cannot double-count an edge. `integrations_distinct_endpoints_check`
 * forbids `source = target` and `connector_evidenced_pairs_canonical_order`
 * forces `product_a_id < product_b_id`, so a product sits on at most ONE side
 * of any edge and matches exactly one branch per edge.
 *
 * Every branch counts LIVE rows only: the `integrations` branches since AECI-1010,
 * the evidenced branches since AECI-1091.
 */
const COUNT_SQL = `
SELECT mechanism AS mechanism, COUNT(*) AS edge_count
FROM (
  SELECT COALESCE(i.mechanism_kind, ?) AS mechanism
  FROM integrations i
  JOIN products src ON src.id = i.source_product_id AND src.promotion_status = ?
  JOIN products tgt ON tgt.id = i.target_product_id AND tgt.promotion_status = ?
  WHERE i.source_product_id = ? AND ${liveIntegrationSql('i')}

  UNION ALL

  SELECT COALESCE(i.mechanism_kind, ?) AS mechanism
  FROM integrations i
  JOIN products src ON src.id = i.source_product_id AND src.promotion_status = ?
  JOIN products tgt ON tgt.id = i.target_product_id AND tgt.promotion_status = ?
  WHERE i.target_product_id = ? AND ${liveIntegrationSql('i')}

  UNION ALL

  SELECT ? AS mechanism
  FROM connector_evidenced_pairs cep
  JOIN products pa ON pa.id = cep.product_a_id AND pa.promotion_status = ?
  JOIN products pb ON pb.id = cep.product_b_id AND pb.promotion_status = ?
  WHERE cep.product_a_id = ? AND ${liveEvidencedPairSql('cep')}

  UNION ALL

  SELECT ? AS mechanism
  FROM connector_evidenced_pairs cep
  JOIN products pa ON pa.id = cep.product_a_id AND pa.promotion_status = ?
  JOIN products pb ON pb.id = cep.product_b_id AND pb.promotion_status = ?
  WHERE cep.product_b_id = ? AND ${liveEvidencedPairSql('cep')}
)
GROUP BY mechanism
ORDER BY edge_count DESC, mechanism ASC
LIMIT ?
`;

const PRODUCT_ID_SQL = `SELECT p.id AS id FROM products p WHERE p.slug = ? AND p.promotion_status = ?`;

export async function countIntegrations(
  db: D1Database,
  args: CountIntegrationsArgs,
): Promise<IntegrationCounts> {
  const product = await db
    .prepare(PRODUCT_ID_SQL)
    .bind(args.productSlug, PROMOTED)
    .first<{ id: string }>();

  if (!product) {
    return { product_slug: args.productSlug, found: false, total: 0, by_mechanism: [] };
  }

  const { results } = await db
    .prepare(COUNT_SQL)
    .bind(
      ...[UNKNOWN_MECHANISM_BUCKET, PROMOTED, PROMOTED, product.id],
      ...[UNKNOWN_MECHANISM_BUCKET, PROMOTED, PROMOTED, product.id],
      ...[CONNECTOR_EVIDENCED_BUCKET, PROMOTED, PROMOTED, product.id],
      ...[CONNECTOR_EVIDENCED_BUCKET, PROMOTED, PROMOTED, product.id],
      MAX_GROUPS,
    )
    .all<{ mechanism: string; edge_count: number }>();

  const by_mechanism = results.map((r) => ({ mechanism: r.mechanism, count: r.edge_count }));
  return {
    product_slug: args.productSlug,
    found: true,
    total: by_mechanism.reduce((sum, r) => sum + r.count, 0),
    by_mechanism,
  };
}

export const countIntegrationsTool = (db: D1Database) =>
  defineTool({
    name: 'count_integrations',
    description:
      "Count one product's delivered integrations, grouped by the mechanism that delivers them " +
      '(native, api, webhook, marketplace-app, iPaaS, integrator, partner). Edges delivered through ' +
      `a third-party connector are grouped under "${CONNECTOR_EVIDENCED_BUCKET}". Takes a product ` +
      'slug. Returns the total and the per-mechanism breakdown. Both endpoints of an edge must be ' +
      'published for it to count.',
    input: CountIntegrationsInput,
    async run({ data }) {
      return { output: await countIntegrations(db, data) };
    },
  });

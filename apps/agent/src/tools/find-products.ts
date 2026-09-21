/**
 * `find_products` — the agent's catalog filter, straight over the `DB` binding.
 *
 * ── THE SQL RULES THIS FILE OBEYS (all four are non-negotiable) ──────────────
 *  1. **Hand-written, parameterised, explicit column list.** No `SELECT *`. The
 *     model never supplies SQL, a table name, a column name, or a sort
 *     direction — its input reaches the statement only as bound values.
 *  2. **`COLLATE NOCASE` plus an `id` tiebreaker** on the name ordering
 *     (AECI-825 / `lib/collation.ts`). `NOCASE` calls `ADP` and `adp` EQUAL, so
 *     a capped list with no unique trailing term can drop or duplicate a row.
 *  3. **A hard row cap**, {@link MAX_ROWS}, applied as a bound `LIMIT` on every
 *     call. The model can ask for fewer, never for more.
 *  4. **Only public columns leave.** The four selected columns are the short row
 *     shape the tool documents; nothing on `src/lib/columns.ts`'s denylist is
 *     selected, and `tools/index.spec.ts` asserts that over the real output.
 *
 * Only promoted rows are visible. That is the same membership rule the public
 * site and the Algolia index use, so the agent cannot answer from a record the
 * site would not show.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

import { orderByTextThenId } from '../lib/collation';

/** Hard ceiling on rows returned, whatever the model asks for. */
export const MAX_ROWS = 25;

/** `promotion_status` value that marks a row live on the public site. */
const PROMOTED = 'promoted';

/** The closed product-role vocabulary (`products_product_role_check`). */
const PRODUCT_ROLES = ['application', 'connector', 'hybrid'] as const;

export const FindProductsInput = v.object({
  name: v.optional(
    v.pipe(v.string(), v.description('Case-insensitive substring of the product name.')),
  ),
  category: v.optional(
    v.pipe(v.string(), v.description('Category taxonomy slug, e.g. "estimating".')),
  ),
  trade: v.optional(v.pipe(v.string(), v.description('Trade taxonomy slug, e.g. "roofing".'))),
  productRole: v.optional(v.picklist(PRODUCT_ROLES)),
  hasApiDocs: v.optional(v.boolean()),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_ROWS))),
});

export type FindProductsArgs = v.InferOutput<typeof FindProductsInput>;

export type ProductRow = {
  slug: string;
  name: string;
  vendor_name: string | null;
  product_role: string;
};

/**
 * Escape a model-supplied substring for `LIKE`. `%`, `_` and the escape
 * character itself are the wildcards; without this, a search for `100%` matches
 * everything. The value still travels as a BOUND parameter — this only stops it
 * being read as a pattern.
 */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The query. Exported separately from the tool so it is testable without a Flue
 * agent session, and so the SQL is readable in one piece.
 */
export async function findProducts(db: D1Database, args: FindProductsArgs): Promise<ProductRow[]> {
  // The first bind belongs to the vendor JOIN, which precedes the WHERE clause
  // in the statement; placeholders are positional, so its value goes first.
  const joinBinds: unknown[] = [PROMOTED];
  const where: string[] = ['p.promotion_status = ?'];
  const binds: unknown[] = [PROMOTED];

  if (args.name !== undefined && args.name.trim() !== '') {
    where.push("p.name LIKE ? ESCAPE '\\'");
    binds.push(likeContains(args.name.trim()));
  }
  if (args.category !== undefined && args.category.trim() !== '') {
    where.push(
      'EXISTS (SELECT 1 FROM product_categories pc ' +
        'JOIN taxonomy_categories tc ON tc.id = pc.category_id ' +
        'WHERE pc.product_id = p.id AND tc.slug = ?)',
    );
    binds.push(args.category.trim());
  }
  if (args.trade !== undefined && args.trade.trim() !== '') {
    where.push(
      'EXISTS (SELECT 1 FROM product_trades pt ' +
        'JOIN taxonomy_trades tt ON tt.id = pt.trade_id ' +
        'WHERE pt.product_id = p.id AND tt.slug = ?)',
    );
    binds.push(args.trade.trim());
  }
  if (args.productRole !== undefined) {
    // Bound, not interpolated — and the picklist above means only the three
    // CHECK-constrained tokens can get here in the first place.
    where.push('p.product_role = ?');
    binds.push(args.productRole);
  }
  if (args.hasApiDocs !== undefined) {
    where.push('p.has_api_docs = ?');
    binds.push(args.hasApiDocs ? 1 : 0);
  }

  const limit = Math.min(args.limit ?? MAX_ROWS, MAX_ROWS);
  binds.push(limit);

  // The primary vendor is a LEFT JOIN through `product_vendors`, restricted to
  // promoted vendors so an unpromoted company name can never ride out on a
  // promoted product.
  const sql = [
    'SELECT p.slug AS slug, p.name AS name, p.product_role AS product_role,',
    '       v.company_name AS vendor_name',
    'FROM products p',
    'LEFT JOIN product_vendors pv ON pv.product_id = p.id AND pv.is_primary = 1',
    'LEFT JOIN vendors v ON v.id = pv.vendor_id AND v.promotion_status = ?',
    `WHERE ${where.join(' AND ')}`,
    orderByTextThenId('p.name', 'p.id'),
    'LIMIT ?',
  ].join('\n');

  const { results } = await db
    .prepare(sql)
    .bind(...joinBinds, ...binds)
    .all<ProductRow>();
  return results;
}

export const findProductsTool = (db: D1Database) =>
  defineTool({
    name: 'find_products',
    description:
      'Find AEC software products in the AECi catalog by name substring, category slug, trade slug, ' +
      'product role (application, connector or hybrid), and whether the product publishes API ' +
      'documentation. Every filter is optional; with none, it returns the first products by name. ' +
      'Returns a short row per product — slug, name, primary vendor name and product role — not the ' +
      `full record. Use get_product with a returned slug for detail. At most ${MAX_ROWS} rows.`,
    input: FindProductsInput,
    async run({ data }) {
      const rows = await findProducts(db, data);
      return { output: { count: rows.length, products: rows } };
    },
  });

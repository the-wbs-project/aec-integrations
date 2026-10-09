/**
 * Integration pair-page path parsing and the canonical endpoint order (AECI-929).
 *
 * A pair page (`/products/:contextSlug/integrations/:otherSlug`) is about two
 * products, and a `page_views` row has one `product_id`. AECI-929 records both
 * endpoints in `page_views.pair_product_a_id` / `pair_product_b_id` instead, and
 * derives them at INGEST from the concrete path rather than trusting the writer to
 * send them. That one rule covers all three writers at once: the SSR arrival, the
 * browser tracker's SPA hop (which sends only `{ route, navigation: 'spa' }`), and
 * a crawler's fetch, which goes through the SSR arrival path. The same parser
 * backs the one-time backfill's spec, so ingest and backfill cannot disagree on
 * what a pair path is.
 *
 * The regex is the one `apps/web/src/server/cache-tags.ts` matches the pair page
 * with. Locale prefix, query and fragment are already stripped from `path` by the
 * writers (`PageViewPayloadSchema`), so a trailing slash or an extra segment is a
 * different page and parses as no pair.
 */

const PAIR_PAGE_PATH_RE = /^\/products\/([^/]+)\/integrations\/([^/]+)$/;

/** The two slugs in URL order. `a` is the context product, `b` the other one. */
export interface PairPageSlugs {
  a: string;
  b: string;
}

/**
 * The two product slugs a pair-page path names, or `null` when the path is not a
 * pair page. Two equal slugs are not a pair page either: the API 404s that case,
 * so the row it would produce names no integration.
 */
export function parsePairPagePath(path: string): PairPageSlugs | null {
  const m = PAIR_PAGE_PATH_RE.exec(path);
  if (!m) return null;
  const a = m[1]!;
  const b = m[2]!;
  if (a === b) return null;
  return { a, b };
}

/**
 * Put two endpoint product ids into the stored order: the lower id first.
 *
 * The order is BINARY on the id (`<`), never `compareText` / `localeCompare`. An
 * id ordering is not an alphabetical display order, and CLAUDE.md keeps every
 * id ordering `BINARY` so SQL (`min`/`max` in the backfill) and JS agree on it.
 *
 * When only one side resolved it goes in the first slot. Readers never rely on
 * position: they probe both columns, which is why each has its own index.
 */
export function canonicalPairIds(
  x: string | null,
  y: string | null,
): [string | null, string | null] {
  if (x === null) return [y, null];
  if (y === null) return [x, null];
  return x < y ? [x, y] : [y, x];
}

/**
 * `ORDER BY display_order` for D1, with NULLs last (AECI-925).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * **`display_order` is nullable on every `taxonomy_*` table, and SQLite sorts NULL
 * FIRST under a plain `ASC`.** So a term with no curated position does not land at
 * the end of the list — it lands at the very top, ahead of every seeded term.
 *
 * That is not hypothetical. `resolveTaxonomy` in `routes/promote.ts` mints a
 * missing category / audience / phase from `{ id, slug, name }` alone, leaving
 * `display_order` and `description` NULL. Production picked up exactly one such
 * row — a DUPLICATE of a seeded term, which is AECI-926's problem, not this
 * module's — and it opened the category list:
 *
 *   Reality Capture (Scan-to-BIM)   ← display_order NULL, description NULL
 *   Accounting & ERP                ← display_order 10
 *   AI                              ← display_order 20
 *
 * A reader sees a list that is alphabetical apart from its first entry, and the
 * one out-of-place row is also the one with no description. Both symptoms come
 * from the same missing metadata, and the ordering half is fixable here.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────
 * Curated terms first, in their curated sequence. Uncurated terms after them, in
 * name order. `x IS NULL` evaluates to 0/1 in SQLite, so sorting on it ascending
 * puts the non-NULL rows ahead of the NULL ones with no `NULLS LAST` support
 * needed (SQLite only gained `NULLS LAST` in 3.30, and Drizzle has no portable
 * wrapper for it).
 *
 * Always follow this with a text ordering on the term's own name — see
 * {@link textAsc} — or the whole uncurated tail is one undifferentiated tie.
 *
 * ── SCOPE, AND THE ONE PLACE IT DOES NOT REACH ──────────────────────────────────
 * Every D1 read that orders taxonomy terms for display. It does **not** reach the
 * browser: `toTaxonomyTermWithCount` serialises `display_order` as
 * `raw.displayOrder ?? 0` because the wire schema
 * (`packages/shared/src/api/taxonomy.ts`) types it `z.number().int()`, so a client
 * cannot distinguish "unordered" from "order 0". Consumers that re-sort in memory
 * (`apps/web/src/app/core/taxonomy/taxonomy-rank.ts`, `byDisplayOrder`) therefore
 * still float an uncurated term to the front. That is only used for `phases`
 * today, which has no NULL rows; every other surface renders the wire order,
 * which this fixes. Widening it means making `display_order` nullable on the wire,
 * which is an API-contract change.
 */

import { asc, sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * Ascending `display_order` with NULLs sorted LAST. Returns the TWO `ORDER BY`
 * terms that produce it, so spread it into `.orderBy(...)`:
 *
 * ```ts
 * .orderBy(...displayOrderAsc(taxonomyCategories.displayOrder), textAsc(taxonomyCategories.name))
 * ```
 *
 * Two terms rather than one because the NULL test and the value have to be
 * separate sort keys; collapsing them into a single `COALESCE` would need a
 * sentinel value, and any sentinel is a real `display_order` someone can later
 * curate into.
 */
export function displayOrderAsc(column: SQLWrapper): [SQL, SQL] {
  return [sql`${column} is null`, asc(column)];
}

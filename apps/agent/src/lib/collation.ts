/**
 * Case-insensitive text ordering for this Worker's hand-written SQL (AECI-825).
 *
 * ── WHY THIS IS A MIRROR AND NOT AN IMPORT ───────────────────────────────────
 * `apps/api/src/lib/collation.ts` is the source of truth for this rule, but its
 * helpers return Drizzle `SQL` fragments and Drizzle is deliberately not a
 * dependency of `@aeci/agent` — the agent's D1 tools are hand-written
 * parameterised statements over the raw `DB` binding. So the rule is mirrored
 * here as SQL text. `collation.spec.ts` pins the emitted text, and the API
 * module's docblock is the explanation; read it before changing anything here.
 *
 * ── THE RULE, IN ONE PARAGRAPH ───────────────────────────────────────────────
 * SQLite's default collation is `BINARY`, so a bare `ORDER BY name` sorts by
 * byte value and every capital beats every lowercase letter. On this catalog
 * that puts `ADP Workforce Now` above `Access Coins Evo` and sorts `eSUB`,
 * `iSqFt` and `openBIM` after `Zoho`. `COLLATE NOCASE` folds ASCII `A–Z` onto
 * `a–z` for the comparison only.
 *
 * ── THE OBLIGATION THAT COMES WITH IT ────────────────────────────────────────
 * `NOCASE` makes ties possible where `BINARY` had none: it reports `ADP` and
 * `adp` as EQUAL. A list with `LIMIT` and no unique trailing term can therefore
 * drop or duplicate a row (AECI-99). **Every `textAsc` here is followed by an
 * `id` tiebreaker**, and {@link orderByTextThenId} is the only exported form so
 * that it cannot be forgotten.
 *
 * Scope: text a HUMAN READS — names, titles, company names. Not slugs, ids,
 * enum tokens or ISO timestamps, where `BINARY` is already correct and cheaper.
 */

/**
 * `ORDER BY <textColumn> COLLATE NOCASE ASC, <idColumn> ASC` — the only
 * name-ordering this Worker emits.
 *
 * Both arguments are SQL identifiers written by US, never by the model. Nothing
 * a tool receives from a model reaches this function; model input is bound
 * values only.
 */
export function orderByTextThenId(textColumn: string, idColumn: string): string {
  return `ORDER BY ${textThenIdTerms(textColumn, idColumn)}`;
}

/**
 * The same pair of ORDER BY TERMS, without the `ORDER BY` keyword.
 *
 * Exists for the one shape {@link orderByTextThenId} cannot express: a query
 * that must GROUP rows by an owning id before it sorts them by name — the corpus
 * builder reads every promoted product's taxonomy and integrations in one
 * statement, so its ordering is `product_id ASC` and then this. Splitting the
 * terms out keeps that query on the same rule instead of hand-writing a second
 * spelling of `COLLATE NOCASE` next to a forgotten tiebreaker.
 */
export function textThenIdTerms(textColumn: string, idColumn: string): string {
  return `${textColumn} COLLATE NOCASE ASC, ${idColumn} ASC`;
}

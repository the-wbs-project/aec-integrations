/**
 * Case-insensitive text ordering for D1 (AECI-825).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * **SQLite's default collation is `BINARY`, so a bare `ORDER BY name` sorts by
 * byte value and case decides the order.** Every capital letter (0x41–0x5A) beats
 * every lowercase one (0x61–0x7A), which on this catalog produced:
 *
 *   ADP Workforce Now · AEC Integrations · AEC Stack · Access Coins Evo · AccuLynx
 *
 * `ADP` outranks `Access` on `D` vs `c` alone, and `eSUB` / `iSqFt` / `openBIM`
 * land after `Zoho`. AEC product names carry interior capitals and lowercase
 * initials constantly, so this is most of the alphabet, not an edge case.
 *
 * ── THE FIX, AND ITS ONE OBLIGATION ─────────────────────────────────────────────
 * `COLLATE NOCASE` folds ASCII `A–Z` onto `a–z` for the comparison only; the
 * stored value is untouched. It is applied per-`ORDER BY` rather than per-column,
 * so no migration and no schema change is involved and nothing about equality,
 * uniqueness, or `WHERE` matching moves.
 *
 * **The obligation: `NOCASE` makes ties possible where `BINARY` had none.**
 * `BINARY` distinguishes `ADP` from `adp`; `NOCASE` calls them equal. Any list
 * paginated with `LIMIT`/`OFFSET` needs a total order or a row on a page boundary
 * can be dropped or duplicated (AECI-99) — so every `textAsc`/`textDesc` MUST be
 * followed by something unique, normally `asc(table.id)`. Where the ordering is a
 * `GROUP BY` readout with no id to fall back on, follow it with the raw column
 * (`asc(column)`), whose `BINARY` comparison settles the case-only tie.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────────
 * For text a HUMAN READS: names, titles, company names, labels. Not for slugs
 * (lowercase by construction — `@aeci/shared/slug`), ids, enum tokens, ISO
 * timestamps or `sqlite_master` bookkeeping, where `BINARY` is already correct and
 * cheaper. The in-memory twin of this module is `compareText` from
 * `@aeci/shared/text-sort`; the two agree across the ASCII catalog.
 *
 * ── COST ────────────────────────────────────────────────────────────────────────
 * `products_name_idx` / `vendors_company_name_idx` are `BINARY` indexes, so a
 * `NOCASE` order can no longer read the order straight off them and SQLite builds
 * a transient b-tree instead. On a catalog of this size (low thousands) that is
 * microseconds, and the list queries already carry filter predicates that mostly
 * defeated the index anyway. If the catalog grows an order of magnitude, add a
 * `name COLLATE NOCASE` index rather than reverting this.
 */

import { asc, desc, sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * `<operand> COLLATE NOCASE` — the bare expression. Private: every call site wants
 * one of the three direction wrappers below, and a bare `COLLATE` dropped into an
 * arbitrary position is easy to get wrong.
 */
function nocase(column: SQLWrapper): SQL {
  return sql`${column} collate nocase`;
}

/**
 * A→Z, case-insensitive. Takes a column OR any SQL fragment, so a `UNION`'s output
 * alias (`textAsc(sql\`"name"\`)`) folds the same way a column does. Follow it with
 * a unique tiebreaker — see the module docblock.
 */
export function textAsc(column: SQLWrapper): SQL {
  return asc(nocase(column));
}

/** Z→A, case-insensitive. Same tiebreaker obligation as {@link textAsc}. */
export function textDesc(column: SQLWrapper): SQL {
  return desc(nocase(column));
}

/** `textAsc` or `textDesc`, chosen by an already-resolved direction flag. */
export function textDir(column: SQLWrapper, ascending: boolean): SQL {
  return ascending ? textAsc(column) : textDesc(column);
}

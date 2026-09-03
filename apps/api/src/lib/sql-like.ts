import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * Substring `LIKE` search over operator-supplied text.
 *
 * The escaping and the `ESCAPE` clause live together in one function on purpose.
 * They are only correct as a pair — escaping without `ESCAPE '\'` makes `\%` a
 * two-character literal, and `ESCAPE '\'` without escaping does nothing — and
 * they were previously split across a private helper and its single call site,
 * which is exactly the shape that drifts the moment a second caller appears.
 *
 * Drizzle's `like()` emits no `ESCAPE`, so this cannot be expressed with it.
 */

/**
 * Escape the SQL `LIKE` metacharacters so operator input matches literally.
 *
 * Without this, a search of `%` matches every row and `_` matches any single
 * character — the filter silently becomes a pattern language nobody documented.
 * The backslash itself is escaped first by the character class, which is why the
 * regex includes it.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * `column LIKE '%<escaped value>%' ESCAPE '\'` — a literal substring match.
 *
 * **This cannot use an index**, and that is accepted rather than overlooked: a
 * leading `%` defeats a B-tree prefix scan, so every call is a full scan of the
 * filtered set. At AECi's cardinality (a few hundred vendors, an admin-only
 * caller) that is the right trade for exact, predictable matching. If a caller
 * ever needs this at scale the answer is FTS5, not a cleverer LIKE.
 */
export function likeContains(column: SQLWrapper, value: string): SQL {
  return sql`${column} like ${`%${escapeLike(value)}%`} escape '\\'`;
}

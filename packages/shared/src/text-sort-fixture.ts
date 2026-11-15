/**
 * One fixture for the case-only name tie (AECI-1840), read by the shared, API and
 * web specs so all three pin the SAME expected order.
 *
 * `Mid bridge` and `mid bridge` differ only in case. The lowercase name carries the
 * HIGHER id on purpose: an ICU comparator that ranks the tie by case (lowercase
 * first) would put it ahead, and SQL (`COLLATE NOCASE`, then `id ASC`) would not.
 * Only a comparator that calls the pair a tie, with the caller breaking it on `id`,
 * gives the order below.
 *
 * Test-only. Reach it as `@aeci/shared/text-sort-fixture`; not in the root barrel.
 */

export interface CaseTieRow {
  readonly id: string;
  readonly name: string;
}

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Deliberately NOT in the expected order, so a sort has work to do. */
export const CASE_TIE_ROWS: readonly CaseTieRow[] = [
  { id: id(3), name: 'Mid zone' },
  { id: id(2), name: 'mid bridge' },
  { id: id(1), name: 'Mid bridge' },
  { id: id(4), name: 'Acme' },
];

/** Name case-blind, then `id` ASC: what D1 returns for `textAsc(name), id ASC`. */
export const CASE_TIE_EXPECTED_IDS: readonly string[] = [id(4), id(1), id(2), id(3)];

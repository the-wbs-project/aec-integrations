/**
 * The ONE comparator for human-readable text (AECI-825).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * **Case must never decide an alphabetical order.** Byte-order sorting puts every
 * capital ahead of every lowercase letter, which on this catalog reads as broken:
 *
 *   ADP Workforce Now · AEC Integrations · AEC Stack · Access Coins Evo · AccuLynx
 *
 * `ADP` outranks `Access` only because `D` is 0x44 and `c` is 0x63. The same rule
 * exiles `eSUB`, `iSqFt` and `openBIM` past `Zoho` to the bottom of an A–Z list.
 * AEC brand names are full of interior capitals and lowercase initials, so this is
 * not an edge case here — it is most of the alphabet.
 *
 * ── THE LOCALE IS PINNED, DELIBERATELY ──────────────────────────────────────────
 * `'en'`, not the ambient locale. A bare `a.localeCompare(b)` resolves against
 * whatever the runtime's default locale is — the visitor's OS setting in the
 * browser, workerd's default under SSR. For any list SSR renders sorted and the
 * client re-sorts after hydration, an unpinned collation is a **server/client
 * mismatch**, not merely a cosmetic difference. The app is en-US only at launch
 * (`@angular/localize`, CLAUDE.md), so pinning costs nothing and removes the
 * divergence. `apps/web/src/app/taxonomy/taxonomy-index.ts` reached this
 * conclusion first; this module generalizes it.
 *
 * ── DELIBERATELY NOT NUMERIC ────────────────────────────────────────────────────
 * `numeric: false`, so `Sage 100` sorts before `Sage 20` exactly as it does in
 * SQL. Numeric collation would read better in isolation, but the SAME lists are
 * ordered by D1 (`textAsc` in `apps/api/src/lib/collation.ts`, `COLLATE NOCASE`)
 * on the paginated path and by this comparator on the in-memory path. SQLite has
 * no numeric collation, so turning it on here would make page 1 and page 2 of one
 * list disagree about where a product belongs. One rule, both runtimes.
 *
 * The two collations are not byte-identical — ICU orders a case-insensitive tie
 * (`ADP` vs `adp`) lowercase-first, while `COLLATE NOCASE` calls it a tie and
 * leaves the tiebreaker column to settle it. Every SQL ordering therefore keeps a
 * unique trailing tiebreaker (AECI-99). Below that, the orders agree across the
 * ASCII catalog: both put digits and punctuation ahead of letters, and neither
 * lets case decide.
 *
 * No zod, no `./api/*` import, and deliberately **not** re-exported from the root
 * `src/index.ts` barrel (the rule `version-sort.ts` and `algolia.ts` follow).
 * Reach it as `@aeci/shared/text-sort`.
 */

/** The collation locale every text ordering in the app uses. */
export const TEXT_SORT_LOCALE = 'en';

/**
 * Built on first use rather than at module load, so the module stays the pure
 * declaration the package's `sideEffects: false` claim depends on.
 */
let collator: Intl.Collator | undefined;

function textCollator(): Intl.Collator {
  collator ??= new Intl.Collator(TEXT_SORT_LOCALE, {
    // Full strength: case still breaks a tie, it just never outranks a letter
    // difference. Anything weaker would report `ADP` and `adp` as equal and make
    // the comparator a non-total order.
    sensitivity: 'variant',
    // See the docblock — SQLite cannot match this, so it stays off.
    numeric: false,
  });
  return collator;
}

/**
 * Compare two display strings A→Z, case-insensitively at the primary level.
 *
 * Use this anywhere an in-memory list is put in alphabetical order for a reader:
 * component-side sorts, API mappers ordering an embedded array, grouping helpers.
 * Never hand-roll `a < b`, bare `.sort()`, or an unpinned `localeCompare` for text
 * a human reads.
 */
export function compareText(a: string, b: string): number {
  return textCollator().compare(a, b);
}

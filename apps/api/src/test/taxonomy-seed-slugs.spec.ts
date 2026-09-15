import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { slugify } from '@aeci/shared/slug';
import { describe, expect, it } from 'vitest';

/**
 * **A seeded term's `slug` must equal `slugify(its name)`** — for the three facets
 * promote resolves find-or-create (AECI-925).
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────
 * `resolveTaxonomy` (`routes/promote.ts`) matches an incoming category / audience /
 * phase by `slugify(name)` against the `slug` column, and MINTS the term when that
 * lookup misses. So the moment a seeded term's name stops slugifying to its own
 * slug, the seeded row becomes unreachable and the next promote silently creates a
 * SECOND term with the same display name — leaving one populated duplicate and one
 * empty original, both with their own public browse URL in the sitemap.
 *
 * That is not a thought experiment. `reality-capture` / `Reality Capture
 * (Scan-to-BIM)` was exactly this, in production: the seeded row held the curated
 * description and 0 products, while the minted `reality-capture-scan-to-bim` held
 * 10 products, 44 integrations and no description at all. AECI-926 resolved it by
 * renaming the term upstream to `Reality Capture`, so the exception list is empty.
 *
 * Nothing else catches it. The promote returns 200, the term renders, the browse
 * page is valid, and the only visible symptom is a list that is alphabetical apart
 * from one entry.
 *
 * ── TRADES ARE EXEMPT, BY DESIGN ────────────────────────────────────────────────
 * `taxonomy_trades` is resolved **find-only** (`TRADES_VOCABULARY.md` §3/§4): an
 * unmatched trade is dropped into `skipped[]`, never minted, and matching runs
 * slug → name → alias, so a name that does not slugify to its slug is handled by
 * the name pass rather than by creating a row. Same for `taxonomy_data_objects`.
 *
 * ── THE EXCEPTION LIST ──────────────────────────────────────────────────────────
 * Asserted as an EXACT set, not a subset. Adding an offender fails; fixing the
 * known one also fails, which forces the list to be emptied rather than left to rot.
 */

/** Facets `resolveTaxonomy` will mint into. Trades and data objects are find-only. */
const MINTABLE_FACETS = ['taxonomy_categories', 'taxonomy_audiences', 'taxonomy_phases'] as const;

/**
 * Empty, and meant to stay that way. AECI-926 closed the one live offender
 * (`reality-capture` / `Reality Capture (Scan-to-BIM)`) by taking option A: the
 * upstream category was renamed to `Reality Capture`, the seed `name` followed,
 * the minted duplicate was deleted, and `/categories/reality-capture-scan-to-bim`
 * now 301s (`apps/web/src/server-runtime.ts`).
 *
 * Adding an entry here is not the fix for a new mismatch. Fix the name or the slug.
 */
const KNOWN_OFFENDERS: string[] = [];

/**
 * The VALUES rows of one table's `INSERT`, bounded by its own `ON CONFLICT` so a
 * facet cannot bleed into the next one. Each row opens
 * `('<uuid>', '<slug>', '<name>', <description>,` and no name in this file carries
 * an escaped quote, so a single-quoted capture is enough for the first three.
 *
 * The description capture DOES allow `''` escapes, and matches a bare `NULL` as an
 * alternative — without that alternative a null-description row would simply not
 * match, and the row would vanish from the scan instead of failing it (AECI-962).
 * `description` is `null` for a bare NULL, so the caller distinguishes the two.
 */
function seedRows(
  table: string,
): Array<{ slug: string; name: string; description: string | null }> {
  const sql = readFileSync(join(process.cwd(), 'seed/taxonomy.sql'), 'utf8');
  const start = sql.indexOf(`INSERT INTO "${table}"`);
  expect(start, `${table} INSERT not found in seed/taxonomy.sql`).toBeGreaterThan(-1);
  const end = sql.indexOf('ON CONFLICT', start);
  expect(end, `${table} INSERT has no ON CONFLICT terminator`).toBeGreaterThan(start);

  const block = sql.slice(start, end);
  return [
    ...block.matchAll(
      /\('[0-9a-f-]{36}',\s*'([a-z0-9-]+)',\s*'([^']+)',\s*(NULL|'((?:[^']|'')*)')/g,
    ),
  ].map((m) => ({
    slug: m[1],
    name: m[2],
    description: m[3] === 'NULL' ? null : (m[4] ?? '').replace(/''/g, "'"),
  }));
}

/**
 * `META_DESCRIPTION_MAX` in `apps/web/src/app/core/meta.helpers.ts`. Past this,
 * `truncateAtWordBoundary()` cuts the string SILENTLY, so an over-long seed
 * description ships a meta description that stops mid-thought with no warning.
 */
const MAX_DESCRIPTION_LENGTH = 155;

describe('seeded taxonomy slugs round-trip through slugify (AECI-925)', () => {
  it('is not a vacuous scan — the whole seeded vocabulary is in range', () => {
    // Pinned counts, so a parser that silently stops early cannot pass by
    // checking three rows and declaring the file clean.
    expect(seedRows('taxonomy_categories')).toHaveLength(32);
    expect(seedRows('taxonomy_audiences')).toHaveLength(36);
    expect(seedRows('taxonomy_phases')).toHaveLength(5);
  });

  it('every seeded term slugifies to its own slug, bar the known exceptions', () => {
    const offenders: string[] = [];
    for (const table of MINTABLE_FACETS) {
      for (const { slug, name } of seedRows(table)) {
        if (slugify(name) !== slug) offenders.push(slug);
      }
    }
    // EXACT, not a subset — see the docblock.
    expect(offenders.sort()).toEqual([...KNOWN_OFFENDERS].sort());
  });
});

/**
 * **Every seeded term carries a usable description** (AECI-962).
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────
 * The `seed/taxonomy.sql` header has stated this as a rule since AECI-911, and
 * nothing enforced it. The column is nullable — tightening it would mean recreating
 * three tables on D1, which is destructive (ADR 0008) — so a blank description is a
 * perfectly valid INSERT, parses fine against `TaxonomyResponseSchema` (the wire
 * type is `z.string().nullable()`), renders as a bare term with no visible error,
 * and only shows up as a browse page quietly inheriting the site-wide default meta
 * description. That is how 73 indexable pages came to share one.
 *
 * The length bound is the other silent half: over `META_DESCRIPTION_MAX` the string
 * is truncated at a word boundary with no warning, so the page ships a sentence that
 * stops mid-thought.
 *
 * This covers the SEED. The live D1 side — a term promote minted at runtime with no
 * description at all — is covered by the `taxonomy_missing_description` data-quality
 * check in `lib/data-quality.ts`. Neither one subsumes the other.
 */
describe('seeded taxonomy descriptions (AECI-962)', () => {
  it('every seeded term has a non-blank description', () => {
    const offenders: string[] = [];
    for (const table of MINTABLE_FACETS) {
      for (const { slug, description } of seedRows(table)) {
        if (description === null || description.trim() === '') offenders.push(`${table}/${slug}`);
      }
    }
    // EXACT and empty. There is no exception list here on purpose — write the copy.
    expect(offenders.sort()).toEqual([]);
  });

  it('no seeded description exceeds the meta-description limit', () => {
    const offenders: string[] = [];
    for (const table of MINTABLE_FACETS) {
      for (const { slug, description } of seedRows(table)) {
        if ((description?.length ?? 0) > MAX_DESCRIPTION_LENGTH) {
          offenders.push(`${table}/${slug} (${description?.length})`);
        }
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});

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
 * (Scan-to-BIM)` is exactly this, in production: the seeded row holds the curated
 * description and 0 products, while the minted `reality-capture-scan-to-bim` holds
 * 10 products, 44 integrations and no description at all.
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
 * The one live offender, pending a decision on which side moves (AECI-926):
 * rename the term upstream to drop the parenthetical, or re-slug the seed to
 * `reality-capture-scan-to-bim` and 301 the old browse URL. Either way the entry
 * below goes, and this test is what will notice.
 */
const KNOWN_OFFENDERS = ['reality-capture'];

/**
 * The VALUES rows of one table's `INSERT`, bounded by its own `ON CONFLICT` so a
 * facet cannot bleed into the next one. Each row opens
 * `('<uuid>', '<slug>', '<name>', ` and no name in this file carries an escaped
 * quote, so a single-quoted capture is enough.
 */
function seedRows(table: string): Array<{ slug: string; name: string }> {
  const sql = readFileSync(join(process.cwd(), 'seed/taxonomy.sql'), 'utf8');
  const start = sql.indexOf(`INSERT INTO "${table}"`);
  expect(start, `${table} INSERT not found in seed/taxonomy.sql`).toBeGreaterThan(-1);
  const end = sql.indexOf('ON CONFLICT', start);
  expect(end, `${table} INSERT has no ON CONFLICT terminator`).toBeGreaterThan(start);

  const block = sql.slice(start, end);
  return [...block.matchAll(/\('[0-9a-f-]{36}',\s*'([a-z0-9-]+)',\s*'([^']+)'/g)].map((m) => ({
    slug: m[1],
    name: m[2],
  }));
}

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

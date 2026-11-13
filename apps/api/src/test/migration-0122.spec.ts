import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1713 — `0122_browser_evidence.sql` adds the nullable `page_views.browser_evidence`
 * and `page_views.browser_evidence_at` columns. This file is the tripwire on the body.
 *
 * It must stay two plain `ALTER TABLE … ADD`s. `page_views` is the hottest table in the
 * app, and a drizzle-kit recreate (`__new_page_views`) would copy every row through a
 * `DROP TABLE` that fires ON DELETE CASCADE (`docs/migrations.md` §0). A CHECK on
 * `browser_evidence` was tried and produced exactly that recreate, so the column has
 * no CHECK. A regenerate that grows one, or an index, is caught here.
 */
const MIGRATION = '0122_browser_evidence.sql';
const NOW = '2026-11-13T00:00:00.000Z';

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — two plain ADD COLUMNs`, () => {
  it('carries exactly the two ADDs and nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map(withoutComments);
    expect(statements).toEqual([
      'ALTER TABLE `page_views` ADD `browser_evidence` text;',
      'ALTER TABLE `page_views` ADD `browser_evidence_at` text;',
    ]);
    for (const s of statements) {
      expect(s).not.toMatch(/__new_|DROP|CREATE|INSERT INTO|PRAGMA|CHECK/i);
    }
  });

  it('keeps every existing row and leaves both new columns null on them', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      t.raw
        .prepare(
          `INSERT INTO page_views (path, cf_ray, writer_provenance, created_at)
           VALUES ('/', '0123456789abcdef-IAD', 'ssr-arrival', ?),
                  ('/products', '0123456789abcdee-IAD', 'browser-spa', ?)`,
        )
        .run(NOW, NOW);

      for (const s of statementsForMigration(MIGRATION)) t.raw.prepare(s).run();

      expect(
        t.raw
          .prepare(
            `SELECT path, cf_ray, browser_evidence, browser_evidence_at FROM page_views ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          path: '/',
          cf_ray: '0123456789abcdef-IAD',
          browser_evidence: null,
          browser_evidence_at: null,
        },
        {
          path: '/products',
          cf_ray: '0123456789abcdee-IAD',
          browser_evidence: null,
          browser_evidence_at: null,
        },
      ]);
    } finally {
      t.dispose();
    }
  });
});

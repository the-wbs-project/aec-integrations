import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1457 — `0095_turnstile_verdict.sql` adds the nullable `page_views.turnstile_verdict`
 * column. This file is the tripwire on the body.
 *
 * It must stay one plain `ALTER TABLE … ADD`. `page_views` is the hottest table in the
 * app, and a drizzle-kit recreate (`__new_page_views`) would copy every row through a
 * `DROP TABLE` (`docs/migrations.md` §0). The column deliberately has no CHECK and no
 * index, so a regenerate that grows either is caught here.
 */
const MIGRATION = '0095_turnstile_verdict.sql';
const NOW = '2026-10-28T00:00:00.000Z';

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — one plain ADD COLUMN`, () => {
  it('carries exactly the one ADD and nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map(withoutComments);
    expect(statements).toEqual(['ALTER TABLE `page_views` ADD `turnstile_verdict` text;']);
    for (const s of statements) {
      expect(s).not.toMatch(/__new_|DROP|CREATE|INSERT INTO|PRAGMA|CHECK/i);
    }
  });

  it('keeps every existing row and leaves the new column null on them', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      t.raw
        .prepare(
          `INSERT INTO page_views (path, cf_ray, writer_provenance, created_at)
           VALUES ('/', '0123456789abcdef-IAD', 'ssr-arrival', ?),
                  ('/products', NULL, 'browser-spa', ?)`,
        )
        .run(NOW, NOW);

      for (const s of statementsForMigration(MIGRATION)) t.raw.prepare(s).run();

      expect(
        t.raw.prepare(`SELECT path, cf_ray, turnstile_verdict FROM page_views ORDER BY id`).all(),
      ).toEqual([
        { path: '/', cf_ray: '0123456789abcdef-IAD', turnstile_verdict: null },
        { path: '/products', cf_ray: null, turnstile_verdict: null },
      ]);
    } finally {
      t.dispose();
    }
  });
});

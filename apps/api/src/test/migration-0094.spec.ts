import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1397, PR B — `0094_drop_plan_interest.sql` drops `vendor_requests.plan_interest`
 * and `listing_requests.plan_interest`. This file is the tripwire on the body.
 *
 * It must stay two plain `DROP COLUMN`s. A recreate of either table runs a `DROP TABLE`,
 * whose implicit DELETE fires the SET NULL on `agreement_acceptances` and cuts each
 * vendor-terms acceptance from its claim or listing request. `PRAGMA defer_foreign_keys`
 * does not stop that (`docs/migrations.md` §3.3a). Those links are legal evidence
 * (`docs/DATABASE_SCHEMA.md` §8.6d), so the seeded test below proves they survive.
 */
const MIGRATION = '0094_drop_plan_interest.sql';
const NOW = '2026-10-28T00:00:00.000Z';

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — two plain DROP COLUMNs`, () => {
  it('carries exactly the two drops and nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map(withoutComments);
    expect(statements).toEqual([
      'ALTER TABLE `vendor_requests` DROP COLUMN `plan_interest`;',
      'ALTER TABLE `listing_requests` DROP COLUMN `plan_interest`;',
    ]);
    for (const s of statements) {
      expect(s).not.toMatch(/__new_|DROP TABLE|CREATE|INSERT INTO|PRAGMA/i);
    }
  });

  it('drops both columns and keeps every row, acceptance link and duplicate link', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      t.raw
        .prepare(
          `INSERT INTO vendors (id, slug, company_name, created_at, updated_at)
           VALUES ('v1', 'v', 'V', ?, ?)`,
        )
        .run(NOW, NOW);
      t.raw
        .prepare(
          `INSERT INTO vendor_requests
             (id, kind, target_type, target_id, submitter_email, body, plan_interest,
              duplicate_of_request_id, created_at)
           VALUES ('r1', 'claim', 'vendor', 'v1', 'a@v.example', 'claim', 'not_sure', NULL, ?),
                  ('r2', 'claim', 'vendor', 'v1', 'b@v.example', 'again', NULL, 'r1', ?)`,
        )
        .run(NOW, NOW);
      t.raw
        .prepare(
          `INSERT INTO listing_requests
             (id, listing_name, website, submitter_email, plan_interest, created_at)
           VALUES ('l1', 'Site Diary', 'https://site.example', 'c@site.example', 'managed', ?)`,
        )
        .run(NOW);
      t.raw
        .prepare(
          `INSERT INTO agreement_acceptances
             (id, document, version, source, email, vendor_request_id, listing_request_id,
              accepted_at, created_at)
           VALUES ('aa1', 'vendor_terms', '1', 'claim', 'a@v.example', 'r1', NULL, ?, ?),
                  ('aa2', 'vendor_terms', '1', 'listing', 'c@site.example', NULL, 'l1', ?, ?)`,
        )
        .run(NOW, NOW, NOW, NOW);

      const snapshot = () => ({
        claims: t.raw
          .prepare(`SELECT id, duplicate_of_request_id FROM vendor_requests ORDER BY id`)
          .all(),
        listings: t.raw.prepare(`SELECT id, listing_name FROM listing_requests ORDER BY id`).all(),
        acceptances: t.raw
          .prepare(
            `SELECT id, vendor_request_id, listing_request_id FROM agreement_acceptances
             ORDER BY id`,
          )
          .all(),
      });
      const before = snapshot();

      for (const s of statementsForMigration(MIGRATION)) t.raw.prepare(s).run();

      expect(snapshot()).toEqual(before);
      expect(before.acceptances).toEqual([
        { id: 'aa1', vendor_request_id: 'r1', listing_request_id: null },
        { id: 'aa2', vendor_request_id: null, listing_request_id: 'l1' },
      ]);
      expect(t.raw.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
      for (const table of ['vendor_requests', 'listing_requests']) {
        const columns = t.raw.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
          name: string;
        }>;
        expect(
          columns.map((c) => c.name),
          table,
        ).not.toContain('plan_interest');
      }
    } finally {
      t.dispose();
    }
  });
});

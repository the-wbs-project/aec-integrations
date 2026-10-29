import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1305 — `0098_marketing_mute.sql` adds the marketing opt-out to
 * `notification_preferences`: two nullable columns and a unique index on the new token.
 * This file is the tripwire on the body.
 *
 * It must stay two `ADD COLUMN`s and one `CREATE UNIQUE INDEX`. A recreate of the table
 * would rebuild every row through `INSERT INTO __new_…`, and any slip there would cost a
 * seat its mute or its `mute_token`, which every digest already sent carries in its
 * footer link (`docs/migrations.md` §0). The seeded test below proves both survive.
 */
const MIGRATION = '0098_marketing_mute.sql';
const NOW = '2026-10-29T00:00:00.000Z';

const withoutComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

describe(`${MIGRATION} — add columns and an index, no recreate`, () => {
  it('carries exactly the two adds and the index, nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map(withoutComments);
    expect(statements).toEqual([
      'ALTER TABLE `notification_preferences` ADD `marketing_muted_at` text;',
      'ALTER TABLE `notification_preferences` ADD `marketing_mute_token` text;',
      'CREATE UNIQUE INDEX `notification_preferences_marketing_mute_token_key` ON `notification_preferences` (`marketing_mute_token`);',
    ]);
    for (const s of statements) {
      expect(s).not.toMatch(/__new_|DROP TABLE|INSERT INTO|PRAGMA/i);
    }
  });

  it('keeps every row, its mute and its mute_token, and leaves the new columns null', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      t.raw
        .prepare(
          `INSERT INTO profiles (id, role, created_at, updated_at)
           VALUES ('p1', 'vendor_admin', ?, ?), ('p2', 'vendor_admin', ?, ?)`,
        )
        .run(NOW, NOW, NOW, NOW);
      t.raw
        .prepare(
          `INSERT INTO notification_preferences
             (profile_id, nudges_muted_at, mute_token, created_at, updated_at)
           VALUES ('p1', ?, 'tok-1', ?, ?), ('p2', NULL, 'tok-2', ?, ?)`,
        )
        .run(NOW, NOW, NOW, NOW, NOW);

      const snapshot = () =>
        t.raw
          .prepare(
            `SELECT profile_id, nudges_muted_at, mute_token FROM notification_preferences
             ORDER BY profile_id`,
          )
          .all();
      const before = snapshot();

      for (const s of statementsForMigration(MIGRATION)) t.raw.prepare(s).run();

      expect(snapshot()).toEqual(before);
      expect(before).toEqual([
        { profile_id: 'p1', nudges_muted_at: NOW, mute_token: 'tok-1' },
        { profile_id: 'p2', nudges_muted_at: null, mute_token: 'tok-2' },
      ]);
      expect(
        t.raw
          .prepare(`SELECT marketing_muted_at, marketing_mute_token FROM notification_preferences`)
          .all(),
      ).toEqual([
        { marketing_muted_at: null, marketing_mute_token: null },
        { marketing_muted_at: null, marketing_mute_token: null },
      ]);
      expect(t.raw.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    } finally {
      t.dispose();
    }
  });
});

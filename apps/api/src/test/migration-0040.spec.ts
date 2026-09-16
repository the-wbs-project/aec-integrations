import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { profiles } from '../db/schema';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-988 — `0040_wealthy_the_professor.sql`, the remembered Cards/Table listing
 * preference on `profiles`. This file is the tripwire on the hand-authored body.
 *
 * The column carries a CHECK, which puts drizzle-kit on the SQLite table-recreate
 * path. A regenerated file would `DROP TABLE profiles`, and `profiles` has eight
 * inbound FKs — three of them ON DELETE SET NULL. D1 ignores `PRAGMA
 * foreign_keys = off`, so the drop would NULL `reviews.reviewer_id` on every row
 * and the migration would still report success. The committed body is a plain
 * `ALTER TABLE … ADD COLUMN` instead (the 0023 pattern), so the assertions below
 * are: the file stays additive, and the CHECK is really enforced anyway.
 */
const MIGRATION = '0040_wealthy_the_professor.sql';

describe(`${MIGRATION} — additive, not a recreate`, () => {
  it('carries no table recreate in the committed file', () => {
    // The `--` comment block names the very shapes this asserts against, so
    // strip it first or the tripwire trips on its own warning.
    const statements = statementsForMigration(MIGRATION).map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/ALTER TABLE `profiles` ADD `listing_view_preference`/);
    // The exact shapes a regeneration would reintroduce.
    for (const s of statements) {
      expect(s).not.toMatch(/__new_profiles/);
      expect(s).not.toMatch(/DROP TABLE/i);
    }
  });

  it('enforces the vocabulary, and accepts NULL as "never toggled"', async () => {
    const t = await makeTestDb();
    try {
      await t.db.insert(profiles).values({ id: 'u1', displayName: 'Ada' });
      expect((await t.db.select().from(profiles))[0]?.listingViewPreference).toBeNull();

      await t.db
        .update(profiles)
        .set({ listingViewPreference: 'table' })
        .where(eq(profiles.id, 'u1'));
      expect((await t.db.select().from(profiles))[0]?.listingViewPreference).toBe('table');

      await expect(
        t.db
          .update(profiles)
          .set({ listingViewPreference: 'grid' as 'cards' })
          .where(eq(profiles.id, 'u1')),
      ).rejects.toThrow();
    } finally {
      t.dispose();
    }
  });
});

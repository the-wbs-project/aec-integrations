import { describe, expect, it } from 'vitest';

import { statementsForMigration } from './d1';

/**
 * AECI-1625 — `0106_gifted_black_cat.sql` adds `vendors.legal_name`. This file is the
 * tripwire on the body.
 *
 * It must stay one plain `ADD COLUMN`. `vendors` has FK children, several with
 * `ON DELETE CASCADE`, so a drizzle-kit recreate of it runs a `DROP TABLE` that deletes
 * their rows two levels deep (`docs/migrations.md` §0).
 */
const MIGRATION = '0106_gifted_black_cat.sql';

describe(`${MIGRATION} — one plain ADD COLUMN, no recreate`, () => {
  it('is one ADD COLUMN on vendors and nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map((s) => s.trim());
    expect(statements).toEqual(['ALTER TABLE `vendors` ADD `legal_name` text;']);
  });
});

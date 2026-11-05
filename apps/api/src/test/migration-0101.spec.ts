import { describe, expect, it } from 'vitest';

import { statementsForMigration } from './d1';

/**
 * AECI-1617 — `0101_sharp_starjammers.sql` adds the signer's fields to `vendor_requests`,
 * `listing_requests` and `agreement_acceptances`. This file is the tripwire on the body.
 *
 * It must stay seven plain `ADD COLUMN`s. `agreement_acceptances` points at both request
 * tables with `ON DELETE SET NULL`, so a recreate of either runs a `DROP TABLE` that cuts
 * each acceptance from its request (`docs/migrations.md` §0).
 */
const MIGRATION = '0101_sharp_starjammers.sql';

describe(`${MIGRATION} — plain ADD COLUMNs, no recreate`, () => {
  it('is seven ADD COLUMNs and nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map((s) => s.trim());
    expect(statements).toHaveLength(7);
    for (const statement of statements) {
      expect(statement).toMatch(/^ALTER TABLE `\w+` ADD `\w+` text;?$/);
    }
  });
});

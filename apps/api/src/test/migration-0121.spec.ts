import { describe, expect, it } from 'vitest';

import { statementsForMigration } from './d1';

/**
 * AECI-1705 — `0121_gray_gauntlet.sql` adds `listing_requests.company_country`. This file
 * is the tripwire on the body.
 *
 * It must stay one plain `ADD COLUMN`. `agreement_acceptances.listing_request_id` points at
 * `listing_requests` with `ON DELETE SET NULL`, so a recreate would run a `DROP TABLE` that
 * cuts each old acceptance from its request (`docs/migrations.md` §0).
 */
const MIGRATION = '0121_gray_gauntlet.sql';

describe(`${MIGRATION} — a plain ADD COLUMN, no recreate`, () => {
  it('is one ADD COLUMN on listing_requests and nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map((s) => s.trim());
    expect(statements).toEqual(['ALTER TABLE `listing_requests` ADD `company_country` text;']);
  });
});

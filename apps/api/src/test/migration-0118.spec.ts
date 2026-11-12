import { describe, expect, it } from 'vitest';

import { statementsForMigration } from './d1';

/**
 * AECI-1619 — `0118_acceptance_policy_and_plans_versions.sql` adds the label text, the
 * two policy versions and the Plans version and hash to `agreement_acceptances`, and the
 * two policy versions to `request_confirmations`. This file is the tripwire on the body.
 *
 * It must stay plain `ADD COLUMN`s. `agreement_acceptances` is the evidence record and
 * append-only, so a drizzle-kit recreate of it (a `DROP TABLE` plus a copy) is a risk to
 * evidence we cannot rebuild (`docs/migrations.md` §0).
 */
const MIGRATION = '0118_acceptance_policy_and_plans_versions.sql';

describe(`${MIGRATION} — plain ADD COLUMNs, no recreate`, () => {
  it('is seven nullable ADD COLUMNs and nothing else', () => {
    const statements = statementsForMigration(MIGRATION).map((s) => s.trim());
    expect(statements).toEqual([
      'ALTER TABLE `agreement_acceptances` ADD `checkbox_label` text;',
      'ALTER TABLE `agreement_acceptances` ADD `listing_accuracy_version` text;',
      'ALTER TABLE `agreement_acceptances` ADD `review_guidelines_version` text;',
      'ALTER TABLE `agreement_acceptances` ADD `plans_page_version` text;',
      'ALTER TABLE `agreement_acceptances` ADD `plans_page_sha256` text;',
      'ALTER TABLE `request_confirmations` ADD `listing_accuracy_version` text;',
      'ALTER TABLE `request_confirmations` ADD `review_guidelines_version` text;',
    ]);
  });
});

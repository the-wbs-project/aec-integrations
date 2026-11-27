import { describe, expect, it } from 'vitest';

import { makeTestDb, migrationFiles, statementsForMigration } from './d1';

/**
 * AECI-2110: `0140_condemned_havok.sql` adds the owner reply, the protest links and
 * the two workflow pointers to `sync_service_pair_contests`
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.5). This file is the tripwire on the body.
 *
 * The table is a cascade child of `integrations` and `connector_evidenced_pairs`, so a
 * drizzle-kit recreate (`__new_…`, `DROP TABLE`) here would be data loss
 * (`docs/migrations.md` §0). Every FK must carry `ON DELETE SET NULL`, which
 * drizzle-kit drops from an `ADD … REFERENCES`.
 */
const MIGRATION = '0140_condemned_havok.sql';

const ADDED = [
  'protest_evidence',
  'protest_reply_due_at',
  'protest_reply',
  'protest_reply_evidence',
  'protest_replied_by',
  'protest_replied_at',
  'workflow_id',
  'protest_workflow_id',
];

describe(`${MIGRATION}: eight bare ADD COLUMNs on sync_service_pair_contests`, () => {
  it('adds the columns and nothing else', () => {
    // The header comment rides on the first statement; strip comment lines.
    const statements = statementsForMigration(MIGRATION).map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    );
    expect(statements).toHaveLength(ADDED.length);
    statements.forEach((s, i) => {
      expect(
        s.startsWith(`ALTER TABLE \`sync_service_pair_contests\` ADD \`${ADDED[i]}\` text`),
      ).toBe(true);
      expect(s).not.toMatch(/__new_|DROP |INSERT INTO|PRAGMA|CHECK/i);
      if (s.includes('REFERENCES')) expect(s).toMatch(/ON DELETE SET NULL;?$/);
    });
  });

  it('is in the migration set the harness applies', () => {
    expect(migrationFiles()).toContain(MIGRATION);
  });

  it('leaves every new FK as ON DELETE SET NULL', async () => {
    const t = await makeTestDb();
    try {
      const fks = t.raw.prepare(`PRAGMA foreign_key_list(sync_service_pair_contests)`).all() as {
        from: string;
        table: string;
        on_delete: string;
      }[];
      const byColumn = new Map(fks.map((f) => [f.from, f]));
      expect(byColumn.get('protest_replied_by')).toMatchObject({
        table: 'profiles',
        on_delete: 'SET NULL',
      });
      expect(byColumn.get('workflow_id')).toMatchObject({
        table: 'workflow_instances',
        on_delete: 'SET NULL',
      });
      expect(byColumn.get('protest_workflow_id')).toMatchObject({
        table: 'workflow_instances',
        on_delete: 'SET NULL',
      });
    } finally {
      t.dispose();
    }
  });
});

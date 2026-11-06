import { REVIEW_UPDATE_STATUSES } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-1613 — `0108_melted_landau.sql`, the `review_updates` table
 * (`DATABASE_SCHEMA.md` §7.4, `STAGE_1_SPEC.md` §4.7a).
 *
 *   1. Purely additive: one CREATE TABLE and three CREATE INDEXes. `reviews` is a
 *      cascade parent of this table and of `review_responses`, so a recreate of any
 *      existing table here would be the dangerous class (`docs/migrations.md` §0).
 *   2. Applied to a SEEDED pre-0108 database, every existing row survives.
 *   3. The hand-written status CHECK is in the live DDL and matches the wire
 *      vocabulary. drizzle-kit cannot see it, so a later recreate would drop it.
 *   4. The ratings are both set or both NULL.
 *   5. One pending update per review; a decided one frees the slot.
 *   6. `review_id` cascades and `moderated_by` sets NULL.
 */
const MIGRATION = '0108_melted_landau.sql';
const NOW = '2026-11-06T00:00:00.000Z';

const count = (t: TestDb, table: string): number =>
  (t.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

function seedBase(t: TestDb): void {
  const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);
  run(
    `INSERT INTO products (id, slug, name, created_at, updated_at) VALUES ('p1','a','A',?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO profiles (id, role, created_at, updated_at) VALUES ('u1','admin',?,?)`,
    NOW,
    NOW,
  );
  for (const id of ['r1', 'r2']) {
    run(
      `INSERT INTO reviews (id, product_id, rating_overall, rating_onboarding, title, body, status, created_at, updated_at)
         VALUES (?, 'p1', 4, 4, 't', 'b', 'approved', ?, ?)`,
      id,
      NOW,
      NOW,
    );
  }
}

function insertUpdate(
  t: TestDb,
  id: string,
  reviewId: string,
  opts: {
    status?: string;
    overall?: number | null;
    onboarding?: number | null;
    moderatedBy?: string | null;
  } = {},
) {
  return t.raw
    .prepare(
      `INSERT INTO review_updates (id, review_id, body, rating_overall, rating_onboarding, status, moderated_by, created_at, updated_at)
         VALUES (?, ?, 'An update', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      reviewId,
      opts.overall ?? null,
      opts.onboarding ?? null,
      opts.status ?? 'pending',
      opts.moderatedBy ?? null,
      NOW,
      NOW,
    );
}

describe(`${MIGRATION} — additive`, () => {
  it('only creates; it alters, drops and recreates nothing', () => {
    const statements = statementsForMigration(MIGRATION);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/CREATE TABLE `review_updates`/);
    for (const s of statements.slice(1)) {
      expect(s).toMatch(/^CREATE (UNIQUE )?INDEX `review_updates_/);
    }
    for (const s of statements) {
      expect(s).not.toMatch(/DROP TABLE|ALTER TABLE|__new_|INSERT INTO|PRAGMA|RENAME/i);
    }
  });

  it('keeps every existing row, on seeded data', async () => {
    const t = await makeTestDb({ upToExclusive: MIGRATION });
    try {
      seedBase(t);
      t.applyMigration(MIGRATION);
      expect(count(t, 'products')).toBe(1);
      expect(count(t, 'profiles')).toBe(1);
      expect(count(t, 'reviews')).toBe(2);
      expect(count(t, 'review_updates')).toBe(0);
    } finally {
      t.dispose();
    }
  });
});

describe(`${MIGRATION} — constraints`, () => {
  it('keeps the hand-written status CHECK in lockstep with REVIEW_UPDATE_STATUSES', async () => {
    const t = await makeTestDb();
    try {
      const ddl = (
        t.raw
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='review_updates'`)
          .get() as { sql: string }
      ).sql;
      expect(ddl).toContain('CONSTRAINT "review_updates_status_check"');
      const check = ddl.match(/"status" IN \(([^)]*)\)/)?.[1] ?? '';
      const inCheck = check
        .split(',')
        .map((v) => v.trim().replace(/^'|'$/g, ''))
        .sort();
      expect(inCheck).toEqual([...REVIEW_UPDATE_STATUSES].sort());

      seedBase(t);
      expect(() => insertUpdate(t, 'x1', 'r1', { status: 'published' })).toThrow(/CHECK/);
    } finally {
      t.dispose();
    }
  });

  it('takes both ratings or neither, each 1..5', async () => {
    const t = await makeTestDb();
    try {
      seedBase(t);
      expect(() => insertUpdate(t, 'a', 'r1', { status: 'approved' })).not.toThrow();
      expect(() =>
        insertUpdate(t, 'b', 'r1', { status: 'approved', overall: 5, onboarding: 4 }),
      ).not.toThrow();
      expect(() => insertUpdate(t, 'c', 'r1', { status: 'approved', overall: 5 })).toThrow(/CHECK/);
      expect(() => insertUpdate(t, 'd', 'r1', { status: 'approved', onboarding: 5 })).toThrow(
        /CHECK/,
      );
      expect(() =>
        insertUpdate(t, 'e', 'r1', { status: 'approved', overall: 6, onboarding: 4 }),
      ).toThrow(/CHECK/);
    } finally {
      t.dispose();
    }
  });

  it('allows one pending update per review, and a decided one frees the slot', async () => {
    const t = await makeTestDb();
    try {
      seedBase(t);
      insertUpdate(t, 'p1', 'r1');
      expect(() => insertUpdate(t, 'p2', 'r1')).toThrow(/UNIQUE/);
      // Another review is its own slot.
      expect(() => insertUpdate(t, 'p3', 'r2')).not.toThrow();
      t.raw.prepare(`UPDATE review_updates SET status = 'rejected' WHERE id = 'p1'`).run();
      expect(() => insertUpdate(t, 'p4', 'r1')).not.toThrow();
    } finally {
      t.dispose();
    }
  });

  it('cascades from reviews and sets moderated_by NULL when the profile goes', async () => {
    const t = await makeTestDb();
    try {
      seedBase(t);
      insertUpdate(t, 'u-a', 'r1', { status: 'approved', moderatedBy: 'u1' });
      insertUpdate(t, 'u-b', 'r2', { status: 'approved', moderatedBy: 'u1' });
      t.raw.prepare(`DELETE FROM profiles WHERE id = 'u1'`).run();
      const nulls = t.raw
        .prepare(`SELECT count(*) AS n FROM review_updates WHERE moderated_by IS NULL`)
        .get() as { n: number };
      expect(nulls.n).toBe(2);
      t.raw.prepare(`DELETE FROM reviews WHERE id = 'r1'`).run();
      expect(count(t, 'review_updates')).toBe(1);
    } finally {
      t.dispose();
    }
  });
});

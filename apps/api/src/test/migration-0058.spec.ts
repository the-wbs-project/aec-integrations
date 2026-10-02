import { REVIEW_RESPONSE_STATUSES } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-1175 — `0058_last_typhoid_mary.sql`, the `review_responses` table
 * (`DATABASE_SCHEMA.md` §7.3, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c).
 *
 *   1. Purely additive: one CREATE TABLE and three CREATE INDEXes, touching no
 *      existing table. `reviews` has been rebuilt once (0027) and is now a cascade
 *      parent of this table, so a recreate here would be the dangerous class.
 *   2. Applied to a SEEDED pre-0058 database, every existing row survives.
 *   3. The status CHECK is written once, and matches the wire vocabulary.
 *   4. The unique index allows one reply per (review, vendor), and a second
 *      vendor may reply to the same review (ruling 4, co-owned products).
 *   5. The cascades are the ones §11c.11 names.
 */
const MIGRATION = '0058_last_typhoid_mary.sql';
const NOW = '2026-10-02T00:00:00.000Z';

const count = (t: TestDb, table: string): number =>
  (t.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

function seedBase(t: TestDb): void {
  const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);
  for (const slug of ['v1', 'v2']) {
    run(
      `INSERT INTO vendors (id, slug, company_name, created_at, updated_at) VALUES (?,?,?,?,?)`,
      slug,
      slug,
      slug.toUpperCase(),
      NOW,
      NOW,
    );
  }
  run(
    `INSERT INTO products (id, slug, name, created_at, updated_at) VALUES ('p1','a','A',?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO product_vendors (product_id, vendor_id, is_primary, created_at)
       VALUES ('p1','v1',1,?), ('p1','v2',0,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO profiles (id, role, created_at, updated_at) VALUES ('u1','vendor_admin',?,?)`,
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

function insertReply(
  t: TestDb,
  id: string,
  reviewId: string,
  vendorId: string,
  status = 'pending',
) {
  return t.raw
    .prepare(
      `INSERT INTO review_responses (id, review_id, vendor_id, author_profile_id, body, status, created_at, updated_at)
         VALUES (?, ?, ?, 'u1', 'Thanks', ?, ?, ?)`,
    )
    .run(id, reviewId, vendorId, status, NOW, NOW);
}

describe(`${MIGRATION} — additive`, () => {
  it('only creates; it alters, drops and recreates nothing', () => {
    const statements = statementsForMigration(MIGRATION);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/^CREATE TABLE `review_responses`/);
    for (const s of statements.slice(1)) {
      expect(s).toMatch(/^CREATE (UNIQUE )?INDEX `review_responses_/);
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
      expect(count(t, 'vendors')).toBe(2);
      expect(count(t, 'products')).toBe(1);
      expect(count(t, 'product_vendors')).toBe(2);
      expect(count(t, 'profiles')).toBe(1);
      expect(count(t, 'reviews')).toBe(2);
      expect(count(t, 'review_responses')).toBe(0);
    } finally {
      t.dispose();
    }
  });

  it('keeps the status CHECK in lockstep with REVIEW_RESPONSE_STATUSES', async () => {
    const t = await makeTestDb();
    try {
      const ddl = (
        t.raw
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='review_responses'`)
          .get() as { sql: string }
      ).sql;
      const check = ddl.match(/"status" IN \(([^)]*)\)/)?.[1] ?? '';
      const inCheck = check
        .split(',')
        .map((v) => v.trim().replace(/^'|'$/g, ''))
        .sort();
      expect(inCheck).toEqual([...REVIEW_RESPONSE_STATUSES].sort());
    } finally {
      t.dispose();
    }
  });

  it('enforces one reply per (review, vendor), and lets a co-owner reply too', async () => {
    const t = await makeTestDb();
    try {
      seedBase(t);
      insertReply(t, 'x1', 'r1', 'v1');
      // A second reply by the same vendor, in any status, is refused.
      expect(() => insertReply(t, 'x2', 'r1', 'v1', 'withdrawn')).toThrow(
        /UNIQUE constraint failed/,
      );
      // The co-owning vendor may reply to the same review (ruling 4).
      insertReply(t, 'x3', 'r1', 'v2');
      // The same vendor may reply to a different review.
      insertReply(t, 'x4', 'r2', 'v1');
      expect(() => insertReply(t, 'x5', 'r2', 'v2', 'approved')).toThrow(/CHECK constraint failed/);
      expect(count(t, 'review_responses')).toBe(3);
    } finally {
      t.dispose();
    }
  });

  it('cascades from reviews and vendors, and sets null from profiles', async () => {
    const t = await makeTestDb();
    try {
      seedBase(t);
      insertReply(t, 'x1', 'r1', 'v1');
      insertReply(t, 'x2', 'r2', 'v2');
      t.raw.prepare(`UPDATE review_responses SET moderated_by = 'u1' WHERE id = 'x2'`).run();

      // Profile delete: the reply survives with both links severed.
      t.raw.prepare(`DELETE FROM profiles WHERE id = 'u1'`).run();
      expect(
        t.raw
          .prepare(`SELECT author_profile_id, moderated_by FROM review_responses WHERE id = 'x2'`)
          .get(),
      ).toEqual({ author_profile_id: null, moderated_by: null });

      // A review delete takes its reply.
      t.raw.prepare(`DELETE FROM reviews WHERE id = 'r1'`).run();
      expect(count(t, 'review_responses')).toBe(1);

      // A vendor delete takes its reply.
      t.raw.prepare(`DELETE FROM vendors WHERE id = 'v2'`).run();
      expect(count(t, 'review_responses')).toBe(0);
    } finally {
      t.dispose();
    }
  });
});

import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-1643 — `0109_curvy_richard_fisk.sql` against NON-EMPTY data.
 *
 * The migration widens `reviews_status_check` to admit `removed` and adds
 * `removed_at` + `removal_reason`. On SQLite that is a full recreate of `reviews`,
 * which is the cascade parent of `review_responses` and `review_updates`
 * (both `ON DELETE CASCADE`). `DROP TABLE` fires those cascades and
 * `PRAGMA defer_foreign_keys` does not stop it (`docs/migrations.md` §3.3a), so the
 * drizzle-kit order keeps every review and deletes every reply and every update.
 *
 * The cases seed the PRE-0109 shape, apply the one migration, and assert:
 *   1. CONSERVATION — every row in all three tables survives, values intact.
 *   2. The generated order really is the hazard (measured here, not theorised).
 *   3. `removed` is accepted and an unknown status is refused.
 *   4. The unique index still ignores only `archived`, so `removed` blocks a re-post.
 *   5. Both children still cascade, and their hand-written CHECKs survive.
 *   6. `verified_work_email` is carried, not dropped (AECI-1533 owns that drop).
 */
const MIGRATION = '0109_curvy_richard_fisk.sql';
const NOW = '2026-11-09T00:00:00.000Z';

const count = (t: TestDb, table: string): number =>
  (t.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

const ddl = (t: TestDb, table: string): string =>
  (
    t.raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as {
      sql: string;
    }
  ).sql;

const REVIEW_STATUSES = ['pending', 'approved', 'rejected', 'archived'] as const;

async function seedPre0109(): Promise<TestDb> {
  const t = await makeTestDb({ upToExclusive: MIGRATION });
  const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);
  run(
    `INSERT INTO vendors (id, slug, company_name, created_at, updated_at) VALUES ('v1','v','V',?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO products (id, slug, name, created_at, updated_at) VALUES ('p1','a','A',?,?)`,
    NOW,
    NOW,
  );
  for (const u of ['u-admin', 'u1', 'u2', 'u3', 'u4']) {
    run(
      `INSERT INTO profiles (id, role, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      u,
      u === 'u-admin' ? 'admin' : 'reviewer',
      NOW,
      NOW,
    );
  }
  // One review per status, each with distinctive values in every column.
  REVIEW_STATUSES.forEach((status, i) => {
    run(
      `INSERT INTO reviews (id, product_id, reviewer_id, anonymized_at, rating_overall, rating_onboarding,
         title, body, role_at_company, years_using, would_recommend, reviewer_firm, status,
         rejection_reason, moderated_at, moderated_by, toxicity_score, verified_work_email, locale,
         created_at, updated_at)
       VALUES (?, 'p1', ?, NULL, ?, ?, ?, ?, 'manager', ?, 'yes', ?, ?, ?, ?, 'u-admin', ?, ?, 'en-US', ?, ?)`,
      `r-${status}`,
      `u${i + 1}`,
      i + 1,
      5 - i,
      `Title ${status}`,
      `Body ${status}`,
      i,
      `Firm ${i}`,
      status,
      status === 'rejected' ? 'Off-topic' : null,
      NOW,
      i * 10,
      i % 2,
      `2026-11-0${i + 1}T00:00:00.000Z`,
      NOW,
    );
  });
  // An anonymized review: no reviewer, stamped.
  run(
    `INSERT INTO reviews (id, product_id, reviewer_id, anonymized_at, rating_overall, rating_onboarding,
       title, body, status, created_at, updated_at)
     VALUES ('r-anon', 'p1', NULL, ?, 3, 3, 'Anon', 'Anon body', 'approved', ?, ?)`,
    NOW,
    NOW,
    NOW,
  );
  // Two vendor replies and two reviewer updates on approved reviews.
  for (const [id, reviewId, status] of [
    ['rr1', 'r-approved', 'published'],
    ['rr2', 'r-anon', 'pending'],
  ] as const) {
    run(
      `INSERT INTO review_responses (id, review_id, vendor_id, author_profile_id, body, status,
         moderated_by, moderated_at, published_at, created_at, updated_at)
       VALUES (?, ?, 'v1', 'u-admin', ?, ?, 'u-admin', ?, ?, ?, ?)`,
      id,
      reviewId,
      `Reply ${id}`,
      status,
      NOW,
      status === 'published' ? NOW : null,
      NOW,
      NOW,
    );
  }
  for (const [id, reviewId, status, rating] of [
    ['ru1', 'r-approved', 'approved', 2],
    ['ru2', 'r-anon', 'pending', null],
  ] as const) {
    run(
      `INSERT INTO review_updates (id, review_id, body, rating_overall, rating_onboarding, status,
         moderated_by, moderated_at, published_at, toxicity_score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'u-admin', ?, ?, 7, ?, ?)`,
      id,
      reviewId,
      `Update ${id}`,
      rating,
      rating,
      status,
      NOW,
      status === 'approved' ? NOW : null,
      NOW,
      NOW,
    );
  }
  return t;
}

const snapshot = (t: TestDb, table: string, cols: string) =>
  t.raw.prepare(`SELECT ${cols} FROM ${table} ORDER BY id`).all();

const REVIEW_COLS =
  'id, product_id, reviewer_id, anonymized_at, rating_overall, rating_onboarding, title, body, role_at_company, years_using, would_recommend, reviewer_firm, status, rejection_reason, moderated_at, moderated_by, toxicity_score, verified_work_email, locale, created_at, updated_at';

describe(`${MIGRATION} — conservation on seeded data`, () => {
  it('keeps every review, every reply and every update, values intact', async () => {
    const t = await seedPre0109();
    try {
      const before = {
        reviews: snapshot(t, 'reviews', REVIEW_COLS),
        responses: snapshot(t, 'review_responses', '*'),
        updates: snapshot(t, 'review_updates', '*'),
      };
      expect(before.reviews).toHaveLength(5);
      expect(before.responses).toHaveLength(2);
      expect(before.updates).toHaveLength(2);

      t.applyMigration(MIGRATION);

      expect(snapshot(t, 'reviews', REVIEW_COLS)).toEqual(before.reviews);
      expect(snapshot(t, 'review_responses', '*')).toEqual(before.responses);
      expect(snapshot(t, 'review_updates', '*')).toEqual(before.updates);
      // No existing review is removed: both new columns land NULL.
      expect(
        t.raw
          .prepare(
            `SELECT count(*) AS n FROM reviews WHERE removed_at IS NOT NULL OR removal_reason IS NOT NULL`,
          )
          .get(),
      ).toEqual({ n: 0 });
      // No carry table is left behind, and the FK graph is clean.
      expect(
        t.raw.prepare(`SELECT name FROM sqlite_master WHERE name LIKE '__carry_%'`).all(),
      ).toEqual([]);
      expect(t.raw.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    } finally {
      t.dispose();
    }
  });

  it('the generated drizzle-kit order is the hazard: it deletes every reply and update', async () => {
    // A faithful rendering of drizzle-kit's recreate (minus the new columns, which
    // made the raw output fail outright). Kept so the claim in the migration header
    // is measured, not assumed.
    const t = await seedPre0109();
    try {
      t.raw.exec(`PRAGMA defer_foreign_keys = true`);
      const createSql = ddl(t, 'reviews').replace(
        'CREATE TABLE `reviews`',
        'CREATE TABLE `__new_reviews`',
      );
      t.raw.exec(createSql);
      t.raw.exec(`INSERT INTO __new_reviews SELECT * FROM reviews`);
      t.raw.exec(`DROP TABLE reviews`);
      t.raw.exec(`ALTER TABLE __new_reviews RENAME TO reviews`);
      expect(count(t, 'reviews')).toBe(5);
      expect(count(t, 'review_responses')).toBe(0);
      expect(count(t, 'review_updates')).toBe(0);
    } finally {
      t.dispose();
    }
  });

  it('is the dangerous-class shape: carries before the drop, restores after', () => {
    const statements = statementsForMigration(MIGRATION);
    const idx = (re: RegExp) => statements.findIndex((s) => re.test(s));
    const drop = idx(/^DROP TABLE `reviews`/m);
    expect(idx(/^PRAGMA defer_foreign_keys = true/m)).toBe(0);
    expect(statements.some((s) => /^PRAGMA foreign_keys/im.test(s))).toBe(false);
    expect(idx(/CREATE TABLE `__carry_review_responses`/)).toBeLessThan(drop);
    expect(idx(/CREATE TABLE `__carry_review_updates`/)).toBeLessThan(drop);
    expect(idx(/^DELETE FROM `review_responses`/m)).toBeLessThan(drop);
    expect(idx(/^DELETE FROM `review_updates`/m)).toBeLessThan(drop);
    expect(idx(/INSERT INTO `review_responses`/)).toBeGreaterThan(drop);
    expect(idx(/INSERT INTO `review_updates`/)).toBeGreaterThan(drop);
  });
});

describe(`${MIGRATION} — the widened CHECK`, () => {
  it('accepts removed with its stamp and refuses an unknown status', async () => {
    const t = await seedPre0109();
    try {
      t.applyMigration(MIGRATION);
      t.raw
        .prepare(
          `UPDATE reviews SET status='removed', removed_at=?, removal_reason='Breach' WHERE id='r-approved'`,
        )
        .run(NOW);
      expect(
        t.raw.prepare(`SELECT status, removal_reason FROM reviews WHERE id='r-approved'`).get(),
      ).toEqual({ status: 'removed', removal_reason: 'Breach' });
      expect(() =>
        t.raw.prepare(`UPDATE reviews SET status='deleted' WHERE id='r-pending'`).run(),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      t.dispose();
    }
  });

  it('keeps a removed review blocking a re-post by the same reviewer', async () => {
    const t = await seedPre0109();
    try {
      t.applyMigration(MIGRATION);
      t.raw.prepare(`UPDATE reviews SET status='removed' WHERE id='r-approved'`).run();
      const repost = () =>
        t.raw
          .prepare(
            `INSERT INTO reviews (id, product_id, reviewer_id, rating_overall, rating_onboarding, title, body, created_at, updated_at)
               VALUES ('r-new', 'p1', 'u2', 4, 4, 't', 'b', ?, ?)`,
          )
          .run(NOW, NOW);
      expect(repost).toThrow(/UNIQUE constraint failed/);
      // An archived one still frees the slot, as before.
      t.raw.prepare(`UPDATE reviews SET status='archived' WHERE id='r-approved'`).run();
      expect(repost).not.toThrow();
    } finally {
      t.dispose();
    }
  });
});

describe(`${MIGRATION} — what the recreate must not lose`, () => {
  it('both children still cascade from reviews, and their hand-written CHECKs survive', async () => {
    const t = await seedPre0109();
    try {
      t.applyMigration(MIGRATION);
      expect(ddl(t, 'review_updates')).toContain('CONSTRAINT "review_updates_status_check"');
      expect(ddl(t, 'review_responses')).toContain('CONSTRAINT "review_responses_status_check"');
      t.raw.prepare(`DELETE FROM reviews WHERE id='r-approved'`).run();
      expect(count(t, 'review_responses')).toBe(1);
      expect(count(t, 'review_updates')).toBe(1);
    } finally {
      t.dispose();
    }
  });

  it('keeps every index and carries verified_work_email', async () => {
    const t = await seedPre0109();
    try {
      t.applyMigration(MIGRATION);
      const indexes = t.raw
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='reviews' AND sql IS NOT NULL ORDER BY name`,
        )
        .all()
        .map((r) => (r as { name: string }).name);
      expect(indexes).toEqual([
        'reviews_product_status_idx',
        'reviews_reviewer_idx',
        'reviews_status_created_idx',
        'reviews_unique_per_user_product',
      ]);
      expect(ddl(t, 'reviews')).toMatch(/`verified_work_email` integer DEFAULT false NOT NULL/);
      // The Worker never writes it: an insert without it still succeeds.
      t.raw
        .prepare(
          `INSERT INTO reviews (id, product_id, rating_overall, rating_onboarding, title, body, created_at, updated_at)
             VALUES ('r-x', 'p1', 4, 4, 't', 'b', ?, ?)`,
        )
        .run(NOW, NOW);
    } finally {
      t.dispose();
    }
  });
});

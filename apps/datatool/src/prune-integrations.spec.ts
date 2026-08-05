/**
 * Prune-orphaned-integrations engine specs. Run against the real-SQLite shim
 * (`test/d1.ts`) with the actual apps/api migrations applied, so the FK cascades
 * and CHECK constraints under test are the production ones, not a mock.
 *
 * The fixture deliberately builds a TWIN pair — two integration rows with the
 * same (source, target, mechanism_name), one "surviving" and one "orphan" — since
 * every guard is defined relative to that twin.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_PRUNE_IDS, parseIds, pruneExecute, prunePlan } from './prune-integrations';
import { makeShimDb, type ShimHandle } from './test/d1';

const TS = '2026-01-01T00:00:00.000Z';

const SURVIVOR = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORPHAN = 'bbbbbbbb-0000-4000-8000-000000000002';

/**
 * Two promoted products joined by TWO identical integration rows (a survivor and
 * its orphan twin), each carrying one claim + one attestation.
 * `integration_count` is seeded at 2 per product — the pre-prune (wrong) value.
 */
function seedTwins(raw: Database.Database): void {
  raw
    .prepare(
      "INSERT INTO products (id, slug, name, promotion_status, integration_count, created_at, updated_at) VALUES ('prod-1','procore','Procore','promoted',2,?,?)",
    )
    .run(TS, TS);
  raw
    .prepare(
      "INSERT INTO products (id, slug, name, promotion_status, integration_count, created_at, updated_at) VALUES ('prod-2','smartsheet','Smartsheet','promoted',2,?,?)",
    )
    .run(TS, TS);
  raw
    .prepare(
      "INSERT INTO taxonomy_data_objects (id, slug, name, display_order, created_at, updated_at) VALUES ('do-1','rfis','RFIs',10,?,?)",
    )
    .run(TS, TS);

  const ins = raw.prepare(
    `INSERT INTO integrations (id, name, source_product_id, target_product_id, mechanism_kind, mechanism_name, description, notes, created_at, updated_at)
     VALUES (?, ?, 'prod-1', 'prod-2', 'native', 'Procore Embedded Experience', ?, ?, ?, ?)`,
  );
  ins.run(SURVIVOR, 'Survivor', 'a description', 'notes', TS, TS);
  ins.run(ORPHAN, 'Orphan twin', 'a description', 'notes', TS, TS);

  const claim = raw.prepare(
    "INSERT INTO claims (id, integration_id, data_object_id, direction, created_at, updated_at) VALUES (?, ?, 'do-1', 'a_to_b', ?, ?)",
  );
  claim.run('claim-survivor', SURVIVOR, TS, TS);
  claim.run('claim-orphan', ORPHAN, TS, TS);

  const att = raw.prepare(
    "INSERT INTO attestations (id, claim_id, source, asserted, created_at, updated_at) VALUES (?, ?, 'aeci', 1, ?, ?)",
  );
  att.run('att-survivor', 'claim-survivor', TS, TS);
  att.run('att-orphan', 'claim-orphan', TS, TS);
}

describe('parseIds', () => {
  it('accepts a pasted blob across newlines and commas, lowercased and deduped', () => {
    expect(parseIds(`${SURVIVOR}\n${ORPHAN.toUpperCase()},  ${SURVIVOR}`)).toEqual([
      SURVIVOR,
      ORPHAN,
    ]);
  });

  it('accepts a JSON array', () => {
    expect(parseIds([SURVIVOR])).toEqual([SURVIVOR]);
  });

  it('throws on a non-UUID rather than silently dropping it', () => {
    // Silently skipping a typo would shrink the set the operator thinks they reviewed.
    expect(() => parseIds(`${SURVIVOR}\nnot-a-uuid`)).toThrow(/Not a UUID/);
  });

  it('throws on an empty list', () => {
    expect(() => parseIds('')).toThrow(/No integration ids/);
    expect(() => parseIds(undefined)).toThrow(/No integration ids/);
  });

  it('refuses more than MAX_PRUNE_IDS', () => {
    const many = Array.from(
      { length: MAX_PRUNE_IDS + 1 },
      (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(() => parseIds(many)).toThrow(/Refusing to prune/);
  });
});

describe('prunePlan', () => {
  let h: ShimHandle;
  beforeEach(() => {
    h = makeShimDb();
    seedTwins(h.raw);
  });
  afterEach(() => h.dispose());

  it('reports the footprint, clears all guards, and lists affected slugs for a real twin', async () => {
    const plan = await prunePlan(h.db, [ORPHAN]);

    expect(plan.requested).toBe(1);
    expect(plan.found).toBe(1);
    expect(plan.missing).toEqual([]);
    expect(plan.footprint).toEqual({ integrations: 1, claims: 1, attestations: 1 });
    expect(plan.guards).toEqual({
      claimsUniqueToOrphans: 0,
      orphansWithoutATwin: 0,
      orphansRicherThanTwin: 0,
    });
    expect(plan.blocked).toEqual([]);
    expect(plan.affectedSlugs).toEqual(['procore', 'smartsheet']);
    expect(plan.rows[0]).toMatchObject({ sourceSlug: 'procore', targetSlug: 'smartsheet' });
  });

  it('emits rollback SQL parent → child so a replay satisfies the FKs', async () => {
    const { rollbackSql } = await prunePlan(h.db, [ORPHAN]);

    const iAt = rollbackSql.indexOf('INSERT OR IGNORE INTO "integrations"');
    const cAt = rollbackSql.indexOf('INSERT OR IGNORE INTO "claims"');
    const aAt = rollbackSql.indexOf('INSERT OR IGNORE INTO "attestations"');
    expect(iAt).toBeGreaterThan(-1);
    expect(iAt).toBeLessThan(cAt);
    expect(cAt).toBeLessThan(aAt);
    // OR IGNORE keeps a partial replay safe to re-run.
    expect(rollbackSql).not.toMatch(/INSERT INTO/);
  });

  it('blocks when the orphan has no twin (it is the only copy, not a duplicate)', async () => {
    h.raw.prepare('DELETE FROM integrations WHERE id = ?').run(SURVIVOR);

    const plan = await prunePlan(h.db, [ORPHAN]);
    expect(plan.guards.orphansWithoutATwin).toBe(1);
    expect(plan.blocked).toContain('orphansWithoutATwin');
  });

  it('blocks when a claim exists only on the orphan (cascade would destroy curation)', async () => {
    h.raw.prepare('DELETE FROM claims WHERE id = ?').run('claim-survivor');

    const plan = await prunePlan(h.db, [ORPHAN]);
    expect(plan.guards.claimsUniqueToOrphans).toBe(1);
    expect(plan.blocked).toContain('claimsUniqueToOrphans');
  });

  it('blocks when the orphan carries richer editorial content than its twin', async () => {
    h.raw
      .prepare('UPDATE integrations SET description = ? WHERE id = ?')
      .run('a much longer, hand-written description', ORPHAN);

    const plan = await prunePlan(h.db, [ORPHAN]);
    expect(plan.guards.orphansRicherThanTwin).toBe(1);
    expect(plan.blocked).toContain('orphansRicherThanTwin');
  });

  it('reports unmatched ids as missing instead of failing', async () => {
    const ghost = 'cccccccc-0000-4000-8000-000000000003';
    const plan = await prunePlan(h.db, [ORPHAN, ghost]);
    expect(plan.found).toBe(1);
    expect(plan.missing).toEqual([ghost]);
  });
});

describe('pruneExecute', () => {
  let h: ShimHandle;
  beforeEach(() => {
    h = makeShimDb();
    seedTwins(h.raw);
  });
  afterEach(() => h.dispose());

  it('deletes child → parent, leaves the twin intact, and repairs integration_count', async () => {
    const plan = await prunePlan(h.db, [ORPHAN]);
    const result = await pruneExecute(h.db, [ORPHAN], plan.affectedProductIds);

    expect(result.deleted).toEqual({ integrations: 1, claims: 1, attestations: 1 });
    expect(result.remaining.integrations).toBe(1);

    // The survivor and its whole claim chain are untouched.
    expect(h.raw.prepare('SELECT id FROM integrations').all()).toEqual([{ id: SURVIVOR }]);
    expect(h.raw.prepare('SELECT id FROM claims').all()).toEqual([{ id: 'claim-survivor' }]);
    expect(h.raw.prepare('SELECT id FROM attestations').all()).toEqual([{ id: 'att-survivor' }]);

    // The denormalized count is corrected as part of THIS operation — leaving it
    // to a follow-up CLI run is how drift ships to production.
    expect(result.recounted).toEqual(
      expect.arrayContaining([
        { productId: 'prod-1', from: 2, to: 1 },
        { productId: 'prod-2', from: 2, to: 1 },
      ]),
    );
    const counts = h.raw
      .prepare('SELECT slug, integration_count AS c FROM products ORDER BY slug')
      .all();
    expect(counts).toEqual([
      { slug: 'procore', c: 1 },
      { slug: 'smartsheet', c: 1 },
    ]);
  });

  it('produces rollback SQL that restores the deleted rows verbatim', async () => {
    const plan = await prunePlan(h.db, [ORPHAN]);
    await pruneExecute(h.db, [ORPHAN], plan.affectedProductIds);
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 1 });

    for (const stmt of plan.rollbackSql.split('\n').filter((l) => l.startsWith('INSERT'))) {
      h.raw.prepare(stmt).run();
    }

    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 2 });
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM claims').get()).toEqual({ n: 2 });
    expect(h.raw.prepare('SELECT COUNT(*) AS n FROM attestations').get()).toEqual({ n: 2 });
    const restored = h.raw
      .prepare('SELECT name, description FROM integrations WHERE id = ?')
      .get(ORPHAN);
    expect(restored).toEqual({ name: 'Orphan twin', description: 'a description' });
  });

  it('escapes quotes in rollback literals', async () => {
    h.raw.prepare('UPDATE integrations SET name = ? WHERE id = ?').run("O'Brien's sync", ORPHAN);

    const plan = await prunePlan(h.db, [ORPHAN]);
    await pruneExecute(h.db, [ORPHAN], plan.affectedProductIds);
    for (const stmt of plan.rollbackSql.split('\n').filter((l) => l.startsWith('INSERT'))) {
      h.raw.prepare(stmt).run();
    }

    expect(h.raw.prepare('SELECT name FROM integrations WHERE id = ?').get(ORPHAN)).toEqual({
      name: "O'Brien's sync",
    });
  });
});

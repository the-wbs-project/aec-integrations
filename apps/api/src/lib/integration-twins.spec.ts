/**
 * `strongMatchWhere` (AECI-1484): the `+mechanism_kind` form.
 *
 * The unary plus only changes which index drives the plan. These pin that the
 * matched rows are the same as the plain `mechanism_kind` comparison, for a value,
 * for NULL and for "any kind", and that the endpoint indexes now drive the plan.
 */

import { and, eq, isNull, or } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { integrations, products } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { strongMatchWhere, type TwinCandidate } from './integration-twins';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = u(1);
const B = u(2);
const C = u(3);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(products).values([
    { id: A, slug: 'a', name: 'A' },
    { id: B, slug: 'b', name: 'B' },
    { id: C, slug: 'c', name: 'C' },
  ]);
  await t.db.insert(integrations).values([
    { id: u(10), sourceProductId: A, targetProductId: B, mechanismKind: 'api' },
    // Reverse orientation, same kind: still a twin.
    { id: u(11), sourceProductId: B, targetProductId: A, mechanismKind: 'api' },
    { id: u(12), sourceProductId: A, targetProductId: B, mechanismKind: 'native' },
    { id: u(13), sourceProductId: A, targetProductId: B, mechanismKind: null },
    // Same kind, other pair: never a twin.
    { id: u(14), sourceProductId: A, targetProductId: C, mechanismKind: 'api' },
  ]);
});
afterEach(() => t.dispose());

const base: Omit<TwinCandidate, 'mechanismKind'> = {
  productIds: [A, B],
  poweredByProductId: null,
  ownerVendorId: null,
};

/** The pre-AECI-1484 predicate: a plain comparison on the column. */
function legacyWhere(kind: string | null | undefined) {
  const pair = or(
    and(eq(integrations.sourceProductId, A), eq(integrations.targetProductId, B)),
    and(eq(integrations.sourceProductId, B), eq(integrations.targetProductId, A)),
  );
  const k =
    kind === undefined
      ? undefined
      : kind === null
        ? isNull(integrations.mechanismKind)
        : eq(integrations.mechanismKind, kind);
  return and(pair, isNull(integrations.poweredByProductId), k);
}

const ids = async (where: ReturnType<typeof legacyWhere>) =>
  (await t.db.select({ id: integrations.id }).from(integrations).where(where))
    .map((r) => r.id)
    .sort();

describe('strongMatchWhere', () => {
  it.each([
    ['a kind', 'api', [u(10), u(11)]],
    ['NULL kind', null, [u(13)]],
    ['any kind', undefined, [u(10), u(11), u(12), u(13)]],
  ] as const)('matches the same rows as the plain comparison for %s', async (_, kind, want) => {
    const current = await ids(strongMatchWhere({ ...base, mechanismKind: kind }));
    expect(current).toEqual(await ids(legacyWhere(kind)));
    expect(current).toEqual([...want].sort());
  });

  it('drives the plan off the endpoint indexes, not the kind index', () => {
    const { sql, params } = t.db
      .select({ id: integrations.id })
      .from(integrations)
      .where(strongMatchWhere({ ...base, mechanismKind: 'api' }))
      .toSQL();
    const plan = (
      t.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]
    ).map((r) => r.detail);
    expect(plan.join('\n')).not.toContain('integrations_mechanism_kind_idx');
    expect(plan.join('\n')).toMatch(/integrations_(source|target)_idx/);
  });
});

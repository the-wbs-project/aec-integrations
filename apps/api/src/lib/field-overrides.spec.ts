/**
 * `lockedFieldsByEntity` under D1's 100-bound-parameter cap.
 *
 * better-sqlite3 accepts an over-cap `IN (…)` list, so a plain harness run cannot see
 * the failure. This spec wraps `prepare` to reject any statement binding more than 100
 * parameters, the way D1 does (`too many SQL variables`). A 153-integration vendor hit
 * exactly that on `GET /api/vendor/integrations` on demo.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fieldOverrides } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { lockedFieldsByEntity } from './field-overrides';

const D1_MAX_BOUND_PARAMS = 100;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  const prepare = t.raw.prepare.bind(t.raw);
  t.raw.prepare = ((source: string) => {
    const params = source.match(/\?/g)?.length ?? 0;
    if (params > D1_MAX_BOUND_PARAMS) {
      throw new Error(`too many SQL variables: ${params}`);
    }
    return prepare(source);
  }) as typeof t.raw.prepare;
});

afterEach(() => t.dispose());

describe('lockedFieldsByEntity', () => {
  it('reads more ids than D1 binds in one query, chunked', async () => {
    const ids = Array.from({ length: 153 }, (_, i) => uuid(i + 1));
    await t.db.insert(fieldOverrides).values([
      {
        entityType: 'integration',
        entityId: ids[0]!,
        field: 'docs_url',
        value: 'https://a.example/old',
        reason: 'older',
        setAt: '2026-10-01T00:00:00.000Z',
      },
      {
        entityType: 'integration',
        entityId: ids[0]!,
        field: 'description',
        value: 'Corrected',
        reason: 'newer',
        setAt: '2026-10-02T00:00:00.000Z',
      },
      {
        entityType: 'integration',
        entityId: ids[152]!,
        field: 'docs_url',
        value: 'https://b.example',
        reason: 'last chunk',
        setAt: '2026-10-03T00:00:00.000Z',
      },
      {
        entityType: 'integration',
        entityId: ids[100]!,
        field: 'docs_url',
        value: null,
        reason: 'lifted',
        setAt: '2026-10-03T00:00:00.000Z',
        liftedAt: '2026-10-04T00:00:00.000Z',
      },
      {
        entityType: 'product',
        entityId: ids[50]!,
        field: 'docs_url',
        value: null,
        reason: 'other entity type',
        setAt: '2026-10-03T00:00:00.000Z',
      },
    ]);

    const locks = await lockedFieldsByEntity(t.db, 'integration', ids);

    expect([...locks.keys()].sort()).toEqual([ids[0], ids[152]]);
    expect(locks.get(ids[0]!)?.map((l) => l.reason)).toEqual(['newer', 'older']);
    expect(locks.get(ids[152]!)).toEqual([
      { field: 'docs_url', reason: 'last chunk', set_at: '2026-10-03T00:00:00.000Z' },
    ]);
  });

  it('reads nothing for an empty id list', async () => {
    expect((await lockedFieldsByEntity(t.db, 'integration', [])).size).toBe(0);
  });
});

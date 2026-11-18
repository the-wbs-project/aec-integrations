/**
 * `lockedFieldsByEntity` under D1's 100-bound-parameter cap, and its holder-only reason
 * (AECI-1668).
 *
 * better-sqlite3 accepts an over-cap `IN (…)` list, so a plain harness run cannot see
 * the failure. This spec wraps `prepare` to reject any statement binding more than 100
 * parameters, the way D1 does (`too many SQL variables`). A 153-integration vendor hit
 * exactly that on `GET /api/vendor/integrations` on demo.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fieldOverrides } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  PRODUCT_OVERRIDE_COLUMNS,
  lockedFieldsByEntity,
  screenLockedPatch,
} from './field-overrides';

const D1_MAX_BOUND_PARAMS = 100;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HOLDER = 'vendor-holder';
const OTHER = 'vendor-other';

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
        vendorId: HOLDER,
        setAt: '2026-10-01T00:00:00.000Z',
      },
      {
        entityType: 'integration',
        entityId: ids[0]!,
        field: 'description',
        value: 'Corrected',
        reason: 'newer',
        vendorId: HOLDER,
        setAt: '2026-10-02T00:00:00.000Z',
      },
      {
        entityType: 'integration',
        entityId: ids[152]!,
        field: 'docs_url',
        value: 'https://b.example',
        reason: 'last chunk',
        vendorId: HOLDER,
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

    const locks = await lockedFieldsByEntity(t.db, 'integration', ids, HOLDER);

    expect([...locks.keys()].sort()).toEqual([ids[0], ids[152]]);
    expect(locks.get(ids[0]!)?.map((l) => l.reason)).toEqual(['newer', 'older']);
    expect(locks.get(ids[152]!)).toEqual([
      {
        field: 'docs_url',
        reason: 'last chunk',
        set_at: '2026-10-03T00:00:00.000Z',
        source_url: null,
      },
    ]);
  });

  it('reads nothing for an empty id list', async () => {
    expect((await lockedFieldsByEntity(t.db, 'integration', [], HOLDER)).size).toBe(0);
  });

  describe('the reason goes to the holder only (AECI-1668, §11d.5)', () => {
    const id = uuid(1);
    const orphan = uuid(2);
    const SOURCE = 'https://source.example/fact';

    beforeEach(async () => {
      await t.db.insert(fieldOverrides).values([
        {
          entityType: 'integration',
          entityId: id,
          field: 'docs_url',
          value: 'https://a.example',
          reason: 'For the holder',
          sourceUrl: SOURCE,
          vendorId: HOLDER,
          setAt: '2026-10-01T00:00:00.000Z',
        },
        {
          entityType: 'integration',
          entityId: orphan,
          field: 'docs_url',
          value: 'https://b.example',
          reason: 'Nobody told',
          sourceUrl: SOURCE,
          vendorId: null,
          setAt: '2026-10-01T00:00:00.000Z',
        },
      ]);
    });

    it('gives the holder the reason and the source', async () => {
      const locks = await lockedFieldsByEntity(t.db, 'integration', [id], HOLDER);
      expect(locks.get(id)).toEqual([
        {
          field: 'docs_url',
          reason: 'For the holder',
          set_at: '2026-10-01T00:00:00.000Z',
          source_url: SOURCE,
        },
      ]);
    });

    it('gives any other vendor the field, date and public source, never the reason', async () => {
      const locks = await lockedFieldsByEntity(t.db, 'integration', [id], OTHER);
      expect(locks.get(id)).toEqual([
        {
          field: 'docs_url',
          reason: null,
          set_at: '2026-10-01T00:00:00.000Z',
          source_url: SOURCE,
        },
      ]);
    });

    it('shows a lock with no vendor_id, or to a null viewer, with no reason', async () => {
      const byHolder = await lockedFieldsByEntity(t.db, 'integration', [orphan], HOLDER);
      expect(byHolder.get(orphan)?.[0]?.reason).toBeNull();
      const byNobody = await lockedFieldsByEntity(t.db, 'integration', [id], null);
      expect(byNobody.get(id)?.[0]?.reason).toBeNull();
    });
  });
});

describe('screenLockedPatch on a product facet (AECI-1382)', () => {
  const lock = (field: string) => ({ field, reason: 'r', set_at: '2026-10-04T00:00:00.000Z' });
  const stored = { website: 'https://a.example' };
  const facets = { category_slugs: ['bim', 'structural'] };

  it('drops the same set in any order, repeats included', () => {
    const out = screenLockedPatch(
      { category_slugs: ['structural', 'bim', 'bim'], description: 'x' },
      [lock('category_slugs')],
      stored,
      PRODUCT_OVERRIDE_COLUMNS,
      facets,
    );
    expect(out).toEqual({ payload: { description: 'x' }, refused: [] });
  });

  it('refuses a different set, a subset and an empty set', () => {
    for (const sent of [['bim'], ['bim', 'structural', 'mep'], [], ['bim', 'mep']]) {
      const out = screenLockedPatch(
        { category_slugs: sent },
        [lock('category_slugs')],
        stored,
        PRODUCT_OVERRIDE_COLUMNS,
        facets,
      );
      expect(out.refused).toEqual(['category_slugs']);
    }
  });

  it('drops [] against a stored empty set', () => {
    const out = screenLockedPatch(
      { trade_slugs: [] },
      [lock('trade_slugs')],
      stored,
      PRODUCT_OVERRIDE_COLUMNS,
      { trade_slugs: [] },
    );
    expect(out).toEqual({ payload: {}, refused: [] });
  });

  it('fails closed when the caller did not load the stored set', () => {
    const out = screenLockedPatch(
      { category_slugs: ['bim', 'structural'] },
      [lock('category_slugs')],
      stored,
      PRODUCT_OVERRIDE_COLUMNS,
    );
    expect(out.refused).toEqual(['category_slugs']);
  });

  it('still compares a column lock by value beside a facet lock', () => {
    const out = screenLockedPatch(
      { website: 'https://a.example', category_slugs: ['bim', 'structural'] },
      [lock('website'), lock('category_slugs')],
      stored,
      PRODUCT_OVERRIDE_COLUMNS,
      facets,
    );
    expect(out).toEqual({ payload: {}, refused: [] });
  });
});

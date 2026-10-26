/**
 * `earliestAuditDay` / `earliestCatalogRowDay` (AECI-1484).
 *
 * Both moved from `min(substr(created_at, 1, 10))` to `substr(min(created_at), 1,
 * 10)`, so SQLite can answer a bare `min()` off the index instead of walking every
 * entry. The two must agree: the day prefix of an ISO string is monotonic under
 * BINARY ordering. These pin that on rows that share a day, rows written out of
 * order, and (for the catalog floor) an older retired row that must not count.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, integrations, products } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { earliestAuditDay, earliestCatalogRowDay } from './admin-analytics';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

describe('earliestAuditDay', () => {
  it('is null on an empty log', async () => {
    expect(await earliestAuditDay(t.db)).toBeNull();
  });

  it('agrees with the min(substr(…)) form on rows inserted out of order', async () => {
    await t.db.insert(auditLog).values(
      [
        '2026-09-03T12:00:00.000Z',
        '2026-08-17T23:59:59.999Z',
        '2026-08-17T00:00:00.001Z',
        '2026-10-01T00:00:00.000Z',
      ].map((createdAt, i) => ({
        id: u(100 + i),
        actorType: 'system',
        action: 'x.y',
        createdAt,
      })),
    );
    const legacy = t.raw
      .prepare('SELECT min(substr(created_at, 1, 10)) AS day FROM audit_log')
      .get() as { day: string };
    expect(await earliestAuditDay(t.db)).toBe(legacy.day);
    expect(legacy.day).toBe('2026-08-17');
  });
});

describe('earliestCatalogRowDay', () => {
  it('agrees with the min(substr(…)) form and skips a retired row', async () => {
    await t.db.insert(products).values([
      { id: u(1), slug: 'a', name: 'A', createdAt: '2026-07-04T10:00:00.000Z' },
      { id: u(2), slug: 'b', name: 'B', createdAt: '2026-06-30T10:00:00.000Z' },
    ]);
    await t.db.insert(integrations).values([
      // Older, but retired: not in the catalogue, so not the floor.
      {
        id: u(10),
        sourceProductId: u(1),
        targetProductId: u(2),
        createdAt: '2026-07-01T00:00:00.000Z',
        retiredAt: '2026-07-02T00:00:00.000Z',
      },
      {
        id: u(11),
        sourceProductId: u(2),
        targetProductId: u(1),
        createdAt: '2026-07-09T08:00:00.000Z',
      },
    ]);

    const legacyProducts = t.raw
      .prepare('SELECT min(substr(created_at, 1, 10)) AS day FROM products')
      .get() as { day: string };
    expect(await earliestCatalogRowDay(t.db, 'catalog.products_created')).toBe(legacyProducts.day);
    expect(legacyProducts.day).toBe('2026-06-30');

    const legacyIntegrations = t.raw
      .prepare(
        'SELECT min(substr(created_at, 1, 10)) AS day FROM integrations WHERE retired_at IS NULL',
      )
      .get() as { day: string };
    expect(await earliestCatalogRowDay(t.db, 'catalog.integrations_created')).toBe(
      legacyIntegrations.day,
    );
    expect(legacyIntegrations.day).toBe('2026-07-09');
  });
});

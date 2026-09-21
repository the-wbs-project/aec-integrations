import { describe, expect, it } from 'vitest';

import { orderByTextThenId } from './collation';
import { makeShimDb } from '../test/d1';

describe('orderByTextThenId', () => {
  it('emits COLLATE NOCASE followed by an id tiebreaker', () => {
    // Guards: AECI-825 plus AECI-99. NOCASE without a unique trailing term lets
    // a paginated list drop or duplicate a row, so the two must ship together.
    expect(orderByTextThenId('p.name', 'p.id')).toBe(
      'ORDER BY p.name COLLATE NOCASE ASC, p.id ASC',
    );
  });

  it('actually reorders the catalog the way AECI-825 requires', async () => {
    // Guards: the mirror against the real engine, not just the string. Under the
    // default BINARY collation `ADP` beats `Access` on D vs c, and eSUB / iSqFt /
    // openBIM sort after Zoho.
    const t = makeShimDb();
    const names = ['ADP Workforce Now', 'Access Coins Evo', 'eSUB', 'iSqFt', 'openBIM', 'Zoho'];
    const insert = t.raw.prepare(
      `INSERT INTO products (id, slug, name, created_at, updated_at)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    names.forEach((name, i) => insert.run(`p-${i}`, `slug-${i}`, name));

    const binary = t.raw.prepare(`SELECT name FROM products ORDER BY name ASC, id ASC`).all() as {
      name: string;
    }[];
    expect(binary.map((r) => r.name)).toEqual([
      'ADP Workforce Now',
      'Access Coins Evo',
      'Zoho',
      'eSUB',
      'iSqFt',
      'openBIM',
    ]);

    const nocase = t.raw
      .prepare(`SELECT name FROM products ${orderByTextThenId('name', 'id')}`)
      .all() as { name: string }[];
    expect(nocase.map((r) => r.name)).toEqual([
      'Access Coins Evo',
      'ADP Workforce Now',
      'eSUB',
      'iSqFt',
      'openBIM',
      'Zoho',
    ]);
    t.dispose();
  });
});

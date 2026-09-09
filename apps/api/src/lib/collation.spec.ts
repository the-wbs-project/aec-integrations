/**
 * AECI-825 — case-insensitive ordering, proved against REAL SQLite.
 *
 * These run through `makeTestDb` (better-sqlite3 + the committed migrations) and
 * the real list handlers, not a mocked client. A unit test that only asserted the
 * SQL string would pass while `COLLATE NOCASE` did nothing, which is exactly the
 * failure mode worth guarding: the defect is silent, and the endpoint returns 200
 * either way.
 */

import { compareText } from '@aeci/shared/text-sort';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { integrations, products, vendors } from '../db/schema';
import { createIntegrationsListHandler } from '../routes/integrations';
import { createProductsListHandler } from '../routes/products';
import { createVendorsListHandler } from '../routes/vendors';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';

/**
 * Page 1 of the live `/products?sort=name` list as reported, plus the three
 * lowercase-initial brands the byte order exiles past `Zoho`.
 */
const CATALOG = [
  'ADP Workforce Now',
  'AEC Integrations',
  'AEC Stack',
  'Access Coins Evo',
  'AccuLynx',
  'Acumatica',
  'Agave AI Analytics',
  'AkitaBox',
  'Amazon Redshift',
  'eSUB',
  'iSqFt',
  'openBIM',
  'Zoho',
];

/** What the reader should see: A→Z with case ignored. */
const EXPECTED = [...CATALOG].sort(compareText);

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const get = async (
  handler: ReturnType<typeof createProductsListHandler>,
  path: string,
  url: string,
): Promise<Response> =>
  buildAppWithHandler({ method: 'get', path, handler }).request(
    url,
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );

/** Order `CATALOG` (plus `extra`) through raw SQLite with the given ORDER BY tail. */
function orderThroughSqlite(table: string, orderBy: string, names: readonly string[]): string[] {
  t.raw.prepare(`CREATE TABLE ${table} (n TEXT)`).run();
  const insert = t.raw.prepare(`INSERT INTO ${table} VALUES (?)`);
  for (const name of names) insert.run(name);
  return t.raw
    .prepare(`SELECT n FROM ${table} ORDER BY ${orderBy}`)
    .all()
    .map((r) => (r as { n: string }).n);
}

// ---------------------------------------------------------------------------
// The primitive
// ---------------------------------------------------------------------------

describe('COLLATE NOCASE in SQLite', () => {
  it('is what the default BINARY collation is not: case-blind', () => {
    const binary = orderThroughSqlite('probe_binary', 'n', CATALOG);
    const nocase = orderThroughSqlite('probe_nocase', 'n COLLATE NOCASE', CATALOG);

    // The defect, reproduced against the same engine D1 runs.
    expect(binary.slice(0, 4)).toEqual([
      'ADP Workforce Now',
      'AEC Integrations',
      'AEC Stack',
      'Access Coins Evo',
    ]);
    expect(binary.at(-1)).toBe('openBIM');

    expect(nocase).toEqual(EXPECTED);
  });

  it('agrees with `compareText`, so the SQL and in-memory paths cannot diverge', () => {
    const mixed = [...CATALOG, 'e-Zone', 'eBuilder', '4D Sim', 'Sage 20', 'Sage 100'];
    const nocase = orderThroughSqlite('probe_agreement', 'n COLLATE NOCASE', mixed);

    expect(nocase).toEqual([...mixed].sort(compareText));
  });
});

// ---------------------------------------------------------------------------
// The three public list endpoints
// ---------------------------------------------------------------------------

describe('GET /api/products?sort=name', () => {
  it('orders A→Z with case ignored (the reported defect)', async () => {
    for (const [i, name] of CATALOG.entries()) {
      await t.db
        .insert(products)
        .values({ id: u(i + 1), slug: slugOf(name), name, promotionStatus: 'promoted' });
    }

    const res = await get(
      createProductsListHandler(t.factory),
      '/api/products',
      '/api/products?sort=name&perPage=50',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string }> };
    expect(body.data.map((p) => p.name)).toEqual(EXPECTED);
  });

  it('pages stably when two names differ only in case', async () => {
    // NOCASE calls these EQUAL, so the AECI-99 `id ASC` tiebreaker is the only
    // thing standing between this and a row that appears on both pages or neither.
    await t.db.insert(products).values([
      { id: u(2), slug: 'adp-lower', name: 'adp', promotionStatus: 'promoted' },
      { id: u(1), slug: 'adp-upper', name: 'ADP', promotionStatus: 'promoted' },
      { id: u(3), slug: 'bluebeam', name: 'Bluebeam', promotionStatus: 'promoted' },
    ]);

    const page = async (n: number) => {
      const res = await get(
        createProductsListHandler(t.factory),
        '/api/products',
        `/api/products?sort=name&perPage=1&page=${n}`,
      );
      const body = (await res.json()) as { data: Array<{ slug: string }> };
      return body.data.map((p) => p.slug);
    };

    // Lower id first within the tie, on every page, every time.
    expect(await page(1)).toEqual(['adp-upper']);
    expect(await page(2)).toEqual(['adp-lower']);
    expect(await page(3)).toEqual(['bluebeam']);
  });
});

describe('GET /api/vendors?sort=name', () => {
  it('orders `company_name` A→Z with case ignored', async () => {
    for (const [i, name] of CATALOG.entries()) {
      await t.db.insert(vendors).values({
        id: u(i + 1),
        slug: slugOf(name),
        companyName: name,
        promotionStatus: 'promoted',
      });
    }

    const res = await get(
      createVendorsListHandler(t.factory),
      '/api/vendors',
      '/api/vendors?sort=name&perPage=50',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ company_name: string }> };
    expect(body.data.map((v) => v.company_name)).toEqual(EXPECTED);
  });
});

describe('GET /api/integrations?sort=name', () => {
  const EDGES = ['ADP Sync', 'Access Bridge', 'eSUB Link', 'Zoho Push'];
  const EDGES_AZ = ['Access Bridge', 'ADP Sync', 'eSUB Link', 'Zoho Push'];

  async function seedEdges() {
    await t.db.insert(products).values([
      { id: u(90), slug: 'source', name: 'Source', promotionStatus: 'promoted' },
      { id: u(91), slug: 'target', name: 'Target', promotionStatus: 'promoted' },
    ]);
    for (const [i, name] of EDGES.entries()) {
      await t.db.insert(integrations).values({
        id: u(i + 1),
        name,
        sourceProductId: u(90),
        targetProductId: u(91),
        mechanismKind: 'api',
      });
    }
  }

  it('orders A→Z with case ignored on the relational path', async () => {
    await seedEdges();
    const res = await get(
      createIntegrationsListHandler(t.factory),
      '/api/integrations',
      // `mechanism_kind` excludes the evidenced arm, so this takes the relational
      // fast path rather than the union — the union arm is the next test.
      '/api/integrations?sort=name&perPage=50&mechanism_kind=api',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string | null }> };
    expect(body.data.map((r) => r.name)).toEqual(EDGES_AZ);
  });

  it('orders A→Z with case ignored on the UNION path too', async () => {
    // The union cannot address `integrations` columns, so it orders by its own
    // output alias — a SECOND `COLLATE NOCASE` that can drift from the resolver's.
    // Both arms are exercised so they cannot disagree.
    await seedEdges();
    const res = await get(
      createIntegrationsListHandler(t.factory),
      '/api/integrations',
      '/api/integrations?sort=name&perPage=50',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string | null }> };
    expect(body.data.map((r) => r.name)).toEqual(EDGES_AZ);
  });
});

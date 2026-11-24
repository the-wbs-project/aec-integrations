/**
 * `ops:retract-product --withdraw-connector` (AECI-2047): the supported way to withdraw a
 * connector product together with the pairs it delivers. Real migrations on in-memory
 * SQLite, the plan run statement by statement inside one transaction.
 *
 * The flag lifts the vendor-held refusal for one class only: a pair this product
 * delivers as connector that one of this product's own vendors holds. Every other
 * vendor-held row still refuses, and a connector catalogue still refuses.
 */

import { describe, expect, it } from 'vitest';

import { makeTestDb, type TestDb } from '../test/d1';
import {
  buildConnectorPairListingSql,
  buildDeleteStatements,
  buildFootprintSql,
  classifyRetraction,
  formatConnectorPairListing,
  formatFootprintReport,
  parseFootprint,
  RETRACT_VENDOR_HELD_TOKEN,
  WITHDRAW_CONNECTOR_FLAG,
  type ConnectorPairListingRow,
  type ProductRow,
  type RawFootprintRow,
} from './retract-product';

const TS = "'2026-11-01T00:00:00.000Z'";
const NOW = '2026-11-24T12:00:00.000Z';
const SYNC = 'prod-sync'; // the connector being withdrawn, joined to vendor 'v-sync'
const A = 'prod-a';
const B = 'prod-b';
const B2 = 'prod-b2';

/** Run one statement, reader or writer, the way `wrangler d1 execute` does. */
function sql(t: TestDb, statement: string): void {
  const prepared = t.raw.prepare(statement);
  if (prepared.reader) prepared.all();
  else prepared.run();
}

const pairInsert = (
  id: string,
  connector: string,
  a: string,
  b: string,
  builder: string,
  claimed: boolean,
) =>
  `INSERT INTO connector_evidenced_pairs (id, connector_product_id, product_a_id, product_b_id, built_by_vendor_id, claimed_at, created_at, updated_at) VALUES ('${id}', '${connector}', '${a}', '${b}', '${builder}', ${claimed ? TS : 'NULL'}, ${TS}, ${TS})`;

function seed(t: TestDb): void {
  for (const id of [SYNC, A, B, B2]) {
    sql(
      t,
      `INSERT INTO products (id, slug, name, product_role, created_at, updated_at) VALUES ('${id}', '${id}', '${id}', '${id === SYNC ? 'connector' : 'application'}', ${TS}, ${TS})`,
    );
  }
  for (const v of ['v-sync', 'v-other', 'v-endpoint']) {
    sql(
      t,
      `INSERT INTO vendors (id, slug, company_name, created_at, updated_at) VALUES ('${v}', '${v}', '${v}', ${TS}, ${TS})`,
    );
  }
  sql(
    t,
    `INSERT INTO product_vendors (product_id, vendor_id, is_primary, created_at) VALUES ('${SYNC}', 'v-sync', 1, ${TS})`,
  );
  sql(
    t,
    `INSERT INTO taxonomy_data_objects (id, slug, name, created_at, updated_at) VALUES ('do1', 'invoices', 'Invoices', ${TS}, ${TS})`,
  );
  // w-own: claimed by the connector's own vendor. Withdrawable.
  sql(t, pairInsert('w-own', SYNC, A, B, 'v-sync', true));
  sql(
    t,
    `INSERT INTO claims (id, connector_evidenced_pair_id, data_object_id, direction, created_at, updated_at) VALUES ('cl-own', 'w-own', 'do1', 'a_to_b', ${TS}, ${TS})`,
  );
  sql(
    t,
    `INSERT INTO attestations (id, claim_id, source, created_at, updated_at) VALUES ('at-own', 'cl-own', 'aeci', ${TS}, ${TS})`,
  );
  // w-free: AECi-seeded and unclaimed. Covered by the pair flag the withdrawal implies.
  sql(t, pairInsert('w-free', SYNC, A, B2, 'v-sync', false));
}

const footprint = (t: TestDb) =>
  parseFootprint(
    t.raw
      .prepare(buildFootprintSql(SYNC, { vendorHeldColumns: true, vendorHeldPairColumns: true }))
      .get() as RawFootprintRow,
  );
const product = (t: TestDb) =>
  t.raw
    .prepare(`SELECT id, slug, name, promotion_status FROM products WHERE id = ?`)
    .get(SYNC) as ProductRow;
const planFor = (t: TestDb, flags: { withdrawConnector?: boolean } = { withdrawConnector: true }) =>
  buildDeleteStatements({
    product: product(t),
    footprint: footprint(t),
    auditId: 'audit-withdraw',
    now: NOW,
    deleteEvidencedPairs: true,
    ...flags,
  });
const apply = (t: TestDb, statements: string[]) =>
  t.raw.transaction(() => {
    for (const s of statements) sql(t, s);
  })();
const count = (t: TestDb, from: string) =>
  (t.raw.prepare(`SELECT count(*) AS n FROM ${from}`).get() as { n: number }).n;

describe('the footprint and the refusals', () => {
  it('counts the pairs the connector delivers that its own vendor holds', async () => {
    const t = await makeTestDb();
    seed(t);
    sql(t, pairInsert('w-other', SYNC, B, B2, 'v-other', true));
    const fp = footprint(t);
    expect(fp.vendorHeldEvidencedPairs).toBe(2);
    expect(fp.vendorHeldOwnConnectorPairs).toBe(1);
    expect(formatFootprintReport(product(t), fp)).toMatch(/its own vendor holds \(WITHDRAW\)\s+1/);
    t.dispose();
  });

  it('refuses by default, and names the flag for the pairs its own vendor holds', async () => {
    const t = await makeTestDb();
    seed(t);
    const verdict = classifyRetraction(footprint(t), { deleteEvidencedPairs: true });
    expect(verdict.safe).toBe(false);
    expect(verdict.refusals).toEqual([
      expect.stringContaining(
        `1 of them this product delivers and its own vendor holds: ${WITHDRAW_CONNECTOR_FLAG}`,
      ),
    ]);
    t.dispose();
  });

  it('with the flag, the pairs its own vendor holds are no longer a refusal', async () => {
    const t = await makeTestDb();
    seed(t);
    const verdict = classifyRetraction(footprint(t), { withdrawConnector: true });
    expect(verdict.refusals).toEqual([]);
    // The flag implies --delete-evidenced-pairs.
    expect(verdict.evidencedPairRefusal).toBeNull();
    expect(verdict.safe).toBe(true);
    t.dispose();
  });

  it('with the flag, a pair another vendor holds still refuses', async () => {
    const t = await makeTestDb();
    seed(t);
    sql(t, pairInsert('w-other', SYNC, B, B2, 'v-other', true));
    const verdict = classifyRetraction(footprint(t), { withdrawConnector: true });
    expect(verdict.refusals).toEqual([
      expect.stringMatching(/^1 vendor-held connector-evidenced pair\(s\)/),
    ]);
    t.dispose();
  });

  it('with the flag, a held pair where this product is an endpoint still refuses', async () => {
    const t = await makeTestDb();
    seed(t);
    sql(
      t,
      `INSERT INTO products (id, slug, name, product_role, created_at, updated_at) VALUES ('prod-hub', 'hub', 'hub', 'connector', ${TS}, ${TS})`,
    );
    sql(t, pairInsert('w-endpoint', 'prod-hub', B, SYNC, 'v-sync', true));
    expect(classifyRetraction(footprint(t), { withdrawConnector: true }).safe).toBe(false);
    t.dispose();
  });

  it('with the flag, a connector catalogue still refuses', async () => {
    const t = await makeTestDb();
    seed(t);
    sql(
      t,
      `INSERT INTO connector_catalogs (id, connector_product_id, created_at, updated_at) VALUES ('recCat1', '${SYNC}', ${TS}, ${TS})`,
    );
    const verdict = classifyRetraction(footprint(t), { withdrawConnector: true });
    expect(verdict.refusals).toEqual([expect.stringMatching(/connector catalogue/)]);
    t.dispose();
  });
});

describe('the dry-run listing', () => {
  it('lists every pair the run would delete, with its role and hold, in id order', async () => {
    const t = await makeTestDb();
    seed(t);
    const rows = t.raw
      .prepare(buildConnectorPairListingSql(SYNC))
      .all() as ConnectorPairListingRow[];
    expect(rows.map((r) => [r.id, r.role, r.claims])).toEqual([
      ['w-free', 'connector', 0],
      ['w-own', 'connector', 1],
    ]);
    const text = formatConnectorPairListing(rows);
    expect(text).toContain('Pairs this run would delete (2):');
    expect(text).toContain(
      `w-own  ${A} ↔ ${B} via ${SYNC}  [connector; claimed 2026-11-01T00:00:00.000Z; builder v-sync; 1 claim(s)]`,
    );
    expect(text).toMatch(/w-free .*unclaimed/);
    t.dispose();
  });

  it('says none when there is nothing to delete', () => {
    expect(formatConnectorPairListing([])).toBe('Pairs this run would delete: none.');
  });
});

describe('the withdrawal plan', () => {
  it('deletes the connector, its pairs, their claims and attestations, with tombstones', async () => {
    const t = await makeTestDb();
    seed(t);
    apply(t, planFor(t));
    expect(count(t, `products WHERE id = '${SYNC}'`)).toBe(0);
    expect(count(t, 'connector_evidenced_pairs')).toBe(0);
    expect(count(t, 'claims')).toBe(0);
    expect(count(t, 'attestations')).toBe(0);
    const tomb = t.raw
      .prepare(
        `SELECT before_state, metadata FROM audit_log WHERE action = 'integration.deleted' AND entity_id = 'w-own'`,
      )
      .get() as { before_state: string; metadata: string };
    expect(JSON.parse(tomb.before_state)).toMatchObject({
      table: 'connector_evidenced_pairs',
      row: {
        id: 'w-own',
        built_by_vendor_id: 'v-sync',
        claimed_at: '2026-11-01T00:00:00.000Z',
        origin: 'aeci',
      },
      cascade: { claims: 1, attestations: 1 },
    });
    expect(JSON.parse(tomb.metadata)).toMatchObject({
      reason: 'connector product withdrawn',
      delete_evidenced_pairs: true,
      withdraw_connector: true,
    });
    expect(count(t, `audit_log WHERE action = 'product.deleted'`)).toBe(1);
    t.dispose();
  });

  it('still aborts before any write when another vendor claims a pair after the dry run', async () => {
    const t = await makeTestDb();
    seed(t);
    sql(t, pairInsert('w-late', SYNC, B, B2, 'v-other', false));
    const statements = planFor(t);
    expect(statements[0]).toContain(RETRACT_VENDOR_HELD_TOKEN);
    sql(t, `UPDATE connector_evidenced_pairs SET claimed_at = ${TS} WHERE id = 'w-late'`);
    expect(() => apply(t, statements)).toThrow(/malformed JSON/i);
    expect(count(t, 'connector_evidenced_pairs')).toBe(3);
    expect(count(t, 'audit_log')).toBe(0);
    t.dispose();
  });

  it('does not abort when the connector vendor claims one more of its pairs after the dry run', async () => {
    const t = await makeTestDb();
    seed(t);
    const statements = planFor(t);
    sql(t, `UPDATE connector_evidenced_pairs SET claimed_at = ${TS} WHERE id = 'w-free'`);
    apply(t, statements);
    expect(count(t, 'connector_evidenced_pairs')).toBe(0);
    t.dispose();
  });

  it('without the flag the plan keeps every held pair out, as before', async () => {
    const t = await makeTestDb();
    seed(t);
    expect(() => apply(t, planFor(t, {}))).toThrow(/malformed JSON/i);
    expect(count(t, 'connector_evidenced_pairs')).toBe(2);
    t.dispose();
  });
});

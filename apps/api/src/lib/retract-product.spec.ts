import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTestDb, type TestDb } from '../test/d1';

import {
  buildCacheTagsForProduct,
  buildDeleteStatements,
  buildFootprintSql,
  ddlHasVendorHeldColumns,
  EVIDENCED_PAIRS_DDL_SQL,
  INTEGRATIONS_DDL_SQL,
  buildProductLookupSql,
  classifyRetraction,
  DELETE_EVIDENCED_PAIRS_FLAG,
  escapeSqlLiteral,
  type ProductDeleteArgs,
  formatFootprintReport,
  parseFootprint,
  VENDOR_LINKS_TABLE_SQL,
  type ProductRow,
  type RawFootprintRow,
  type RetractFootprint,
} from './retract-product';

const RAW_EMPTY: RawFootprintRow = {
  connector_catalogs: 0,
  stub_mappings: 0,
  integrations: 0,
  powered_by: 0,
  evidenced_pairs: 0,
  evidenced_pairs_as_connector: 0,
  evidenced_pairs_as_a: 0,
  evidenced_pairs_as_b: 0,
  claims: 0,
  attestations: 0,
  field_challenges: 0,
  reviews: 0,
  product_versions: 0,
  page_views: 1,
  product_vendors: 0,
  product_categories: 2,
  product_audiences: 0,
  product_phases: 0,
  product_trades: 0,
  product_extensions: 0,
  category_slugs: 'document-management,collaboration',
  audience_slugs: null,
  phase_slugs: null,
  trade_slugs: null,
  evidenced_pair_slugs: null,
};

const PRODUCT: ProductRow = {
  id: '226817bb-25d1-4d10-90fa-f346638df821',
  slug: 'box-2',
  name: 'Box',
  promotion_status: 'promoted',
};

describe('escapeSqlLiteral', () => {
  it("doubles single quotes so a value can't break the literal", () => {
    expect(escapeSqlLiteral("O'Brien")).toBe("O''Brien");
    expect(escapeSqlLiteral('box-2')).toBe('box-2');
  });
});

describe('buildProductLookupSql', () => {
  it('matches by slug', () => {
    expect(buildProductLookupSql({ slug: 'box-2' })).toContain(`"slug" = 'box-2'`);
  });
  it('matches by id and escapes it', () => {
    expect(buildProductLookupSql({ id: "x'y" })).toContain(`"id" = 'x''y'`);
  });
});

describe('buildFootprintSql', () => {
  it('escapes the id and counts every referencing table', () => {
    const sql = buildFootprintSql("a'b");
    expect(sql).toContain(`'a''b'`);
    for (const t of [
      '"integrations"',
      '"claims"',
      '"reviews"',
      '"page_views"',
      '"product_vendors"',
      '"product_categories"',
      '"product_audiences"',
      '"product_phases"',
      '"product_extensions"',
      '"product_trades"',
      '"product_versions"',
      '"connector_evidenced_pairs"',
      '"connector_catalogs"',
      '"connector_stub_mappings"',
      '"integration_field_challenges"',
      '"attestations"',
      'powered_by_product_id',
      'host_product_id',
      'connector_product_id',
    ]) {
      expect(sql).toContain(t);
    }
  });
});

describe('parseFootprint', () => {
  it('splits group_concat slugs and treats null as empty', () => {
    const fp = parseFootprint(RAW_EMPTY);
    expect(fp.categorySlugs).toEqual(['document-management', 'collaboration']);
    expect(fp.audienceSlugs).toEqual([]);
    expect(fp.phaseSlugs).toEqual([]);
    expect(fp.pageViews).toBe(1);
    expect(fp.productCategories).toBe(2);
  });
});

describe('classifyRetraction', () => {
  it('treats a stub with no integrations/reviews as safe (join links + page_views are cosmetic)', () => {
    const c = classifyRetraction(parseFootprint(RAW_EMPTY));
    expect(c.safe).toBe(true);
    expect(c.blockers).toEqual([]);
  });

  it('flags integrations, powered_by, reviews and versions as --force blockers', () => {
    const fp: RetractFootprint = {
      ...parseFootprint(RAW_EMPTY),
      integrations: 3,
      poweredBy: 1,
      reviews: 2,
      productVersions: 5,
    };
    const c = classifyRetraction(fp);
    expect(c.safe).toBe(false);
    expect(c.refusals).toEqual([]);
    expect(c.evidencedPairRefusal).toBeNull();
    expect(c.blockers).toHaveLength(4);
    const text = c.blockers.join(' ');
    expect(text).toContain('3 integration(s)');
    expect(text).toContain('powered_by');
    expect(text).toContain('2 review(s)');
    expect(text).toContain('5 product version(s)');
  });

  const WITH_PAIRS: RetractFootprint = {
    ...parseFootprint(RAW_EMPTY),
    evidencedPairs: 4,
    evidencedPairsAsConnector: 3,
    evidencedPairsAsA: 1,
    evidencedPairsAsB: 0,
  };

  it('refuses any evidenced pair without --delete-evidenced-pairs, and names each role', () => {
    const c = classifyRetraction(WITH_PAIRS);
    expect(c.safe).toBe(false);
    expect(c.blockers).toEqual([]);
    expect(c.evidencedPairRefusal).toBe(
      '4 connector-evidenced pair(s): 3 as connector, 1 as endpoint A, 0 as endpoint B',
    );
    expect(DELETE_EVIDENCED_PAIRS_FLAG).toBe('--delete-evidenced-pairs');
  });

  it('does not treat pairs as a --force blocker, so --force alone never clears them', () => {
    // The CLI clears `blockers` with --force. Pairs must not be in that list.
    expect(classifyRetraction(WITH_PAIRS).blockers).toEqual([]);
    expect(
      classifyRetraction({ ...WITH_PAIRS, integrations: 1 }).evidencedPairRefusal,
    ).not.toBeNull();
  });

  it('clears the pair refusal only when the flag is passed', () => {
    const c = classifyRetraction(WITH_PAIRS, { deleteEvidencedPairs: true });
    expect(c.evidencedPairRefusal).toBeNull();
    expect(c.safe).toBe(true);
  });

  it('refuses a connector catalogue or stub mapping as a refusal, not a blocker', () => {
    const c = classifyRetraction({
      ...parseFootprint(RAW_EMPTY),
      connectorCatalogs: 1,
      stubMappings: 2,
    });
    expect(c.safe).toBe(false);
    expect(c.blockers).toEqual([]);
    expect(c.refusals).toHaveLength(2);
    expect(c.refusals.join(' ')).toContain('connector catalogue');
    expect(c.refusals.join(' ')).toContain('stub mapping');
  });
});

const NOW = '2026-09-21T12:00:00.000Z';

function deleteArgs(overrides: Partial<ProductDeleteArgs> = {}): ProductDeleteArgs {
  return {
    product: PRODUCT,
    footprint: parseFootprint(RAW_EMPTY),
    auditId: 'audit-0001',
    now: NOW,
    ...overrides,
  };
}

describe('buildDeleteStatements', () => {
  const stmts = buildDeleteStatements(deleteArgs({ deleteEvidencedPairs: true }));
  const idx = (needle: string) => stmts.findIndex((s) => s.includes(needle));

  it('orders children before parents and ends with the product row', () => {
    expect(idx('DELETE FROM "attestations"')).toBeLessThan(idx('DELETE FROM "claims"'));
    expect(idx('DELETE FROM "claims"')).toBeLessThan(idx('DELETE FROM "integrations"'));
    expect(idx('DELETE FROM "claims"')).toBeLessThan(
      idx('DELETE FROM "connector_evidenced_pairs"'),
    );
    expect(idx('DELETE FROM "integration_field_challenges"')).toBeLessThan(
      idx('DELETE FROM "integrations"'),
    );
    expect(idx('"introduced_version_id" = NULL')).toBeLessThan(
      idx('DELETE FROM "product_versions"'),
    );
    expect(idx('"page_views"')).toBeLessThan(idx('DELETE FROM "products"'));
    expect(stmts.at(-1)).toContain('DELETE FROM "products"');
  });

  it('writes every per-row tombstone BEFORE the rows it reads are deleted', () => {
    const pairs: Array<[string, string]> = [
      [
        "'integration.deleted', 'integration', \"id\", json_object('table', 'integrations'",
        'DELETE FROM "integrations"',
      ],
      [
        "json_object('table', 'connector_evidenced_pairs'",
        'DELETE FROM "connector_evidenced_pairs"',
      ],
      ["'integration.updated'", 'UPDATE "integrations" SET "powered_by_product_id" = NULL'],
      ["'review.deleted'", 'DELETE FROM "reviews"'],
      ["'product_version.deleted'", 'DELETE FROM "product_versions"'],
      ["'product.deleted'", 'DELETE FROM "products"'],
    ];
    for (const [tombstone, mutation] of pairs) {
      expect(idx(tombstone), tombstone).toBeGreaterThanOrEqual(0);
      expect(idx(tombstone), tombstone).toBeLessThan(idx(mutation));
    }
    // And every one of them precedes the first delete, so none can read a row a
    // sibling delete already removed.
    const lastTombstone = Math.max(
      ...stmts.map((s, i) =>
        s.startsWith('INSERT INTO "audit_log"') && !s.includes("'product.deleted'") ? i : -1,
      ),
    );
    expect(lastTombstone).toBeLessThan(idx('DELETE FROM "attestations"'));
  });

  it('detaches page_views rather than deleting them (log-class)', () => {
    expect(stmts.some((s) => s.startsWith('DELETE FROM "page_views"'))).toBe(false);
    expect(stmts).toContain(
      `UPDATE "page_views" SET "product_id" = NULL WHERE "product_id" = '${PRODUCT.id}';`,
    );
  });

  it('NULLs the powered_by no-action ref rather than blocking on it', () => {
    expect(stmts.find((s) => s.startsWith('UPDATE "integrations"'))).toContain(
      'SET "powered_by_product_id" = NULL',
    );
  });

  it('deletes product_trades explicitly (the facet the old list relied on cascade for)', () => {
    expect(idx('DELETE FROM "product_trades"')).toBeGreaterThanOrEqual(0);
  });

  it('guards the product delete and its tombstone on the connector-catalogue refusals', () => {
    for (const s of [stmts.at(-1)!, stmts.at(-2)!]) {
      expect(s).toContain('NOT EXISTS (SELECT 1 FROM "connector_catalogs"');
      expect(s).toContain('NOT EXISTS (SELECT 1 FROM "connector_stub_mappings"');
    }
  });

  it('without the flag, carries no pair delete and guards the product DELETE on pairs', () => {
    const plain = buildDeleteStatements(deleteArgs());
    expect(plain.some((s) => s.startsWith('DELETE FROM "connector_evidenced_pairs"'))).toBe(false);
    expect(plain.some((s) => s.includes("'connector_evidenced_pairs', 'row'"))).toBe(false);
    expect(plain.find((s) => s.startsWith('DELETE FROM "claims"'))).not.toContain(
      'connector_evidenced_pair_id',
    );
    for (const s of [plain.at(-1)!, plain.at(-2)!])
      expect(s).toContain('AND NOT EXISTS (SELECT "id" FROM "connector_evidenced_pairs"');
  });

  it('escapes the id in every statement', () => {
    const odd = buildDeleteStatements(deleteArgs({ product: { ...PRODUCT, id: "a'b" } }));
    for (const s of odd) expect(s).toContain(`'a''b'`);
  });
});

// ─── The plan, executed against the migrated schema ──────────────────────────

const P = 'prod-retract';
const Q = 'prod-other';
const R = 'prod-third';
const C = 'prod-connector';
const TS = "'2026-09-01T00:00:00.000Z'";

function seed(t: TestDb): void {
  const run = (sql: string) => t.raw.exec(sql);
  for (const [id, slug] of [
    [P, 'retract-me'],
    [Q, 'other'],
    [R, 'third'],
    [C, 'connector'],
  ])
    run(
      `INSERT INTO products (id, slug, name, created_at, updated_at) VALUES ('${id}', '${slug}', '${slug}', ${TS}, ${TS});`,
    );
  run(
    `INSERT INTO vendors (id, slug, company_name, created_at, updated_at) VALUES ('v1', 'v1', 'V1', ${TS}, ${TS});`,
  );
  run(
    `INSERT INTO taxonomy_data_objects (id, slug, name, created_at, updated_at) VALUES ('do1', 'rfis', 'RFIs', ${TS}, ${TS});`,
  );
  run(
    `INSERT INTO taxonomy_categories (id, slug, name, created_at, updated_at) VALUES ('cat1', 'cat-one', 'Cat', ${TS}, ${TS});`,
  );
  // Endpoint integration P → Q, with a claim, an attestation and a field contest.
  run(
    `INSERT INTO integrations (id, source_product_id, target_product_id, created_at, updated_at) VALUES ('i1', '${P}', '${Q}', ${TS}, ${TS});`,
  );
  run(
    `INSERT INTO claims (id, integration_id, data_object_id, direction, created_at, updated_at) VALUES ('cl1', 'i1', 'do1', 'a_to_b', ${TS}, ${TS});`,
  );
  run(
    `INSERT INTO attestations (id, claim_id, source, created_at, updated_at) VALUES ('at1', 'cl1', 'aeci', ${TS}, ${TS});`,
  );
  run(
    `INSERT INTO integration_field_challenges (id, integration_id, field, reason, submitter_vendor_id, routed_to, created_at, updated_at) VALUES ('fc1', 'i1', 'name', 'r', 'v1', 'aeci', ${TS}, ${TS});`,
  );
  // AECI-1007: one endpoint vendor's own listing link on i1, where the table exists
  // (the pre-0044 and pre-0045 cases below seed an older schema).
  if (t.raw.prepare(VENDOR_LINKS_TABLE_SQL).get()) {
    run(
      `INSERT INTO integration_vendor_links (id, integration_id, product_id, kind, url, vendor_id, created_at, updated_at) VALUES ('vl1', 'i1', '${Q}', 'listing', 'https://example.com/l', 'v1', ${TS}, ${TS});`,
    );
  }
  // Q → R powered by P: survives, detached.
  run(
    `INSERT INTO integrations (id, source_product_id, target_product_id, powered_by_product_id, created_at, updated_at) VALUES ('i2', '${Q}', '${R}', '${P}', ${TS}, ${TS});`,
  );
  // AECI-1007: a link that still names P on i2, a row P does not sit on (left by an
  // endpoint re-point). `product_id` has no FK, so only the plan can clear it.
  if (t.raw.prepare(VENDOR_LINKS_TABLE_SQL).get()) {
    run(
      `INSERT INTO integration_vendor_links (id, integration_id, product_id, kind, url, vendor_id, created_at, updated_at) VALUES ('vl2', 'i2', '${P}', 'docs', 'https://example.com/d', 'v1', ${TS}, ${TS});`,
    );
  }
  // Evidenced pair with P as endpoint A (A < B by id order: 'prod-other' < 'prod-retract').
  run(
    `INSERT INTO connector_evidenced_pairs (id, connector_product_id, product_a_id, product_b_id, created_at, updated_at) VALUES ('ep1', '${C}', '${Q}', '${P}', ${TS}, ${TS});`,
  );
  run(
    `INSERT INTO claims (id, connector_evidenced_pair_id, data_object_id, direction, created_at, updated_at) VALUES ('cl2', 'ep1', 'do1', 'both', ${TS}, ${TS});`,
  );
  // Content, versions, traffic, facets.
  run(
    `INSERT INTO reviews (id, product_id, rating_overall, rating_onboarding, title, body, created_at, updated_at) VALUES ('rv1', '${P}', 4, 4, 't', 'private body text', ${TS}, ${TS});`,
  );
  run(
    `INSERT INTO product_versions (id, product_id, label, sort_key, created_at, updated_at) VALUES ('pv1', '${P}', 'v1', 1, ${TS}, ${TS});`,
  );
  run(
    `INSERT INTO page_views (path, concrete_path, product_id, created_at) VALUES ('/products/:slug', '/products/pg1', '${P}', ${TS});`,
  );
  run(
    `INSERT INTO product_categories (product_id, category_id, created_at) VALUES ('${P}', 'cat1', ${TS});`,
  );
}

function footprintOf(t: TestDb, id: string): RetractFootprint {
  return parseFootprint(t.raw.prepare(buildFootprintSql(id)).get() as RawFootprintRow);
}

function apply(t: TestDb, statements: string[]): void {
  t.raw.transaction(() => {
    for (const s of statements) t.raw.exec(s);
  })();
}

type AuditRow = {
  id: string;
  actor_type: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_state: string;
  metadata: string;
  created_at: string;
};

describe('a tier without migration 0045 (AECI-1007)', () => {
  it('never names integration_vendor_links when the probe says the table is absent', () => {
    const product = { id: P, slug: 'retract-me', name: 'retract-me', promotion_status: 'promoted' };
    const footprint = parseFootprint(RAW_EMPTY);
    const without = buildDeleteStatements({
      product,
      footprint,
      auditId: 'a',
      now: NOW,
      vendorLinksTable: false,
    }).join('\n');
    expect(without).not.toContain('integration_vendor_links');
    expect(buildFootprintSql(P, { vendorLinksTable: false })).not.toContain(
      'integration_vendor_links',
    );
    // HEAD's schema has the table, so the default plan deletes from it.
    expect(
      buildDeleteStatements({ product, footprint, auditId: 'a', now: NOW }).join('\n'),
    ).toContain('DELETE FROM "integration_vendor_links"');
  });
});

describe('buildDeleteStatements against the migrated schema', () => {
  it('reads a footprint that counts every relation it will touch', async () => {
    const t = await makeTestDb();
    seed(t);
    const fp = footprintOf(t, P);
    expect(fp).toMatchObject({
      integrations: 1,
      poweredBy: 1,
      evidencedPairs: 1,
      evidencedPairsAsConnector: 0,
      evidencedPairsAsA: 0,
      evidencedPairsAsB: 1,
      claims: 2,
      attestations: 1,
      fieldChallenges: 1,
      // vl1 on the endpoint row i1, plus vl2 naming P on i2.
      vendorLinks: 2,
      reviews: 1,
      productVersions: 1,
      pageViews: 1,
      productCategories: 1,
      connectorCatalogs: 0,
      stubMappings: 0,
    });
    t.dispose();
  });

  it('removes the product with FKs on and writes one tombstone per removed domain row', async () => {
    const t = await makeTestDb();
    seed(t);
    const product = { id: P, slug: 'retract-me', name: 'retract-me', promotion_status: 'promoted' };
    apply(
      t,
      buildDeleteStatements({
        product,
        footprint: footprintOf(t, P),
        auditId: 'audit-product',
        now: NOW,
        operator: 'ops@example.com',
        force: true,
        deleteEvidencedPairs: true,
      }),
    );

    const count = (sql: string) => (t.raw.prepare(sql).get() as { n: number }).n;
    expect(count(`SELECT count(*) AS n FROM products WHERE id = '${P}'`)).toBe(0);
    expect(count(`SELECT count(*) AS n FROM integrations WHERE id = 'i1'`)).toBe(0);
    expect(count(`SELECT count(*) AS n FROM connector_evidenced_pairs`)).toBe(0);
    expect(count(`SELECT count(*) AS n FROM claims`)).toBe(0);
    expect(count(`SELECT count(*) AS n FROM attestations`)).toBe(0);
    expect(count(`SELECT count(*) AS n FROM integration_field_challenges`)).toBe(0);
    // Both: vl1 went with i1, and vl2 (naming P on the surviving i2) by product_id.
    expect(count(`SELECT count(*) AS n FROM integration_vendor_links`)).toBe(0);
    expect(count(`SELECT count(*) AS n FROM reviews`)).toBe(0);
    expect(count(`SELECT count(*) AS n FROM product_versions`)).toBe(0);
    // Survivors: the powered_by edge (detached) and the page view (detached).
    expect(
      t.raw.prepare(`SELECT powered_by_product_id AS v FROM integrations WHERE id = 'i2'`).get(),
    ).toEqual({ v: null });
    expect(
      t.raw
        .prepare(`SELECT product_id AS v FROM page_views WHERE concrete_path = '/products/pg1'`)
        .get(),
    ).toEqual({ v: null });

    const rows = t.raw
      .prepare('SELECT * FROM audit_log ORDER BY action, entity_id')
      .all() as AuditRow[];
    expect(rows.map((r) => [r.action, r.entity_id])).toEqual([
      ['integration.deleted', 'ep1'],
      ['integration.deleted', 'i1'],
      ['integration.updated', 'i2'],
      ['product.deleted', P],
      ['product_version.deleted', 'pv1'],
      ['review.deleted', 'rv1'],
    ]);
    for (const r of rows) {
      expect(r.actor_type).toBe('system');
      expect(r.created_at).toBe(NOW);
      expect(r.id).toMatch(/^[0-9a-f-]{36}$|^audit-product$/);
      const meta = JSON.parse(r.metadata);
      expect(meta).toMatchObject({
        issue: 'AECI-687',
        operator: 'ops@example.com',
        force: true,
        delete_evidenced_pairs: true,
        retracted_product_id: P,
      });
    }
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);

    const byEntity = Object.fromEntries(rows.map((r) => [r.entity_id, r]));
    expect(JSON.parse(byEntity.i1!.before_state)).toMatchObject({
      table: 'integrations',
      row: { id: 'i1', source_product_id: P, target_product_id: Q },
      cascade: { claims: 1, attestations: 1, field_challenges: 1, vendor_links: 1 },
    });
    expect(JSON.parse(byEntity.ep1!.metadata).table).toBe('connector_evidenced_pairs');
    expect(JSON.parse(byEntity.ep1!.before_state)).toMatchObject({
      cascade: { claims: 1, attestations: 0 },
    });
    expect(JSON.parse(byEntity.i2!.before_state)).toEqual({ powered_by_product_id: P });
    expect(byEntity.rv1!.before_state).not.toContain('private body text');
    expect(JSON.parse(byEntity[P]!.before_state)).toMatchObject({
      table: 'products',
      removed: {
        product_categories: 1,
        integrations: 1,
        evidenced_pairs: 1,
        reviews: 1,
        product_versions: 1,
        vendor_links: 2,
      },
      detached: { page_views: 1, powered_by: 1 },
    });
    t.dispose();
  });

  it('never deletes a connector product with a catalogue, and never tombstones it', async () => {
    const t = await makeTestDb();
    seed(t);
    t.raw.exec(
      `INSERT INTO connector_catalogs (id, connector_product_id, created_at, updated_at) VALUES ('cc1', '${C}', ${TS}, ${TS});`,
    );
    const fp = footprintOf(t, C);
    expect(fp.connectorCatalogs).toBe(1);
    expect(classifyRetraction(fp).refusals).toHaveLength(1);
    // Even if the plan were run anyway (a row that appeared after the CLI's check),
    // the guarded product DELETE and tombstone both no-op.
    apply(
      t,
      buildDeleteStatements({
        product: { id: C, slug: 'connector', name: 'connector', promotion_status: 'promoted' },
        footprint: fp,
        auditId: 'audit-connector',
        now: NOW,
        force: true,
      }),
    );
    expect(t.raw.prepare(`SELECT count(*) AS n FROM products WHERE id = '${C}'`).get()).toEqual({
      n: 1,
    });
    expect(t.raw.prepare(`SELECT count(*) AS n FROM connector_catalogs`).get()).toEqual({ n: 1 });
    expect(
      t.raw.prepare(`SELECT count(*) AS n FROM audit_log WHERE action = 'product.deleted'`).get(),
    ).toEqual({ n: 0 });
    t.dispose();
  });

  it('writes only the product tombstone for a clean stub', async () => {
    const t = await makeTestDb();
    seed(t);
    t.raw.exec(
      `INSERT INTO products (id, slug, name, created_at, updated_at) VALUES ('prod-stub', 'stub', 'stub', ${TS}, ${TS});`,
    );
    t.raw.exec(
      `INSERT INTO product_categories (product_id, category_id, created_at) VALUES ('prod-stub', 'cat1', ${TS});`,
    );
    const fp = footprintOf(t, 'prod-stub');
    expect(classifyRetraction(fp).safe).toBe(true);
    apply(
      t,
      buildDeleteStatements({
        product: { id: 'prod-stub', slug: 'stub', name: 'stub', promotion_status: 'promoted' },
        footprint: fp,
        auditId: 'audit-stub',
        now: NOW,
      }),
    );
    const rows = t.raw.prepare('SELECT id, action, entity_id FROM audit_log').all();
    expect(rows).toEqual([{ id: 'audit-stub', action: 'product.deleted', entity_id: 'prod-stub' }]);
    expect(
      t.raw
        .prepare(`SELECT count(*) AS n FROM product_categories WHERE product_id = 'prod-stub'`)
        .get(),
    ).toEqual({ n: 0 });
    t.dispose();
  });
});

describe('vendor-held integrations are refused, --force or not (AECI-1005)', () => {
  const footprintWithProbe = (t: TestDb, id: string): RetractFootprint => {
    const ddl = (t.raw.prepare(INTEGRATIONS_DDL_SQL).get() as { sql: string } | undefined)?.sql;
    return parseFootprint(
      t.raw
        .prepare(
          buildFootprintSql(id, {
            vendorHeldColumns: ddlHasVendorHeldColumns(ddl),
            vendorLinksTable: Boolean(t.raw.prepare(VENDOR_LINKS_TABLE_SQL).get()),
          }),
        )
        .get() as RawFootprintRow,
    );
  };
  const markI1 = (t: TestDb, set: string) =>
    t.raw.prepare(`UPDATE integrations SET ${set} WHERE id = 'i1'`).run();

  it('refuses a product whose endpoint integration its owner has claimed', async () => {
    const t = await makeTestDb();
    seed(t);
    markI1(t, `claimed_at = ${TS}`);
    const fp = footprintWithProbe(t, P);
    expect(fp.vendorHeldIntegrations).toBe(1);
    const verdict = classifyRetraction(fp);
    expect(verdict.safe).toBe(false);
    // A refusal, not a blocker: `--force` only waives blockers.
    expect(verdict.refusals).toEqual([expect.stringMatching(/vendor-held/)]);
    t.dispose();
  });

  it('refuses a vendor-held integration even with --delete-evidenced-pairs (AECI-904)', async () => {
    // The AECI-904 flag waives the evidenced-pair refusal only. It must never become a
    // second way round the vendor-held one.
    const t = await makeTestDb();
    seed(t);
    markI1(t, `claimed_at = ${TS}`);
    const verdict = classifyRetraction(footprintWithProbe(t, P), { deleteEvidencedPairs: true });
    expect(verdict.safe).toBe(false);
    expect(verdict.refusals).toEqual([expect.stringMatching(/vendor-held/)]);
    t.dispose();
  });

  it('refuses a product whose endpoint integration a vendor created', async () => {
    const t = await makeTestDb();
    seed(t);
    markI1(t, `origin = 'vendor'`);
    expect(classifyRetraction(footprintWithProbe(t, P)).refusals).toHaveLength(1);
    t.dispose();
  });

  it('does not refuse an AECi-seeded, unclaimed integration (still a --force blocker)', async () => {
    const t = await makeTestDb();
    seed(t);
    const verdict = classifyRetraction(footprintWithProbe(t, P));
    expect(verdict.refusals).toEqual([]);
    expect(verdict.blockers.length).toBeGreaterThan(0);
    t.dispose();
  });

  it('still reads a footprint on a database without migration 0044', async () => {
    const t = await makeTestDb({ upToExclusive: '0044_slippery_edwin_jarvis.sql' });
    seed(t);
    const ddl = (t.raw.prepare(INTEGRATIONS_DDL_SQL).get() as { sql: string }).sql;
    expect(ddlHasVendorHeldColumns(ddl)).toBe(false);
    expect(footprintWithProbe(t, P).vendorHeldIntegrations).toBe(0);
    t.dispose();
  });
});

describe('vendor-held evidenced pairs are refused, whatever the flags (AECI-1088)', () => {
  const footprintWithProbes = (t: TestDb, id: string): RetractFootprint => {
    const ddl = (sql: string) => (t.raw.prepare(sql).get() as { sql: string } | undefined)?.sql;
    return parseFootprint(
      t.raw
        .prepare(
          buildFootprintSql(id, {
            vendorHeldColumns: ddlHasVendorHeldColumns(ddl(INTEGRATIONS_DDL_SQL)),
            vendorHeldPairColumns: ddlHasVendorHeldColumns(ddl(EVIDENCED_PAIRS_DDL_SQL)),
            vendorLinksTable: Boolean(t.raw.prepare(VENDOR_LINKS_TABLE_SQL).get()),
          }),
        )
        .get() as RawFootprintRow,
    );
  };
  const markEp1 = (t: TestDb, set: string) =>
    t.raw.prepare(`UPDATE connector_evidenced_pairs SET ${set} WHERE id = 'ep1'`).run();

  it.each([
    ['claimed', `claimed_at = ${TS}`],
    ['vendor-created', `origin = 'vendor'`],
  ])(
    'refuses a %s pair with --delete-evidenced-pairs, and with --force as well',
    async (_label, set) => {
      const t = await makeTestDb();
      seed(t);
      markEp1(t, set);
      const fp = footprintWithProbes(t, P);
      expect(fp.vendorHeldEvidencedPairs).toBe(1);
      // `--force` waives blockers only; the CLI refuses on any refusal first.
      const verdict = classifyRetraction(fp, { deleteEvidencedPairs: true });
      expect(verdict.safe).toBe(false);
      expect(verdict.evidencedPairRefusal).toBeNull();
      expect(verdict.refusals).toEqual([
        expect.stringMatching(/vendor-held connector-evidenced pair.*--delete-evidenced-pairs/),
      ]);
      t.dispose();
    },
  );

  it('still lets --delete-evidenced-pairs cover an AECi-seeded pair', async () => {
    const t = await makeTestDb();
    seed(t);
    const fp = footprintWithProbes(t, P);
    expect(fp.vendorHeldEvidencedPairs).toBe(0);
    const verdict = classifyRetraction(fp, { deleteEvidencedPairs: true });
    expect(verdict.refusals).toEqual([]);
    expect(verdict.evidencedPairRefusal).toBeNull();
    t.dispose();
  });

  it('still reads a footprint on a database without migration 0048', async () => {
    const t = await makeTestDb({ upToExclusive: '0048_majestic_mentallo.sql' });
    seed(t);
    const ddl = (t.raw.prepare(EVIDENCED_PAIRS_DDL_SQL).get() as { sql: string }).sql;
    expect(ddlHasVendorHeldColumns(ddl)).toBe(false);
    expect(footprintWithProbes(t, P).vendorHeldEvidencedPairs).toBe(0);
    t.dispose();
  });

  it('shows the vendor-held pair count in the footprint report', async () => {
    const t = await makeTestDb();
    seed(t);
    markEp1(t, `claimed_at = ${TS}`);
    const report = formatFootprintReport(PRODUCT, footprintWithProbes(t, P));
    expect(report).toMatch(/vendor-held \(REFUSE\)\s+1/);
    t.dispose();
  });
});

describe('buildCacheTagsForProduct', () => {
  it('always includes the detail + index tags and one per browse facet, deduped', () => {
    const tags = buildCacheTagsForProduct('box-2', {
      ...parseFootprint(RAW_EMPTY),
      categorySlugs: ['document-management', 'document-management'],
      audienceSlugs: ['gc'],
    });
    expect(tags).toContain('product:box-2');
    expect(tags).toContain('index:products');
    expect(tags).toContain('category:document-management');
    expect(tags).toContain('audience:gc');
    expect(tags.filter((t) => t === 'category:document-management')).toHaveLength(1);
  });
});

describe('formatFootprintReport', () => {
  it('shows the identity and every footprint row', () => {
    const report = formatFootprintReport(PRODUCT, parseFootprint(RAW_EMPTY));
    expect(report).toContain('box-2');
    expect(report).toContain('226817bb-25d1-4d10-90fa-f346638df821');
    expect(report).toContain('promoted');
    expect(report).toContain('page_views');
  });
});

// ─── Connector-evidenced pairs, against the real connector fixture (AECI-904) ──

const FX = {
  mindcloud: '00000000-0000-4000-8000-000000000790',
  agave: '00000000-0000-4000-8000-000000000791',
  procore: '00000000-0000-4000-8000-000000000800',
  sageIntacct: '00000000-0000-4000-8000-000000000803',
  quickbooks: '00000000-0000-4000-8000-000000000804',
} as const;

/** The migrated schema plus `seed/connector-fixtures.sql`, with one claim and one
 *  attestation on every evidenced pair so the two-level cascade has rows to take. */
async function connectorFixtureDb(): Promise<TestDb> {
  const t = await makeTestDb();
  t.raw.exec(readFileSync(join(process.cwd(), 'seed', 'connector-fixtures.sql'), 'utf8'));
  t.raw.exec(
    `INSERT INTO taxonomy_data_objects (id, slug, name, created_at, updated_at) VALUES ('do1', 'rfis', 'RFIs', ${TS}, ${TS});`,
  );
  const pairIds = (
    t.raw.prepare('SELECT id FROM connector_evidenced_pairs ORDER BY id').all() as Array<{
      id: string;
    }>
  ).map((r) => r.id);
  expect(pairIds).toHaveLength(4);
  for (const [i, id] of pairIds.entries()) {
    t.raw.exec(
      `INSERT INTO claims (id, connector_evidenced_pair_id, data_object_id, direction, created_at, updated_at) VALUES ('fx-cl-${i}', '${id}', 'do1', 'both', ${TS}, ${TS});`,
    );
    t.raw.exec(
      `INSERT INTO attestations (id, claim_id, source, created_at, updated_at) VALUES ('fx-at-${i}', 'fx-cl-${i}', 'aeci', ${TS}, ${TS});`,
    );
  }
  return t;
}

/** The operator step the refusal asks for: unmap upstream (or retire the catalogue)
 *  and let the sync carry it. Simulated here so the pair path is reachable. */
function clearConnectorRefusals(t: TestDb, productId: string): void {
  t.raw.exec(`DELETE FROM connector_catalogs WHERE connector_product_id = '${productId}';`);
  t.raw.exec(`DELETE FROM connector_stub_mappings WHERE product_id = '${productId}';`);
}

function tableCounts(t: TestDb): Record<string, number> {
  const tables = (
    t.raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  return Object.fromEntries(
    tables.map((name) => [
      name,
      (t.raw.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n,
    ]),
  );
}

function productRow(t: TestDb, id: string): ProductRow {
  return t.raw
    .prepare('SELECT id, slug, name, promotion_status FROM products WHERE id = ?')
    .get(id) as ProductRow;
}

describe('connector-evidenced pairs (AECI-904)', () => {
  it('counts pairs in all three roles against the connector fixture', async () => {
    const t = await connectorFixtureDb();
    const roles = (id: string) => {
      const fp = footprintOf(t, id);
      return [
        fp.evidencedPairs,
        fp.evidencedPairsAsConnector,
        fp.evidencedPairsAsA,
        fp.evidencedPairsAsB,
      ];
    };
    expect(roles(FX.mindcloud)).toEqual([2, 2, 0, 0]);
    expect(roles(FX.agave)).toEqual([2, 2, 0, 0]);
    expect(roles(FX.procore)).toEqual([4, 0, 4, 0]);
    expect(roles(FX.sageIntacct)).toEqual([1, 0, 0, 1]);
    // Every pair's claim and attestation is in the footprint too.
    expect(footprintOf(t, FX.procore)).toMatchObject({ claims: 4, attestations: 4 });
    const report = formatFootprintReport(productRow(t, FX.mindcloud), footprintOf(t, FX.mindcloud));
    expect(report).toMatch(/as connector\s+2/);
    expect(report).toMatch(/as endpoint A\s+0/);
    expect(report).toMatch(/as endpoint B\s+0/);
    t.dispose();
  });

  it('refuses a pair-carrying product without the flag, even under --force', async () => {
    const t = await connectorFixtureDb();
    clearConnectorRefusals(t, FX.sageIntacct);
    const fp = footprintOf(t, FX.sageIntacct);
    expect(classifyRetraction(fp).refusals).toEqual([]);
    expect(classifyRetraction(fp).evidencedPairRefusal).toContain('1 as endpoint B');
    expect(classifyRetraction(fp, { deleteEvidencedPairs: true }).evidencedPairRefusal).toBeNull();
    t.dispose();
  });

  for (const [role, id, pairs] of [
    ['connector', FX.mindcloud, 2],
    ['endpoint A', FX.procore, 4],
    ['endpoint B', FX.sageIntacct, 1],
  ] as const) {
    it(`with the flag, as ${role}: deletes exactly the counted rows and nothing else`, async () => {
      const t = await connectorFixtureDb();
      clearConnectorRefusals(t, id);
      const fp = footprintOf(t, id);
      expect(fp.evidencedPairs).toBe(pairs);
      const before = tableCounts(t);
      const survivingPairs = t.raw
        .prepare(
          `SELECT id FROM connector_evidenced_pairs WHERE ? NOT IN (connector_product_id, product_a_id, product_b_id) ORDER BY id`,
        )
        .all(id);

      // FK enforcement OFF: the cascade cannot do the work, so every row gone below
      // was removed by an explicit statement.
      t.raw.pragma('foreign_keys = OFF');
      apply(
        t,
        buildDeleteStatements({
          product: productRow(t, id),
          footprint: fp,
          auditId: 'audit-904',
          now: NOW,
          force: true,
          deleteEvidencedPairs: true,
        }),
      );
      t.raw.pragma('foreign_keys = ON');

      const after = tableCounts(t);
      const delta = Object.fromEntries(
        Object.keys(before)
          .filter((k) => before[k] !== after[k])
          .map((k) => [k, after[k]! - before[k]!]),
      );
      const expected: Record<string, number> = {
        products: -1,
        connector_evidenced_pairs: -fp.evidencedPairs,
        claims: -fp.claims,
        attestations: -fp.attestations,
        integrations: -fp.integrations,
        product_vendors: -fp.productVendors,
        product_categories: -fp.productCategories,
        // One tombstone per deleted edge, one per detached powered_by, one product.
        audit_log: fp.integrations + fp.evidencedPairs + fp.poweredBy + 1,
      };
      for (const k of Object.keys(expected)) if (expected[k] === 0) delete expected[k];
      expect(delta).toEqual(expected);

      // No orphan survives the missing cascade.
      expect(t.raw.pragma('foreign_key_check')).toEqual([]);
      // Pairs the product is not part of keep their rows, claims and attestations.
      expect(
        t.raw
          .prepare(
            `SELECT id FROM connector_evidenced_pairs WHERE ? NOT IN (connector_product_id, product_a_id, product_b_id) ORDER BY id`,
          )
          .all(id),
      ).toEqual(survivingPairs);
      const pairTombstones = t.raw
        .prepare(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'integration.deleted' AND json_extract(metadata, '$.table') = 'connector_evidenced_pairs'`,
        )
        .get() as { n: number };
      expect(pairTombstones.n).toBe(pairs);
      t.dispose();
    });
  }

  it('without the flag, a pair that appeared after the check blocks the delete instead of cascading', async () => {
    const t = await connectorFixtureDb();
    clearConnectorRefusals(t, FX.sageIntacct);
    const product = productRow(t, FX.sageIntacct);
    // The CLI read a footprint with no pairs; one exists by the time the plan runs.
    apply(
      t,
      buildDeleteStatements({
        product,
        footprint: parseFootprint(RAW_EMPTY),
        auditId: 'audit-late',
        now: NOW,
        force: true,
      }),
    );
    const n = (sql: string) => (t.raw.prepare(sql).get() as { n: number }).n;
    expect(n(`SELECT count(*) AS n FROM products WHERE id = '${FX.sageIntacct}'`)).toBe(1);
    expect(
      n(
        `SELECT count(*) AS n FROM connector_evidenced_pairs WHERE product_b_id = '${FX.sageIntacct}'`,
      ),
    ).toBe(1);
    expect(
      n(`SELECT count(*) AS n FROM claims WHERE connector_evidenced_pair_id IS NOT NULL`),
    ).toBe(4);
    expect(n(`SELECT count(*) AS n FROM attestations`)).toBe(4);
    expect(n(`SELECT count(*) AS n FROM audit_log WHERE action = 'product.deleted'`)).toBe(0);
    t.dispose();
  });

  it('purges the pair page, both endpoints and the connector of every pair', async () => {
    const t = await connectorFixtureDb();
    const tags = buildCacheTagsForProduct('fx-mindcloud', footprintOf(t, FX.mindcloud));
    expect(tags).toEqual(
      expect.arrayContaining([
        'product:fx-mindcloud',
        'pair:fx-procore__fx-sage-intacct',
        'pair:fx-procore__fx-quickbooks-online',
        'product:fx-procore',
        'product:fx-sage-intacct',
        'product:fx-quickbooks-online',
      ]),
    );
    expect(tags.filter((tag) => tag.startsWith('pair:'))).toHaveLength(2);
    expect(new Set(tags).size).toBe(tags.length);
    t.dispose();
  });

  it('orders the pair tag by slug, not by the id order the table stores', () => {
    const tags = buildCacheTagsForProduct('zeta', {
      ...parseFootprint(RAW_EMPTY),
      evidencedPairSlugs: [{ a: 'zeta', b: 'alpha', connector: 'hub' }],
    });
    expect(tags).toContain('pair:alpha__zeta');
    expect(tags).toContain('product:hub');
  });
});

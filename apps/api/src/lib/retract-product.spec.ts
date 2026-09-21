import { describe, expect, it } from 'vitest';

import { makeTestDb, type TestDb } from '../test/d1';

import {
  buildCacheTagsForProduct,
  buildDeleteStatements,
  buildFootprintSql,
  buildProductLookupSql,
  classifyRetraction,
  escapeSqlLiteral,
  type ProductDeleteArgs,
  formatFootprintReport,
  parseFootprint,
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

  it('flags integrations, powered_by, evidenced pairs, reviews and versions as --force blockers', () => {
    const fp: RetractFootprint = {
      ...parseFootprint(RAW_EMPTY),
      integrations: 3,
      poweredBy: 1,
      evidencedPairs: 4,
      reviews: 2,
      productVersions: 5,
    };
    const c = classifyRetraction(fp);
    expect(c.safe).toBe(false);
    expect(c.refusals).toEqual([]);
    expect(c.blockers).toHaveLength(5);
    const text = c.blockers.join(' ');
    expect(text).toContain('3 integration(s)');
    expect(text).toContain('powered_by');
    expect(text).toContain('4 connector-evidenced pair(s)');
    expect(text).toContain('2 review(s)');
    expect(text).toContain('5 product version(s)');
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
  const stmts = buildDeleteStatements(deleteArgs());
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
  // Q → R powered by P: survives, detached.
  run(
    `INSERT INTO integrations (id, source_product_id, target_product_id, powered_by_product_id, created_at, updated_at) VALUES ('i2', '${Q}', '${R}', '${P}', ${TS}, ${TS});`,
  );
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

describe('buildDeleteStatements against the migrated schema', () => {
  it('reads a footprint that counts every relation it will touch', async () => {
    const t = await makeTestDb();
    seed(t);
    const fp = footprintOf(t, P);
    expect(fp).toMatchObject({
      integrations: 1,
      poweredBy: 1,
      evidencedPairs: 1,
      claims: 2,
      attestations: 1,
      fieldChallenges: 1,
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
      }),
    );

    const count = (sql: string) => (t.raw.prepare(sql).get() as { n: number }).n;
    expect(count(`SELECT count(*) AS n FROM products WHERE id = '${P}'`)).toBe(0);
    expect(count(`SELECT count(*) AS n FROM integrations WHERE id = 'i1'`)).toBe(0);
    expect(count(`SELECT count(*) AS n FROM connector_evidenced_pairs`)).toBe(0);
    expect(count(`SELECT count(*) AS n FROM claims`)).toBe(0);
    expect(count(`SELECT count(*) AS n FROM attestations`)).toBe(0);
    expect(count(`SELECT count(*) AS n FROM integration_field_challenges`)).toBe(0);
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
        retracted_product_id: P,
      });
    }
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);

    const byEntity = Object.fromEntries(rows.map((r) => [r.entity_id, r]));
    expect(JSON.parse(byEntity.i1!.before_state)).toMatchObject({
      table: 'integrations',
      row: { id: 'i1', source_product_id: P, target_product_id: Q },
      cascade: { claims: 1, attestations: 1, field_challenges: 1 },
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

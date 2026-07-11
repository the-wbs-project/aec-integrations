import { describe, expect, it } from 'vitest';

import {
  buildCacheTagsForProduct,
  buildDeleteStatements,
  buildFootprintSql,
  buildProductLookupSql,
  classifyRetraction,
  escapeSqlLiteral,
  formatFootprintReport,
  parseFootprint,
  type ProductRow,
  type RawFootprintRow,
  type RetractFootprint,
} from './retract-product';

const RAW_EMPTY: RawFootprintRow = {
  integrations: 0,
  powered_by: 0,
  claims: 0,
  reviews: 0,
  page_views: 1,
  product_vendors: 0,
  product_categories: 2,
  product_audiences: 0,
  product_phases: 0,
  product_extensions: 0,
  category_slugs: 'document-management,collaboration',
  audience_slugs: null,
  phase_slugs: null,
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
      'powered_by_product_id',
      'host_product_id',
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

  it('flags integrations, powered_by, and reviews as blockers', () => {
    const fp: RetractFootprint = {
      ...parseFootprint(RAW_EMPTY),
      integrations: 3,
      poweredBy: 1,
      reviews: 2,
    };
    const c = classifyRetraction(fp);
    expect(c.safe).toBe(false);
    expect(c.blockers).toHaveLength(3);
    expect(c.blockers.join(' ')).toContain('3 integration(s)');
    expect(c.blockers.join(' ')).toContain('powered_by');
    expect(c.blockers.join(' ')).toContain('2 review(s)');
  });
});

describe('buildDeleteStatements', () => {
  const stmts = buildDeleteStatements('226817bb');

  it('orders children before parents and ends with the product row', () => {
    const idx = (needle: string) => stmts.findIndex((s) => s.includes(needle));
    expect(idx('"attestations"')).toBeLessThan(idx('DELETE FROM "claims"'));
    expect(idx('DELETE FROM "claims"')).toBeLessThan(idx('DELETE FROM "integrations"'));
    // page_views (RESTRICT) must be deleted before the product row.
    expect(idx('"page_views"')).toBeLessThan(idx('DELETE FROM "products"'));
    expect(stmts.at(-1)).toContain('DELETE FROM "products"');
  });

  it('NULLs the powered_by RESTRICT ref rather than blocking on it', () => {
    const powered = stmts.find((s) => s.includes('powered_by_product_id'));
    expect(powered).toContain('UPDATE "integrations" SET "powered_by_product_id" = NULL');
  });

  it('escapes the id in every statement', () => {
    for (const s of buildDeleteStatements("a'b")) expect(s).toContain(`'a''b'`);
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

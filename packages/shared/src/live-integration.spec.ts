import { describe, expect, it } from 'vitest';

import {
  ddlHasRetiredColumn,
  EVIDENCED_PAIRS_DDL_QUERY,
  evidencedPairsDdlOrThrow,
  integrationsDdlOrThrow,
  liveEvidencedPairSql,
  liveEvidencedPairSqlIf,
  liveIntegrationSql,
  liveIntegrationSqlIf,
  notLiveEvidencedPairSql,
  notLiveIntegrationSql,
  notRetiredIntegrationSql,
} from './live-integration';
import {
  ddlHasHiddenColumn,
  endpointsVisibleSql,
  listingDdlOrThrow,
  visibleProductSql,
  visibleProductSqlIf,
  visibleVendorSql,
} from './listing-visibility';

describe('the evidenced arm (AECI-1091)', () => {
  it('filters retired pairs and pairs touching a hidden product (AECI-1238)', () => {
    expect(liveEvidencedPairSql('cep')).toBe(
      `(cep."retired_at" IS NULL AND ${endpointsVisibleSql([
        'cep."product_a_id"',
        'cep."product_b_id"',
        'cep."connector_product_id"',
      ])})`,
    );
    expect(notLiveEvidencedPairSql('cep')).toBe(`NOT ${liveEvidencedPairSql('cep')}`);
  });

  it('probes its own table and degrades per column', () => {
    expect(EVIDENCED_PAIRS_DDL_QUERY).toContain("name = 'connector_evidenced_pairs'");
    expect(liveEvidencedPairSqlIf('cep', true, true)).toBe(liveEvidencedPairSql('cep'));
    expect(liveEvidencedPairSqlIf('cep', false, false)).toBe('(1 = 1 AND 1 = 1)');
    expect(liveEvidencedPairSqlIf('cep', true, false)).toBe('(cep."retired_at" IS NULL AND 1 = 1)');
  });

  it('treats an empty DDL read as could-not-check', () => {
    expect(() => evidencedPairsDdlOrThrow(undefined)).toThrow(/connector_evidenced_pairs/);
    expect(evidencedPairsDdlOrThrow('CREATE TABLE x (a text)')).toBe('CREATE TABLE x (a text)');
  });
});

describe('live-integration predicate, raw-SQL form (AECI-1010, AECI-1238)', () => {
  it('is IS NULL on the aliased column, never = NULL', () => {
    expect(notRetiredIntegrationSql('i')).toBe('i."retired_at" IS NULL');
    expect(liveIntegrationSql('i')).not.toMatch(/=\s*NULL/i);
  });

  it('adds endpoint visibility over source, target and connector', () => {
    expect(liveIntegrationSql('i')).toBe(
      `(i."retired_at" IS NULL AND ${endpointsVisibleSql([
        'i."source_product_id"',
        'i."target_product_id"',
        'i."powered_by_product_id"',
      ])})`,
    );
  });

  it('has an exact complement', () => {
    expect(notLiveIntegrationSql('bi')).toBe(`NOT ${liveIntegrationSql('bi')}`);
  });
});

describe('the deployed-database probe (AECI-1010, AECI-1238)', () => {
  const MIGRATED =
    'CREATE TABLE `integrations` (`id` text PRIMARY KEY NOT NULL, `name` text, `retired_at` text)';
  const LAGGING = 'CREATE TABLE "integrations" ("id" text PRIMARY KEY NOT NULL, "name" text)';

  it('finds the column in migrated DDL and not in lagging DDL', () => {
    expect(ddlHasRetiredColumn(MIGRATED)).toBe(true);
    expect(ddlHasRetiredColumn(LAGGING)).toBe(false);
    expect(ddlHasRetiredColumn('CREATE TABLE x (a text, CHECK (retired_at IS NULL))')).toBe(false);
    expect(ddlHasRetiredColumn(null)).toBe(false);
  });

  it('degrades each clause to always-true only when its column is absent', () => {
    expect(liveIntegrationSqlIf('i', true, true)).toBe(liveIntegrationSql('i'));
    expect(liveIntegrationSqlIf('i', false, false)).toBe('(1 = 1 AND 1 = 1)');
    expect(liveIntegrationSqlIf('i', false, true)).toBe(
      `(1 = 1 AND ${endpointsVisibleSql([
        'i."source_product_id"',
        'i."target_product_id"',
        'i."powered_by_product_id"',
      ])})`,
    );
  });

  it('treats an empty DDL read as could-not-check', () => {
    expect(() => integrationsDdlOrThrow(undefined)).toThrow(/Refusing/);
    expect(() => integrationsDdlOrThrow('  ')).toThrow(/Refusing/);
    expect(integrationsDdlOrThrow(MIGRATED)).toBe(MIGRATED);
  });
});

describe('listing visibility, raw-SQL form (AECI-1238)', () => {
  it('is IS NULL on hidden_at, never = NULL', () => {
    expect(visibleProductSql('p')).toBe('p."hidden_at" IS NULL');
    expect(visibleVendorSql('v')).toBe('v."hidden_at" IS NULL');
  });

  it('reads the endpoint subquery under its own alias', () => {
    expect(endpointsVisibleSql(['i.a', 'i.b'])).toBe(
      'NOT EXISTS (SELECT 1 FROM products lh_hp WHERE lh_hp."id" IN (i.a, i.b) AND lh_hp."hidden_at" IS NOT NULL)',
    );
  });

  it('probes products and degrades when the column is absent', () => {
    expect(ddlHasHiddenColumn('CREATE TABLE `products` (`id` text, `hidden_at` text)')).toBe(true);
    expect(ddlHasHiddenColumn('CREATE TABLE "products" ("id" text)')).toBe(false);
    expect(visibleProductSqlIf('p', false)).toBe('1 = 1');
    expect(() => listingDdlOrThrow('', 'products')).toThrow(/products/);
  });
});

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
  retiredEvidencedPairSql,
  retiredIntegrationSql,
} from './live-integration';

describe('the evidenced arm (AECI-1091)', () => {
  it('is the same SQL as the integrations arm, under its own name', () => {
    expect(liveEvidencedPairSql('cep')).toBe('cep."retired_at" IS NULL');
    expect(retiredEvidencedPairSql('cep')).toBe('cep."retired_at" IS NOT NULL');
  });

  it('probes its own table and degrades on its own', () => {
    expect(EVIDENCED_PAIRS_DDL_QUERY).toContain("name = 'connector_evidenced_pairs'");
    expect(liveEvidencedPairSqlIf('cep', true)).toBe(liveEvidencedPairSql('cep'));
    expect(liveEvidencedPairSqlIf('cep', false)).toBe('1 = 1');
  });

  it('treats an empty DDL read as could-not-check', () => {
    expect(() => evidencedPairsDdlOrThrow(undefined)).toThrow(/connector_evidenced_pairs/);
    expect(evidencedPairsDdlOrThrow('CREATE TABLE x (a text)')).toBe('CREATE TABLE x (a text)');
  });
});

describe('live-integration predicate, raw-SQL form (AECI-1010)', () => {
  it('is IS NULL on the aliased column, never = NULL', () => {
    expect(liveIntegrationSql('i')).toBe('i."retired_at" IS NULL');
    expect(liveIntegrationSql('i')).not.toMatch(/=\s*NULL/i);
  });

  it('has an exact complement', () => {
    expect(retiredIntegrationSql('bi')).toBe('bi."retired_at" IS NOT NULL');
  });
});

describe('the deployed-database probe (AECI-1010)', () => {
  const MIGRATED =
    'CREATE TABLE `integrations` (`id` text PRIMARY KEY NOT NULL, `name` text, `retired_at` text)';
  const LAGGING = 'CREATE TABLE "integrations" ("id" text PRIMARY KEY NOT NULL, "name" text)';

  it('finds the column in migrated DDL and not in lagging DDL', () => {
    expect(ddlHasRetiredColumn(MIGRATED)).toBe(true);
    expect(ddlHasRetiredColumn(LAGGING)).toBe(false);
    expect(ddlHasRetiredColumn('CREATE TABLE x (a text, CHECK (retired_at IS NULL))')).toBe(false);
    expect(ddlHasRetiredColumn(null)).toBe(false);
  });

  it('degrades to always-true only when the column is absent', () => {
    expect(liveIntegrationSqlIf('i', true)).toBe(liveIntegrationSql('i'));
    expect(liveIntegrationSqlIf('i', false)).toBe('1 = 1');
  });

  it('treats an empty DDL read as could-not-check', () => {
    expect(() => integrationsDdlOrThrow(undefined)).toThrow(/Refusing/);
    expect(() => integrationsDdlOrThrow('  ')).toThrow(/Refusing/);
    expect(integrationsDdlOrThrow(MIGRATED)).toBe(MIGRATED);
  });
});

import { describe, expect, it } from 'vitest';

import {
  ddlHasRetiredColumn,
  integrationsDdlOrThrow,
  liveIntegrationSql,
  liveIntegrationSqlIf,
  retiredIntegrationSql,
} from './live-integration';

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

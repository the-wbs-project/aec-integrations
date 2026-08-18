/**
 * `ANALYTICS_INTERNAL_ASNS` parsing + the query-time predicate (AECI-574 / §13
 * D10). The predicate test is the important one: a bare `NOT IN` would silently
 * drop every NULL-ASN row from the "excluding internal" figure.
 */

import { and, gte } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pageViews } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { excludeInternalAsns, parseInternalAsns } from './internal-asns';

describe('parseInternalAsns', () => {
  it('is unavailable (empty) when the var is unset or blank — the shipped default', () => {
    expect(parseInternalAsns(undefined)).toEqual([]);
    expect(parseInternalAsns('')).toEqual([]);
    expect(parseInternalAsns('   ')).toEqual([]);
  });

  it('accepts the AS-prefixed and bare forms interchangeably', () => {
    expect(parseInternalAsns('AS23700')).toEqual([23700]);
    expect(parseInternalAsns('23700')).toEqual([23700]);
    expect(parseInternalAsns('as23700')).toEqual([23700]);
  });

  it('splits on commas, semicolons and whitespace (the parseRecipients splitter)', () => {
    expect(parseInternalAsns('AS23700, 4134')).toEqual([23700, 4134]);
    expect(parseInternalAsns('23700;4134')).toEqual([23700, 4134]);
    expect(parseInternalAsns('23700\n4134  15169')).toEqual([23700, 4134, 15169]);
  });

  it('drops junk rather than throwing — a misconfigured var must not 500 a dashboard', () => {
    expect(parseInternalAsns('AS23700, not-an-asn, , 4134')).toEqual([23700, 4134]);
    expect(parseInternalAsns('ASN23700')).toEqual([]);
    expect(parseInternalAsns('-5')).toEqual([]);
    expect(parseInternalAsns('0')).toEqual([]);
    expect(parseInternalAsns('12.5')).toEqual([]);
  });

  it('collapses duplicates and preserves order', () => {
    expect(parseInternalAsns('4134, AS23700, 4134')).toEqual([4134, 23700]);
  });
});

describe('excludeInternalAsns', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  it('is undefined when there is nothing to exclude, so callers can spread it unconditionally', () => {
    expect(excludeInternalAsns([])).toBeUndefined();
  });

  it('keeps rows whose cf_asn is NULL — the SQL `NOT IN` NULL trap', async () => {
    await t.db.insert(pageViews).values([
      { path: '/a', cfAsn: 23700, createdAt: '2026-08-10T01:00:00.000Z' },
      { path: '/b', cfAsn: 4134, createdAt: '2026-08-10T02:00:00.000Z' },
      { path: '/c', cfAsn: null, createdAt: '2026-08-10T03:00:00.000Z' },
    ]);

    const rows = await t.db
      .select({ path: pageViews.path })
      .from(pageViews)
      .where(and(gte(pageViews.createdAt, '2026-08-10'), excludeInternalAsns([23700])));

    // /a is internal and excluded; /c has no ASN and MUST survive — a bare
    // `cf_asn NOT IN (23700)` evaluates to NULL for it and would drop it.
    expect(rows.map((r) => r.path).sort()).toEqual(['/b', '/c']);
  });

  it('excludes every configured ASN', async () => {
    await t.db.insert(pageViews).values([
      { path: '/a', cfAsn: 23700, createdAt: '2026-08-10T01:00:00.000Z' },
      { path: '/b', cfAsn: 4134, createdAt: '2026-08-10T02:00:00.000Z' },
      { path: '/c', cfAsn: 15169, createdAt: '2026-08-10T03:00:00.000Z' },
    ]);

    const rows = await t.db
      .select({ path: pageViews.path })
      .from(pageViews)
      .where(excludeInternalAsns([23700, 4134]));

    expect(rows.map((r) => r.path)).toEqual(['/c']);
  });
});

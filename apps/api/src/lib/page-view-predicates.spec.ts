/**
 * Guards for the predicates AECI-745 lifted out of `analytics-digest.ts`.
 *
 * The move was supposed to be byte-identical, and "supposed to be" is not a
 * property a reviewer can check on a 180-line diff that is all deletions in one
 * file and all insertions in another. These tests pin the two things that would
 * be silently wrong if it were not: the SQL each predicate compiles to, and the
 * three-valued-logic behaviour that made those exact forms mandatory.
 */

import { and, gte, lt, type SQL } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pageViews } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  BOT,
  HUMAN,
  NOT_INTERNAL,
  notFlagged,
  OPERATOR_PAIR_LOOKBACK_DAYS,
  OPERATOR_PAIR_MATCH,
} from './page-view-predicates';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const AT = '2026-07-23T10:00:00.000Z';
const window = and(
  gte(pageViews.createdAt, '2026-07-23T00:00:00.000Z'),
  lt(pageViews.createdAt, '2026-07-24T00:00:00.000Z'),
);

/** The compiled SQL + bound parameters for a predicate, so the shape assertions
 *  below check what D1 would actually receive rather than an object graph. */
const compile = (predicate: SQL) => new SQLiteSyncDialect().sqlToQuery(predicate);

const countWhere = async (where: ReturnType<typeof and>): Promise<number> => {
  const rows = await t.db.select({ id: pageViews.id }).from(pageViews).where(where);
  return rows.length;
};

describe('OPERATOR_PAIR_MATCH — the two properties that must not be refactored away', () => {
  it('uses the NOT EXISTS form, not the NULL-unsafe equality form', () => {
    const { sql } = compile(OPERATOR_PAIR_MATCH);
    // The correlated subquery is what makes a NULL hash or ASN KEEP the row: the
    // inner `=` is NULL, the subquery matches nothing, and `NOT EXISTS` is TRUE.
    // `NOT (hash = ? AND asn = ?)` is NULL for that row and a NULL WHERE drops it.
    expect(sql).toContain('exists');
    expect(sql).toContain('is_operator');
  });

  it('reproduces the stored timestamp format exactly', () => {
    // `created_at` is `toISOString()` — `2026-08-26T05:46:00.000Z`. Bare
    // `datetime()` returns a SPACE where the stored value has a `T`, and a space
    // sorts BEFORE `T`, so the comparison is silently wrong at the boundary.
    expect(compile(OPERATOR_PAIR_MATCH).sql).toContain('%Y-%m-%dT%H:%M:%fZ');
  });

  it('binds two parameters no matter how many operator pairs exist', () => {
    // A JS-resolved pair list would bind two per pair and scale with the data —
    // the D1 bound-parameter hazard this test harness cannot fail on. The literal
    // parameters are the two `strftime` modifiers and nothing else.
    const { params } = compile(OPERATOR_PAIR_MATCH);
    expect(params).toContain(`-${OPERATOR_PAIR_LOOKBACK_DAYS} days`);
    expect(params).toContain(`+${OPERATOR_PAIR_LOOKBACK_DAYS} days`);
    // The two `strftime` modifiers and NOTHING else — a fixed two, independent of
    // how many operator pairs the data holds. The format strings are inlined in
    // the SQL text, so they do not consume bound slots either.
    expect(params).toHaveLength(2);
  });

  it('KEEPS a row with a null hash and a null ASN, even beside an operator row', async () => {
    await t.db.insert(pageViews).values([
      { path: '/', createdAt: AT, isOperator: true, userAgentHash: 'op', cfAsn: 23700 },
      // Null on both halves of the pair: the retro-join must not claim it.
      { path: '/products/x', createdAt: AT },
    ]);
    expect(await countWhere(and(window, HUMAN, NOT_INTERNAL))).toBe(1);
  });

  it('removes a row that shares the operator pair, which is the leak it exists to close', async () => {
    await t.db.insert(pageViews).values([
      { path: '/', createdAt: AT, isOperator: true, userAgentHash: 'op', cfAsn: 23700 },
      // Same browser, same network, unflagged — a lapsed session.
      { path: '/products/x', createdAt: AT, userAgentHash: 'op', cfAsn: 23700 },
    ]);
    expect(await countWhere(and(window, HUMAN, NOT_INTERNAL))).toBe(0);
  });
});

describe('HUMAN / BOT', () => {
  it('counts a pre-classification row as human rather than dropping it', async () => {
    await t.db.insert(pageViews).values([
      { path: '/a', createdAt: AT, isBot: null },
      { path: '/b', createdAt: AT, isBot: false },
      { path: '/c', createdAt: AT, isBot: true },
    ]);
    expect(await countWhere(and(window, HUMAN))).toBe(2);
    expect(await countWhere(and(window, BOT))).toBe(1);
  });
});

describe('notFlagged — the exact complement, and its NULL trap', () => {
  it('is undefined with no exclusion, so callers filter nothing rather than everything', () => {
    expect(notFlagged(undefined)).toBeUndefined();
    expect(notFlagged({ uaHashes: [], asns: [], verdicts: [] })).toBeUndefined();
  });

  it('KEEPS a row whose hash, ASN and verdict are all null', async () => {
    // `not(inArray(...))` is NULL for this row on all three axes, and a NULL
    // WHERE DROPS it — so the row would vanish from the digest's tables while
    // still counting in its headline. "IS NULL OR NOT IN" is what keeps it.
    await t.db.insert(pageViews).values([{ path: '/', createdAt: AT }]);
    const kept = await countWhere(
      and(window, notFlagged({ uaHashes: ['s'], asns: [47544], verdicts: ['non-browser'] })),
    );
    expect(kept).toBe(1);
  });

  it('removes a row on each axis independently', async () => {
    await t.db.insert(pageViews).values([
      { path: '/a', createdAt: AT, userAgentHash: 's' },
      { path: '/b', createdAt: AT, cfAsn: 47544 },
      { path: '/c', createdAt: AT, clientVerdict: 'non-browser' },
      { path: '/d', createdAt: AT, userAgentHash: 'person', cfAsn: 7922, clientVerdict: 'browser' },
    ]);
    const kept = await countWhere(
      and(window, notFlagged({ uaHashes: ['s'], asns: [47544], verdicts: ['non-browser'] })),
    );
    expect(kept).toBe(1);
  });
});

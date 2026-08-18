/**
 * Ordering coverage for the product-version model (AECI-607 / §8.2).
 *
 * The acceptance criterion this file exists for: **`2026.9` sorts before
 * `2026.10`**. That is the exact case a lexical sort gets wrong, and it is why
 * `sort_key` is a non-negotiable INTEGER column rather than an ordering derived
 * from the label at read time.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_VERSION_SORT_KEY,
  VERSION_SORT_SEGMENTS,
  VERSION_SORT_SEGMENT_MAX,
  compareProductVersions,
  deriveVersionSortKey,
  type ComparableProductVersion,
} from './version-sort';

/** A version row reduced to what ordering reads. */
function version(
  sortKey: number,
  createdAt = '2026-01-01T00:00:00.000Z',
  id = 'a',
): ComparableProductVersion {
  return { sortKey, createdAt, id };
}

/** Order labels the way the API does: derive, then compare. */
function orderByDerivedKey(labels: readonly string[]): string[] {
  return [...labels].sort((a, b) => deriveVersionSortKey(a) - deriveVersionSortKey(b));
}

describe('deriveVersionSortKey', () => {
  it('sorts 2026.9 before 2026.10 — the case a lexical sort gets wrong', () => {
    // The premise, stated so the test documents why the column exists.
    expect('2026.10' < '2026.9').toBe(true);

    expect(deriveVersionSortKey('2026.9')).toBeLessThan(deriveVersionSortKey('2026.10'));
    expect(orderByDerivedKey(['2026.10', '2026.9', '2026.1'])).toEqual([
      '2026.1',
      '2026.9',
      '2026.10',
    ]);
  });

  it('sorts v9 before v10 — the same failure with a prefix', () => {
    expect('v10' < 'v9').toBe(true);
    expect(deriveVersionSortKey('v9')).toBeLessThan(deriveVersionSortKey('v10'));
  });

  it('packs the first three numeric runs most-significant-first', () => {
    expect(deriveVersionSortKey('2026.9')).toBe(20_260_000_900_000);
    expect(deriveVersionSortKey('2026.10')).toBe(20_260_001_000_000);
    expect(deriveVersionSortKey('v9')).toBe(90_000_000_000);
    expect(deriveVersionSortKey('v10')).toBe(100_000_000_000);
  });

  it('treats a missing segment as 0, so 2026.1 precedes 2026.1.1', () => {
    expect(deriveVersionSortKey('2026.1')).toBeLessThan(deriveVersionSortKey('2026.1.1'));
    expect(deriveVersionSortKey('5')).toBe(deriveVersionSortKey('5.0.0'));
  });

  it('ignores runs beyond the third', () => {
    expect(deriveVersionSortKey('1.2.3.4')).toBe(deriveVersionSortKey('1.2.3.9'));
  });

  it('derives 0 for a label with no digits (the explicit-override case)', () => {
    expect(deriveVersionSortKey('LTS')).toBe(0);
    expect(deriveVersionSortKey('Fall release')).toBe(0);
    expect(deriveVersionSortKey('')).toBe(0);
  });

  it('reads digits wherever they sit in the label, not just at the start', () => {
    expect(deriveVersionSortKey('R2024 SP1')).toBe(deriveVersionSortKey('2024.1'));
  });

  it('clamps an oversized segment instead of overflowing the key', () => {
    const clamped = deriveVersionSortKey('999999999999999999999');
    expect(clamped).toBe(deriveVersionSortKey(String(VERSION_SORT_SEGMENT_MAX)));
    expect(clamped).toBeLessThanOrEqual(MAX_VERSION_SORT_KEY);
  });

  it('never exceeds MAX_VERSION_SORT_KEY, which stays a safe integer', () => {
    const maxLabel = Array.from({ length: VERSION_SORT_SEGMENTS }, () =>
      String(VERSION_SORT_SEGMENT_MAX),
    ).join('.');
    expect(deriveVersionSortKey(maxLabel)).toBe(MAX_VERSION_SORT_KEY);
    expect(Number.isSafeInteger(MAX_VERSION_SORT_KEY)).toBe(true);
    expect(MAX_VERSION_SORT_KEY).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe('compareProductVersions', () => {
  it('orders by sort_key ascending', () => {
    expect(compareProductVersions(version(1), version(2))).toBeLessThan(0);
    expect(compareProductVersions(version(2), version(1))).toBeGreaterThan(0);
  });

  it('breaks a sort_key tie on created_at, then id — never on the label', () => {
    const older = version(0, '2026-01-01T00:00:00.000Z', 'zzz');
    const newer = version(0, '2026-02-01T00:00:00.000Z', 'aaa');
    // `zzz` would lose a lexical id/label comparison; it wins because it is older.
    expect(compareProductVersions(older, newer)).toBeLessThan(0);

    const sameInstantA = version(0, '2026-01-01T00:00:00.000Z', 'a');
    const sameInstantB = version(0, '2026-01-01T00:00:00.000Z', 'b');
    expect(compareProductVersions(sameInstantA, sameInstantB)).toBeLessThan(0);
  });

  it('is a total order — identical rows compare equal', () => {
    expect(compareProductVersions(version(7), version(7))).toBe(0);
  });

  it('orders a realistic set by derived key, tied labels included', () => {
    const rows = [
      {
        label: '2026.10',
        ...version(deriveVersionSortKey('2026.10'), '2026-03-01T00:00:00.000Z', 'c'),
      },
      { label: 'LTS', ...version(deriveVersionSortKey('LTS'), '2026-02-01T00:00:00.000Z', 'b') },
      {
        label: '2026.9',
        ...version(deriveVersionSortKey('2026.9'), '2026-04-01T00:00:00.000Z', 'd'),
      },
      {
        label: 'Fall release',
        ...version(deriveVersionSortKey('Fall release'), '2026-01-01T00:00:00.000Z', 'a'),
      },
    ];
    expect([...rows].sort(compareProductVersions).map((r) => r.label)).toEqual([
      // Both derive 0; the older row wins the tiebreak.
      'Fall release',
      'LTS',
      '2026.9',
      '2026.10',
    ]);
  });
});

/**
 * The AECI-1659 group detector, pure. Fixtures: the 2026-10-24 crawler shape, a
 * three-identity office that must not fire, a two-identity group under the minimum,
 * the operator's own labelled-session browsers, and privacy rows.
 */

import { describe, expect, it } from 'vitest';

import {
  COORDINATED_MIN_IDENTITIES,
  findCoordinatedGroups,
  mainNetworkByIdentity,
  type CoordinatedRow,
} from './coordinated-identities';

const DAY = '2026-10-24';
const SEEDBOX = 214483;
const ISP = 7922;

let nextId = 1;
function row(
  hash: string | null,
  asn: number | null,
  at: string,
  path: string | null,
): CoordinatedRow {
  return {
    id: nextId++,
    createdAt: `${DAY}T${at}.000Z`,
    concretePath: path,
    cfAsn: asn,
    userAgentHash: hash,
  };
}

const notInternal = () => false;

/** `n` identities on one network, each starting at `starts[i]`, each on its own path set. */
function crawler(n: number, viewsEach: number, starts: readonly string[]): CoordinatedRow[] {
  const rows: CoordinatedRow[] = [];
  for (let i = 0; i < n; i += 1) {
    const hash = `crawl${i}`;
    for (let v = 0; v < viewsEach; v += 1) {
      const at =
        v === 0
          ? (starts[i] ?? '00:00:00')
          : `0${1 + (v % 9)}:${String(v % 60).padStart(2, '0')}:00`;
      rows.push(row(hash, SEEDBOX, at, `/products/p-${i}-${v}`));
    }
  }
  return rows;
}

/** Ordinary daytime traffic, to give the day a denominator. */
function background(views: number): CoordinatedRow[] {
  return Array.from({ length: views }, (_, i) =>
    row(`person${i % 200}`, 1000 + (i % 50), `1${i % 10}:00:00`, `/categories/c${i % 30}`),
  );
}

describe('mainNetworkByIdentity', () => {
  it('picks the busiest network, ties to the lower ASN, and skips NULL networks', () => {
    const main = mainNetworkByIdentity([
      { userAgentHash: 'a', cfAsn: 20, views: 3 },
      { userAgentHash: 'a', cfAsn: 10, views: 3 },
      { userAgentHash: 'a', cfAsn: null, views: 9 },
      { userAgentHash: 'b', cfAsn: null, views: 4 },
      { userAgentHash: null, cfAsn: 5, views: 1 },
    ]);
    expect(main.get('a')).toMatchObject({ total: 15, main: { cfAsn: 10, views: 3 } });
    expect(main.get('b')).toEqual({ total: 4, main: null });
    expect(main.size).toBe(2);
  });
});

describe('findCoordinatedGroups (AECI-1659)', () => {
  it('fires on the 2026-10-24 shape: synchronised start, partitioned crawl, large share', () => {
    const starts = Array.from({ length: 8 }, (_, i) => `00:00:${String(i * 5).padStart(2, '0')}`);
    const rows = [...crawler(8, 200, starts), ...background(4000)];
    const day = findCoordinatedGroups(rows, notInternal);
    const group = day.groups.find((g) => g.cfAsn === SEEDBOX);
    expect(group).toMatchObject({
      identities: 8,
      views: 1600,
      startAligned: 8,
      maxPairOverlap: 0,
      passes: { start: true, partition: true, share: true },
      coordinated: true,
    });
    expect(day.memberRowIds.size).toBe(1600);
  });

  it('marks a member row on any network, not only the main one', () => {
    const starts = ['00:00:00', '00:00:10', '00:00:20'];
    const rows = crawler(3, 30, starts);
    const residential = row('crawl0', ISP, '05:00:00', '/products/elsewhere');
    rows.push(residential);
    const day = findCoordinatedGroups(rows, notInternal);
    expect(day.memberRowIds.has(residential.id)).toBe(true);
  });

  it('does not fire on a three-identity office: staggered starts, shared pages, small share', () => {
    const office: CoordinatedRow[] = [];
    const starts = ['08:02:00', '09:15:00', '13:40:00'];
    starts.forEach((start, i) => {
      office.push(row(`office${i}`, ISP, start, '/'));
      for (let v = 0; v < 10; v += 1)
        office.push(row(`office${i}`, ISP, `14:0${v}:00`, `/products/p${v}`));
    });
    const day = findCoordinatedGroups([...office, ...background(2000)], notInternal);
    const group = day.groups.find((g) => g.cfAsn === ISP);
    expect(group?.passes).toEqual({ start: false, partition: false, share: false });
    expect(group?.coordinated).toBe(false);
    expect(day.memberRowIds.size).toBe(0);
  });

  it('keeps no group of two identities, however coordinated', () => {
    const rows = crawler(2, 200, ['00:00:00', '00:00:01']);
    const day = findCoordinatedGroups(rows, notInternal);
    expect(COORDINATED_MIN_IDENTITIES).toBe(3);
    expect(day.groups).toEqual([]);
    expect(day.memberRowIds.size).toBe(0);
  });

  it('needs two tests: a large share alone does not fire', () => {
    const rows: CoordinatedRow[] = [];
    ['01:00:00', '07:00:00', '15:00:00'].forEach((start, i) => {
      for (let v = 0; v < 100; v += 1)
        rows.push(row(`big${i}`, ISP, v === 0 ? start : '16:00:00', '/same'));
    });
    const day = findCoordinatedGroups([...rows, ...background(500)], notInternal);
    const group = day.groups.find((g) => g.cfAsn === ISP);
    expect(group?.passes).toEqual({ start: false, partition: false, share: true });
    expect(group?.coordinated).toBe(false);
  });

  it("does not fire on the operator's four labelled-session browsers on one home network", () => {
    const rows: CoordinatedRow[] = [];
    ['10:00:00', '10:20:00', '10:40:00', '11:00:00'].forEach((start, i) => {
      rows.push(row(`browser${i}`, ISP, start, '/'));
      for (const path of ['/products/a', '/products/b', '/categories/x']) {
        rows.push(row(`browser${i}`, ISP, start, path));
      }
    });
    const day = findCoordinatedGroups(rows, notInternal);
    expect(day.groups[0]).toMatchObject({ identities: 4, coordinated: false });
    expect(day.groups[0]?.passes.start).toBe(false);
    expect(day.groups[0]?.passes.partition).toBe(false);
  });

  it('never groups a privacy row, which has no hash and no network', () => {
    const rows = [
      row(null, null, '00:00:00', '/a'),
      row(null, null, '00:00:00', '/b'),
      row(null, null, '00:00:00', '/c'),
      row('h1', null, '00:00:00', '/d'),
    ];
    const day = findCoordinatedGroups(rows, notInternal);
    expect(day.groups).toEqual([]);
  });

  it('counts the share over non-internal views only', () => {
    const starts = ['00:00:00', '00:00:10', '00:00:20'];
    const rows = [...crawler(3, 10, starts), ...background(100)];
    const internalIds = new Set(rows.slice(0, 30).map((r) => r.id));
    const day = findCoordinatedGroups(rows, (r) => internalIds.has(r.id));
    expect(day.groups.find((g) => g.cfAsn === SEEDBOX)?.share).toBe(0);
  });

  it('does not count two first views exactly one window apart as aligned', () => {
    const rows = crawler(3, 5, ['00:00:00', '00:01:00', '00:02:00']);
    const group = findCoordinatedGroups(rows, notInternal).groups[0];
    expect(group?.startAligned).toBe(1);
    expect(group?.passes.start).toBe(false);
  });
});

/**
 * The AECI-1584 hash-level candidates: their thresholds, the hop veto, the overlay
 * against the real classifier, and one load → run → report pass over the real
 * migrations.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestDb, type TestDb } from '../test/d1';
import { classifyPageView, type ClassifierContext, type ClassifierRow } from './traffic-classifier';
import {
  candidateCells,
  candidateClass,
  candidateFamiliesFor,
  familiesOfCodes,
  hashCrawlShape,
  readHashWindows,
  relaxedSwarm,
  renderCandidateMarkdown,
  type CandidateCell,
  type CandidateVariant,
  type HashWindow,
} from './traffic-shadow-candidates';
import { loadPulledRows, PULL_COLUMNS, runShadow, type PulledPageView } from './traffic-shadow';

function hashWindow(overrides: Partial<HashWindow> = {}): HashWindow {
  return {
    userAgentHash: 'ua-proxy',
    arrivals: 100,
    distinctPaths: 80,
    distinctAsns: 40,
    activeDays: 7,
    dayArrivals: 0,
    dayDistinctPaths: 0,
    dayDistinctAsns: 0,
    dayDistinctCountries: 0,
    verifiedHops: 0,
    dayReferred: 0,
    dayTurnstilePass: 0,
    dayTurnstileFail: 0,
    dayTurnstileUnknown: 0,
    dayTurnstileNone: 0,
    ...overrides,
  };
}

const SHAPE = { viewFloor: 15, pathRatio: 0.5, minAsns: 5 };
const SWARM = { swarmRatio: 0.3, minAsns: 5 };

describe('hashCrawlShape', () => {
  it('passes at each bound, inclusive', () => {
    expect(
      hashCrawlShape(hashWindow({ arrivals: 15, distinctPaths: 8, distinctAsns: 5 }), SHAPE),
    ).toBe(true);
    const exact = { arrivals: 16, distinctPaths: 8, distinctAsns: 5 };
    expect(hashCrawlShape(hashWindow(exact), SHAPE)).toBe(true);
  });

  it.each([
    ['one view short', { arrivals: 14, distinctPaths: 14, distinctAsns: 5 }],
    ['one network short', { arrivals: 15, distinctPaths: 15, distinctAsns: 4 }],
    ['under the path ratio', { arrivals: 16, distinctPaths: 7, distinctAsns: 5 }],
  ])('fails %s', (_name, counts) => {
    expect(hashCrawlShape(hashWindow(counts), SHAPE)).toBe(false);
  });

  it('passes on the day alone when revisits sink the span ratio', () => {
    const w = hashWindow({
      arrivals: 200,
      distinctPaths: 60,
      distinctAsns: 50,
      dayArrivals: 40,
      dayDistinctPaths: 38,
      dayDistinctAsns: 20,
    });
    expect(hashCrawlShape(w, SHAPE)).toBe(true);
  });

  it('is stopped by a single verified hop', () => {
    expect(hashCrawlShape(hashWindow({ verifiedHops: 1 }), SHAPE)).toBe(false);
  });
});

describe('relaxedSwarm', () => {
  it('passes at each bound, inclusive', () => {
    const w = hashWindow({ dayArrivals: 10, dayDistinctAsns: 5 });
    expect(relaxedSwarm(w, { swarmRatio: 0.5, minAsns: 5 })).toBe(true);
  });

  it('reads 069245a2 on 2026-11-02: 178 networks over 401 views passes 0.4 and fails 0.5', () => {
    const w = hashWindow({ dayArrivals: 401, dayDistinctAsns: 178 });
    expect(relaxedSwarm(w, { swarmRatio: 0.4, minAsns: 5 })).toBe(true);
    expect(relaxedSwarm(w, { swarmRatio: 0.5, minAsns: 5 })).toBe(false);
  });

  it('fails with no arrivals on the day, under the network floor, and on a hop', () => {
    expect(relaxedSwarm(hashWindow(), SWARM)).toBe(false);
    expect(relaxedSwarm(hashWindow({ dayArrivals: 4, dayDistinctAsns: 4 }), SWARM)).toBe(false);
    expect(
      relaxedSwarm(hashWindow({ dayArrivals: 10, dayDistinctAsns: 10, verifiedHops: 1 }), SWARM),
    ).toBe(false);
  });
});

describe('candidateClass over the real classifier', () => {
  const baseRow: ClassifierRow = {
    id: 1,
    createdAt: '2026-11-02T10:00:00.000Z',
    concretePath: '/products/a',
    navigation: 'arrival',
    writerProvenance: 'ssr-arrival',
    clientVerdict: 'browser',
    isBot: false,
    botName: null,
    cfAsn: 17072,
    cfVerifiedBot: null,
    cfVerifiedBotCategory: null,
    hasSecChUa: true,
    hasAcceptLanguage: true,
    secFetchDest: 'document',
    tlsVersion: 'TLSv1.3',
    referrerSource: 'Direct',
    isOperator: false,
    userAgentHash: 'ua-proxy',
    privacySignal: false,
  };
  const baseCtx: ClassifierContext = {
    swarmUaHashes: new Set(),
    rotatorAsns: new Set(),
    networkClassByAsn: new Map(),
    internalRowIds: new Set(),
    spaFollowupRowIds: new Set(),
    crawlShapeRowIds: new Set(),
    burstRowIds: new Set(),
  };

  // Every shape of row the running rules treat differently.
  const ROWS: [string, ClassifierRow, Partial<ClassifierContext>][] = [
    ['a quiet row', baseRow, {}],
    ['a pair crawl-shape row', baseRow, { crawlShapeRowIds: new Set([1]) }],
    ['a non-eyeball row', baseRow, { networkClassByAsn: new Map([[17072, 'non_eyeball']]) }],
    ['a request-shape row', { ...baseRow, clientVerdict: 'inconsistent' }, {}],
    [
      'an identified row',
      { ...baseRow, isBot: true, botName: 'Googlebot', cfVerifiedBotCategory: 'x' },
      {},
    ],
    ['a followed-up row', baseRow, { spaFollowupRowIds: new Set([1]) }],
  ];

  it.each(ROWS)('adds nothing to %s', (_name, row, overrides) => {
    const result = classifyPageView(row, { ...baseCtx, ...overrides });
    expect(candidateClass(result.class, familiesOfCodes(result.reasonCodes), [])).toBe(
      result.class,
    );
  });

  it.each(ROWS)(
    'adding swarm to %s matches the classifier given the same flag',
    (_n, row, over) => {
      const before = classifyPageView(row, { ...baseCtx, ...over });
      const withSwarm = classifyPageView(row, {
        ...baseCtx,
        ...over,
        swarmUaHashes: new Set(['ua-proxy']),
      });
      expect(candidateClass(before.class, familiesOfCodes(before.reasonCodes), ['swarm'])).toBe(
        withSwarm.class,
      );
    },
  );

  it('keeps a merged hash signal in one family, and a distinct one in two', () => {
    const pair = classifyPageView(baseRow, { ...baseCtx, crawlShapeRowIds: new Set([1]) });
    const families = familiesOfCodes(pair.reasonCodes);
    expect(pair.class).toBe('unresolved');
    expect(candidateClass(pair.class, families, ['crawl_shape'])).toBe('unresolved');
    expect(candidateClass(pair.class, families, ['hash_crawl_shape'])).toBe('suspected_automation');
  });
});

describe('candidateFamiliesFor', () => {
  const cell = (variant: CandidateVariant): CandidateCell => ({
    variant,
    viewFloor: variant === 'swarm' ? null : 15,
    pathRatio: variant === 'swarm' ? null : 0.5,
    minAsns: 5,
    swarmRatio: variant === 'hash_merged' || variant === 'hash_distinct' ? null : 0.3,
  });
  const proxy = hashWindow({ dayArrivals: 20, dayDistinctPaths: 18, dayDistinctAsns: 10 });

  it('adds what each variant names', () => {
    expect(candidateFamiliesFor(cell('hash_merged'), proxy, true)).toEqual(['crawl_shape']);
    expect(candidateFamiliesFor(cell('hash_distinct'), proxy, true)).toEqual(['hash_crawl_shape']);
    expect(candidateFamiliesFor(cell('swarm'), proxy, true)).toEqual(['swarm']);
    expect(candidateFamiliesFor(cell('hash_and_swarm'), proxy, true)).toEqual([
      'crawl_shape',
      'swarm',
    ]);
  });

  it('never marks a row that is not an arrival with crawl shape, and swarm still reaches it', () => {
    expect(candidateFamiliesFor(cell('hash_and_swarm'), proxy, false)).toEqual(['swarm']);
  });

  it('adds nothing for a hash under every floor, which has no window', () => {
    expect(candidateFamiliesFor(cell('hash_and_swarm'), undefined, true)).toEqual([]);
  });
});

describe('candidateCells', () => {
  it('compares every variant, with no duplicate cell', () => {
    const cells = candidateCells();
    expect(cells.filter((c) => c.variant === 'hash_merged')).toHaveLength(18);
    expect(cells.filter((c) => c.variant === 'hash_distinct')).toHaveLength(18);
    expect(cells.filter((c) => c.variant === 'swarm')).toHaveLength(9);
    expect(cells.filter((c) => c.variant === 'hash_and_swarm')).toHaveLength(54);
    expect(new Set(cells.map((c) => JSON.stringify(c))).size).toBe(cells.length);
  });
});

describe('the candidates over the real migrations', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  const NO_LABELS = { sessions: [], heldOutDays: [] };
  const DAY = '2026-11-02';
  const TARGET = '069245a268913b99e9d1f7bb5cb460c4';

  function pulled(
    overrides: Partial<PulledPageView> & { id: number; created_at: string },
  ): PulledPageView {
    const base = Object.fromEntries(PULL_COLUMNS.map((c) => [c, null])) as PulledPageView;
    return {
      ...base,
      path: '/products/:slug',
      concrete_path: '/products/procore',
      navigation: 'arrival',
      writer_provenance: 'ssr-arrival',
      client_verdict: 'browser',
      is_bot: 0,
      is_operator: 0,
      cf_asn: 7713,
      tls_version: 'TLSv1.3',
      referrer_source: 'Direct',
      user_agent_hash: 'ua-visitor',
      ...overrides,
    };
  }

  /**
   * `count` views under one hash, each on its own page, across 13 consumer networks.
   * 13 networks over 30 views is 0.43, the target's shape: under the running swarm bars.
   */
  function spread(hash: string, startId: number, count: number): PulledPageView[] {
    return Array.from({ length: count }, (_, i) =>
      pulled({
        id: startId + i,
        created_at: `${DAY}T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
        concrete_path: `/products/p${i}`,
        cf_asn: 20000 + (i % 13),
        user_agent_hash: hash,
        turnstile_verdict: i === 0 ? 'fail' : null,
      }),
    );
  }

  const WIDEST_BOTH = {
    variant: 'hash_and_swarm',
    viewFloor: 15,
    pathRatio: 0.5,
    minAsns: 5,
    swarmRatio: 0.2,
  };
  const WIDEST_HASH = { ...WIDEST_BOTH, variant: 'hash_merged', swarmRatio: null };
  const WIDEST_SWARM = { ...WIDEST_BOTH, variant: 'swarm', viewFloor: null, pathRatio: null };

  it("reaches the target's tail only with both families", async () => {
    await loadPulledRows(t.db, spread(TARGET, 1, 30), []);
    const { candidates } = await runShadow(t.db, { fromDay: DAY, toDay: DAY, labels: NO_LABELS });
    const cellOf = (match: Record<string, unknown>) =>
      candidates.cells.find((c) =>
        Object.entries(match).every(([k, v]) => c[k as keyof typeof c] === v),
      );
    expect(cellOf(WIDEST_HASH)?.tuning.targetAutomationAfter).toBe(0);
    expect(cellOf(WIDEST_SWARM)?.tuning.targetAutomationAfter).toBe(0);
    const both = cellOf(WIDEST_BOTH)?.tuning;
    expect(both?.targetViews).toBe(30);
    expect(both?.targetAutomationAfter).toBe(30);
    expect(both?.movedHashes).toBe(1);
    expect(both?.unresolvedShareAfter).toBe(0);
    expect(candidates.review[0]?.turnstile).toEqual({ pass: 0, fail: 1, unknown: 0, none: 29 });
  });

  it('does not flag a popular-browser hash with one hop, and lists it as hop-dependent', async () => {
    const hop = pulled({
      id: 100,
      created_at: `${DAY}T11:00:00.000Z`,
      navigation: 'spa',
      writer_provenance: 'browser-spa',
      cf_asn: 20000,
      user_agent_hash: 'ua-popular',
    });
    await loadPulledRows(t.db, [...spread('ua-popular', 1, 30), hop], []);
    const { candidates } = await runShadow(t.db, { fromDay: DAY, toDay: DAY, labels: NO_LABELS });
    expect(candidates.review).toEqual([]);
    expect(candidates.cells.every((c) => c.tuning.movedViews === 0)).toBe(true);
    expect(candidates.vetoDependent).toHaveLength(1);
    expect(candidates.vetoDependent[0]?.verifiedHops).toBe(1);
  });

  it('reports a flagged hash that shows a hop on a later day', async () => {
    const later = pulled({
      id: 100,
      created_at: '2026-11-04T11:00:00.000Z',
      navigation: 'spa',
      writer_provenance: 'browser-spa',
      user_agent_hash: 'ua-later',
    });
    await loadPulledRows(t.db, [...spread('ua-later', 1, 30), later], []);
    const { candidates } = await runShadow(t.db, {
      fromDay: DAY,
      toDay: '2026-11-04',
      labels: NO_LABELS,
    });
    expect(candidates.laterHops.map((l) => l.laterHopDays)).toEqual([['2026-11-04']]);
    expect(candidates.review[0]?.laterHop).toBe(true);
  });

  it('never matches a privacy row or a NULL hash', async () => {
    const privacy = Array.from({ length: 30 }, (_, i) =>
      pulled({
        id: i + 1,
        created_at: `${DAY}T10:00:00.000Z`,
        concrete_path: `/products/p${i}`,
        cf_asn: null,
        user_agent_hash: null,
        privacy_signal: 1,
      }),
    );
    await loadPulledRows(t.db, privacy, []);
    expect(await readHashWindows(t.db, DAY)).toEqual([]);
    const { candidates } = await runShadow(t.db, { fromDay: DAY, toDay: DAY, labels: NO_LABELS });
    expect(candidates.cells.every((c) => c.tuning.movedViews === 0)).toBe(true);
    expect(candidates.digest[0]?.lines).toEqual([]);
  });

  it('shows a hash above the digest line that no pair reaches', async () => {
    const others = Array.from({ length: 70 }, (_, i) =>
      pulled({
        id: 1000 + i,
        created_at: `${DAY}T12:00:00.000Z`,
        concrete_path: `/products/o${i}`,
        cf_asn: 30000 + i,
        user_agent_hash: `ua-other-${i}`,
      }),
    );
    await loadPulledRows(t.db, [...spread(TARGET, 1, 30), ...others], []);
    const { candidates } = await runShadow(t.db, { fromDay: DAY, toDay: DAY, labels: NO_LABELS });
    const day = candidates.digest[0];
    expect(day?.pairsAboveLine).toBe(0);
    expect(day?.lines[0]?.userAgentHash).toBe(TARGET);
    expect(day?.lines[0]?.aboveLine).toBe(true);
    expect(day?.lines[0]?.distinctAsns).toBe(13);
  });

  it('keeps held-out figures out of the tuning table and last in the report', async () => {
    await loadPulledRows(t.db, spread(TARGET, 1, 30), []);
    const { candidates } = await runShadow(t.db, {
      fromDay: DAY,
      toDay: DAY,
      labels: { sessions: [], heldOutDays: [DAY] },
    });
    expect(candidates.cells.every((c) => c.tuning.movedViews === 0)).toBe(true);
    const moved = candidates.cells.find((c) => c.heldOut.movedViews > 0);
    expect(moved).toBeDefined();
    const md = renderCandidateMarkdown(candidates).join('\n');
    expect(md.indexOf('Held-out days')).toBeGreaterThan(md.indexOf('Digest candidate'));
    expect(md).toContain('The target has no rows on the tuning days.');
  });
});

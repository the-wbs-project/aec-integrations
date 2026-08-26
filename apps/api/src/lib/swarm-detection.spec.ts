/**
 * Unit tests for the rotating-proxy swarm detector (AECI-658).
 *
 * The centrepiece is a replay of the real production shape from UTC day
 * 2026-08-23 — the day the digest reported 48 "human" views that turned out to
 * be a handful of automated clients behind a residential-proxy pool. That day is
 * the reason this module exists, so it is the regression test.
 *
 * The other half of the suite is false-positive guards: a household on one ISP,
 * a self-identifying crawler, and a low-volume visitor must never be flagged.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pageViews } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  detectSwarms,
  isCorroboratedByRequestShape,
  swarmNote,
  SWARM_MIN_ASN_RATIO,
  SWARM_MIN_VIEWS,
  type SwarmCandidate,
} from './swarm-detection';

const DAY_START = '2026-08-23T00:00:00.000Z';
const DAY_END = '2026-08-24T00:00:00.000Z';

/** One `page_views` row, with the fields the detector actually groups on. */
function view(
  overrides: Partial<typeof pageViews.$inferInsert> & { createdAt: string },
): typeof pageViews.$inferInsert {
  return { path: '/', concretePath: '/', ...overrides };
}

describe('detectSwarms', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  it('reassembles the real 2026-08-23 swarm that cf_asn fragmented', async () => {
    // The production shape: ONE user-agent hash, nine views, nine different
    // networks in nine different countries, nine different pages, no repeats.
    // Grouped by `cf_asn` this looks like nine separate visitors; grouped by
    // `user_agent_hash` it is one client.
    const swarmPages = [
      '/products/smartapp',
      '/products/salus',
      '/audiences/mep-engineering',
      '/categories/project-management',
      '/categories/document-management',
      '/categories/workforce-management',
      '/legal/review-guidelines',
      '/audiences/general-contracting',
      '/audiences/project-manager',
    ];
    const asns = [23201, 262300, 263703, 14080, 5089, 15802, 14593, 11260, 270310];
    const countries = ['PY', 'BR', 'VE', 'CO', 'GB', 'AE', 'KE', 'CA', 'BR'];

    await t.db.insert(pageViews).values(
      swarmPages.map((p, i) =>
        view({
          path: p,
          concretePath: p,
          userAgentHash: 'ua-swarm-01',
          cfAsn: asns[i],
          cfCountry: countries[i],
          clientVerdict: 'inconsistent',
          createdAt: `2026-08-23T${String(i + 1).padStart(2, '0')}:00:00.000Z`,
        }),
      ),
    );

    const summary = await detectSwarms(t.db, DAY_START, DAY_END);

    expect(summary.candidates).toHaveLength(1);
    const [candidate] = summary.candidates;
    expect(candidate.userAgentHash).toBe('ua-swarm-01');
    expect(candidate.views).toBe(9);
    expect(candidate.distinctAsns).toBe(9);
    expect(candidate.distinctCountries).toBe(8); // BR appears twice
    expect(candidate.distinctPaths).toBe(9);
    expect(candidate.asnRatio).toBe(1);
    expect(candidate.pathRatio).toBe(1);
    expect(summary.flaggedViews).toBe(9);
    expect(summary.totalHumanViews).toBe(9);
  });

  it('does not flag a real visitor reading several pages on one network', async () => {
    // The shape that must never be flagged: one person, one ISP, many pages.
    await t.db.insert(pageViews).values(
      ['/', '/products', '/products/procore', '/products/procore', '/categories/ai'].map((p, i) =>
        view({
          path: p,
          concretePath: p,
          userAgentHash: 'ua-real-person',
          cfAsn: 7922,
          cfCountry: 'US',
          clientVerdict: 'browser',
          createdAt: `2026-08-23T1${i}:00:00.000Z`,
        }),
      ),
    );

    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.candidates).toEqual([]);
    expect(summary.flaggedViews).toBe(0);
    expect(summary.totalHumanViews).toBe(5);
  });

  it('ignores a UA hash below the minimum view count', async () => {
    // Three views from three networks is ratio 1.0 but far too little evidence.
    // Without the floor, every single-hit visitor on the site would be flagged.
    await t.db.insert(pageViews).values(
      [1, 2, 3].map((i) =>
        view({
          userAgentHash: 'ua-sparse',
          cfAsn: 1000 + i,
          cfCountry: 'US',
          createdAt: `2026-08-23T0${i}:00:00.000Z`,
        }),
      ),
    );
    expect(SWARM_MIN_VIEWS).toBeGreaterThan(3);
    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.candidates).toEqual([]);
  });

  it('never sees a self-identifying crawler, because bots are excluded upstream', async () => {
    // Googlebot crawls many pages from a couple of Google ASNs. It is already
    // `is_bot = 1` via the UA, so it can never reach this population at all —
    // asserted rather than assumed, because a future refactor that dropped the
    // shared HUMAN predicate would silently start double-counting crawlers here.
    await t.db.insert(pageViews).values(
      [1, 2, 3, 4, 5, 6].map((i) =>
        view({
          path: `/products/p${i}`,
          concretePath: `/products/p${i}`,
          userAgentHash: 'ua-googlebot',
          cfAsn: 15169 + i,
          cfCountry: 'US',
          isBot: true,
          botName: 'Googlebot',
          createdAt: `2026-08-23T0${i}:00:00.000Z`,
        }),
      ),
    );
    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.candidates).toEqual([]);
    expect(summary.totalHumanViews).toBe(0);
  });

  it('excludes operator traffic, matching the digest population exactly', async () => {
    // If this drifted from the digest's own predicate, "N of the M reported
    // views" would be comparing two different sets.
    await t.db.insert(pageViews).values(
      [1, 2, 3, 4, 5].map((i) =>
        view({
          userAgentHash: 'ua-operator',
          cfAsn: 23700 + i,
          cfCountry: 'ID',
          isOperator: true,
          createdAt: `2026-08-23T0${i}:00:00.000Z`,
        }),
      ),
    );
    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.candidates).toEqual([]);
    expect(summary.totalHumanViews).toBe(0);
  });

  it('does not group rows with a null user-agent hash into one fake swarm', async () => {
    // Bucketing nulls under a synthetic key would invent one enormous candidate
    // out of unrelated rows.
    await t.db.insert(pageViews).values(
      [1, 2, 3, 4, 5, 6].map((i) =>
        view({
          userAgentHash: null,
          cfAsn: 5000 + i,
          cfCountry: 'US',
          createdAt: `2026-08-23T0${i}:00:00.000Z`,
        }),
      ),
    );
    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.candidates).toEqual([]);
    // They are still real human views, so the denominator must include them.
    expect(summary.totalHumanViews).toBe(6);
  });

  it('stays inside the requested window', async () => {
    const rows = [1, 2, 3, 4, 5].map((i) =>
      view({
        userAgentHash: 'ua-swarm',
        cfAsn: 6000 + i,
        cfCountry: 'US',
        createdAt: `2026-08-22T0${i}:00:00.000Z`,
      }),
    );
    await t.db.insert(pageViews).values(rows);
    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.candidates).toEqual([]);
    expect(summary.totalHumanViews).toBe(0);
  });

  it('counts the client_verdict mix so cardinality is not the only evidence', async () => {
    // The signal that survives traffic growth: a high-cardinality UA hash whose
    // rows ALSO look non-browser. Null verdicts (pre-AECI-658 rows) count as
    // neither, never as browser.
    await t.db.insert(pageViews).values([
      ...[1, 2, 3].map((i) =>
        view({
          userAgentHash: 'ua-mixed',
          cfAsn: 7000 + i,
          cfCountry: 'US',
          clientVerdict: 'inconsistent',
          createdAt: `2026-08-23T0${i}:00:00.000Z`,
        }),
      ),
      view({
        userAgentHash: 'ua-mixed',
        cfAsn: 7004,
        cfCountry: 'US',
        clientVerdict: null,
        createdAt: '2026-08-23T04:00:00.000Z',
      }),
    ]);
    const [candidate] = (await detectSwarms(t.db, DAY_START, DAY_END)).candidates;
    expect(candidate.views).toBe(4);
    expect(candidate.nonBrowserViews).toBe(3);
    expect(isCorroboratedByRequestShape(candidate)).toBe(true);
  });
});

describe('swarmNote', () => {
  const candidate = (views: number): SwarmCandidate => ({
    userAgentHash: 'ua',
    views,
    distinctAsns: views,
    distinctCountries: views,
    distinctPaths: views,
    nonBrowserViews: views,
    asnRatio: 1,
    pathRatio: 1,
  });

  it('is null when nothing was flagged, so the digest stays quiet', () => {
    expect(swarmNote({ candidates: [], flaggedViews: 0, totalHumanViews: 40 })).toBeNull();
  });

  it('frames the finding as a proportion of the reported number', () => {
    const note = swarmNote({
      candidates: [candidate(9), candidate(5)],
      flaggedViews: 14,
      totalHumanViews: 48,
    });
    expect(note).toContain('14 of 48');
    expect(note).toContain('2 clients');
  });

  it('singularizes a lone client', () => {
    const note = swarmNote({ candidates: [candidate(9)], flaggedViews: 9, totalHumanViews: 48 });
    expect(note).toContain('1 client');
  });

  it('hedges rather than asserting, because this is a heuristic', () => {
    const note = swarmNote({ candidates: [candidate(9)], flaggedViews: 9, totalHumanViews: 48 });
    expect(note).toContain('may not be people');
  });

  it('is plain ASCII so it renders in the plain-text email', () => {
    const note = swarmNote({ candidates: [candidate(9)], flaggedViews: 9, totalHumanViews: 48 });
    // eslint-disable-next-line no-control-regex
    expect(note).toMatch(/^[\x00-\x7F]*$/);
  });
});

describe('isCorroboratedByRequestShape', () => {
  it('requires a majority of the views to look non-browser', () => {
    const base: SwarmCandidate = {
      userAgentHash: 'ua',
      views: 10,
      distinctAsns: 10,
      distinctCountries: 9,
      distinctPaths: 10,
      nonBrowserViews: 5,
      asnRatio: 1,
      pathRatio: 1,
    };
    expect(isCorroboratedByRequestShape(base)).toBe(false);
    expect(isCorroboratedByRequestShape({ ...base, nonBrowserViews: 6 })).toBe(true);
  });
});

describe('thresholds', () => {
  it('documents the tunables the runbook refers to', () => {
    expect(SWARM_MIN_VIEWS).toBe(4);
    expect(SWARM_MIN_ASN_RATIO).toBe(0.8);
  });
});

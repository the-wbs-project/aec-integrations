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
  ASN_ROTATOR_MIN_UA_RATIO,
  ASN_ROTATOR_MIN_VIEWS,
  detectAsnRotators,
  detectNonBrowserClients,
  detectSwarms,
  isCorroboratedByRequestShape,
  NON_BROWSER_VERDICTS,
  swarmNote,
  SWARM_MAX_CANDIDATES,
  SWARM_MIN_ASN_RATIO,
  SWARM_MIN_VIEWS,
  type SwarmCandidate,
  type SwarmSummary,
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

    expect(summary.uaCandidates).toHaveLength(1);
    const [candidate] = summary.uaCandidates;
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
    expect(summary.uaCandidates).toEqual([]);
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
    expect(summary.uaCandidates).toEqual([]);
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
    expect(summary.uaCandidates).toEqual([]);
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
    expect(summary.uaCandidates).toEqual([]);
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
    expect(summary.uaCandidates).toEqual([]);
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
    expect(summary.uaCandidates).toEqual([]);
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
    const [candidate] = (await detectSwarms(t.db, DAY_START, DAY_END)).uaCandidates;
    expect(candidate.views).toBe(4);
    expect(candidate.nonBrowserViews).toBe(3);
    expect(isCorroboratedByRequestShape(candidate)).toBe(true);
  });
});

describe('detectAsnRotators (the inverse grouping, AECI-683)', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  /** The AS47544 shape from production 2026-08-26: one network, a new fingerprint
   *  every request, headers that do not look like a browser. */
  const rotatorRows = (verdict: string) =>
    ['/products/a', '/products/b', '/products/c', '/products/d', '/products/e'].map((p, i) =>
      view({
        path: p,
        concretePath: p,
        userAgentHash: `ua-rot-${i}`,
        cfAsn: 47544,
        cfAsOrganization: 'Example Hosting',
        cfCountry: 'PL',
        clientVerdict: verdict,
        createdAt: `2026-08-23T0${i}:00:00.000Z`,
      }),
    );

  it('reassembles a user-agent rotator that the UA-hash grouping cannot see', async () => {
    await t.db.insert(pageViews).values(rotatorRows('inconsistent'));

    // The whole point: grouped by UA hash these are five singletons, every one of
    // them under SWARM_MIN_VIEWS, so the original detector reports nothing.
    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.uaCandidates).toEqual([]);

    expect(summary.asnCandidates).toHaveLength(1);
    const [candidate] = summary.asnCandidates;
    expect(candidate.cfAsn).toBe(47544);
    expect(candidate.asOrganization).toBe('Example Hosting');
    expect(candidate.views).toBe(5);
    expect(candidate.distinctUaHashes).toBe(5);
    expect(candidate.uaRatio).toBe(1);
    expect(candidate.nonBrowserViews).toBe(5);
    expect(summary.flaggedViews).toBe(5);
  });

  it('does NOT flag a shared network whose requests look like real browsers', async () => {
    // The false positive that makes the request-shape verdict a hard gate here:
    // an office NAT, a campus, or a cafe is five devices on one ASN at ratio 1.0.
    // Cardinality alone would flag every shared connection on the internet.
    await t.db.insert(pageViews).values(rotatorRows('browser'));

    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.asnCandidates).toEqual([]);
    expect(summary.flaggedViews).toBe(0);
  });

  it('treats a NULL client_verdict as no evidence, not as corroboration', async () => {
    // Every row written before AECI-658 has a null verdict. Reading those as
    // non-browser would retroactively flag months of ordinary shared networks.
    await t.db.insert(pageViews).values(rotatorRows('unknown'));
    expect(await detectAsnRotators(t.db, DAY_START, DAY_END)).toEqual([]);
  });

  it('ignores an ASN whose visitors reuse fingerprints, however many views', async () => {
    // A busy real network: 8 views, 2 browsers. Ratio 0.25.
    await t.db.insert(pageViews).values(
      Array.from({ length: 8 }, (_, i) =>
        view({
          userAgentHash: i % 2 === 0 ? 'ua-x' : 'ua-y',
          cfAsn: 7922,
          clientVerdict: 'non-browser',
          createdAt: `2026-08-23T0${i}:00:00.000Z`,
        }),
      ),
    );
    expect(await detectAsnRotators(t.db, DAY_START, DAY_END)).toEqual([]);
  });

  it('does not bucket rows with a NULL ASN into one synthetic network', async () => {
    await t.db.insert(pageViews).values(
      Array.from({ length: 6 }, (_, i) =>
        view({
          userAgentHash: `ua-${i}`,
          cfAsn: null,
          clientVerdict: 'non-browser',
          createdAt: `2026-08-23T0${i}:00:00.000Z`,
        }),
      ),
    );
    expect(await detectAsnRotators(t.db, DAY_START, DAY_END)).toEqual([]);
  });

  it('counts views flagged by BOTH groupings once, not twice', async () => {
    // One ASN, five distinct hashes, and one of those hashes ALSO spans four
    // networks — so it is a UA-hash candidate and its AS47544 view is an ASN
    // candidate too. Summing the two candidate lists would report 9 of 8.
    await t.db.insert(pageViews).values([
      ...rotatorRows('non-browser'),
      // `ua-rot-0` again, on three more networks — now 4 views / 4 ASNs.
      ...[100, 200, 300].map((asn, i) =>
        view({
          path: `/categories/c${i}`,
          concretePath: `/categories/c${i}`,
          userAgentHash: 'ua-rot-0',
          cfAsn: asn,
          clientVerdict: 'non-browser',
          createdAt: `2026-08-23T1${i}:00:00.000Z`,
        }),
      ),
    ]);

    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.uaCandidates.map((c) => c.userAgentHash)).toEqual(['ua-rot-0']);
    expect(summary.asnCandidates.map((c) => c.cfAsn)).toEqual([47544]);
    // 5 on AS47544 + 3 elsewhere on ua-rot-0 = 8 distinct views. The naive sum
    // (4 from the UA candidate + 5 from the ASN candidate) would be 9.
    expect(summary.totalHumanViews).toBe(8);
    expect(summary.flaggedViews).toBe(8);
  });

  it('excludes bots and operator traffic, exactly like the UA-hash grouping', async () => {
    await t.db.insert(pageViews).values([
      ...rotatorRows('non-browser').map((r) => ({ ...r, isBot: true, botName: 'Bingbot' })),
      ...rotatorRows('non-browser').map((r, i) => ({
        ...r,
        cfAsn: 23700,
        isOperator: true,
        createdAt: `2026-08-23T1${i}:00:00.000Z`,
      })),
    ]);
    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.asnCandidates).toEqual([]);
    expect(summary.totalHumanViews).toBe(0);
  });
});

describe('detectNonBrowserClients (the verdict as sufficient evidence, AECI-744)', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  it('flags the real 2026-08-29 client that both view floors let through', async () => {
    // `87012404...` in production: three views, three different US networks, ONE
    // fingerprint, seventeen hours apart, every row `inconsistent`. Its ASN ratio
    // is 1.00 and it is under SWARM_MIN_VIEWS by exactly one view, so before this
    // it was admitted as three human visitors on a technicality.
    await t.db.insert(pageViews).values(
      [
        { asn: 20115, org: 'Charter Communications', at: '2026-08-23T01:00:00.000Z' },
        { asn: 199737, org: 'Rockion LLC', at: '2026-08-23T11:00:00.000Z' },
        { asn: 53356, org: 'Airfiber', at: '2026-08-23T18:00:00.000Z' },
      ].map((r, i) =>
        view({
          path: `/products/p${i}`,
          concretePath: `/products/p${i}`,
          userAgentHash: 'ua-87012404',
          cfAsn: r.asn,
          cfAsOrganization: r.org,
          cfCountry: 'US',
          clientVerdict: 'inconsistent',
          createdAt: r.at,
        }),
      ),
    );

    const summary = await detectSwarms(t.db, DAY_START, DAY_END);

    // Both floors still exclude it — this change does NOT lower them.
    expect(summary.uaCandidates).toEqual([]);
    expect(summary.asnCandidates).toEqual([]);

    // And it is flagged anyway, on the evidence in its own request headers.
    expect(summary.verdictFlaggedViews).toBe(3);
    expect(summary.flaggedViews).toBe(3);
    expect(summary.totalHumanViews).toBe(3);
    // Sorted here, not there: all three are one view, so `order by count desc`
    // leaves their relative order to SQLite.
    expect(summary.verdictCandidates.map((c) => c.asOrganization).sort()).toEqual([
      'Airfiber',
      'Charter Communications',
      'Rockion LLC',
    ]);
    expect(summary.verdictCandidates.every((c) => c.views === 1)).toBe(true);
  });

  it('flags a SINGLE view, because there is no floor at all', async () => {
    // The point of the issue in one assertion: n=1 is enough, because the verdict
    // is an observation about this request rather than a ratio over a sample.
    await t.db.insert(pageViews).values([
      view({
        userAgentHash: 'ua-lone',
        cfAsn: 23724,
        cfAsOrganization: 'UCLOUD',
        cfCountry: 'CN',
        clientVerdict: 'non-browser',
        createdAt: '2026-08-23T09:00:00.000Z',
      }),
    ]);
    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.verdictFlaggedViews).toBe(1);
    expect(summary.flaggedViews).toBe(1);
    expect(summary.verdictCandidates).toEqual([
      {
        cfAsn: 23724,
        asOrganization: 'UCLOUD',
        views: 1,
        distinctUaHashes: 1,
        distinctCountries: 1,
        distinctPaths: 1,
      },
    ]);
  });

  it.each([['browser'], ['unknown'], [null]])(
    'treats client_verdict %s as no evidence, never as "not a browser"',
    async (verdict) => {
      // The null case is the constraint that matters most: every row written
      // before AECI-658 has one, and reading those as non-browser would
      // retroactively erase months of real people from the reported numbers.
      await t.db.insert(pageViews).values(
        [1, 2, 3].map((i) =>
          view({
            userAgentHash: 'ua-person',
            cfAsn: 7922,
            cfCountry: 'US',
            clientVerdict: verdict,
            createdAt: `2026-08-23T0${i}:00:00.000Z`,
          }),
        ),
      );
      const summary = await detectSwarms(t.db, DAY_START, DAY_END);
      expect(summary.verdictCandidates).toEqual([]);
      expect(summary.verdictFlaggedViews).toBe(0);
      expect(summary.flaggedViews).toBe(0);
      expect(summary.totalHumanViews).toBe(3);
    },
  );

  it('keeps a NULL cf_asn as its own bucket rather than dropping it', async () => {
    // The opposite of what the two GROUPINGS do with a null key, and deliberately
    // so: they exclude it because bucketing nulls would invent a cardinality
    // inference out of unrelated rows. Here the rows are already flagged one by
    // one, so the bucket only says "we do not know the network" - which is true.
    await t.db.insert(pageViews).values([
      view({
        userAgentHash: 'ua-noasn',
        cfAsn: null,
        clientVerdict: 'non-browser',
        createdAt: '2026-08-23T05:00:00.000Z',
      }),
    ]);
    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.verdictCandidates).toHaveLength(1);
    expect(summary.verdictCandidates[0].cfAsn).toBeNull();
    expect(summary.flaggedViews).toBe(1);
  });

  it('counts a view flagged by a grouping AND by its verdict only once', async () => {
    // Same union property the two groupings already have, extended to the third
    // shape: nine views, all `inconsistent`, all on one flagged UA hash.
    await t.db.insert(pageViews).values(
      Array.from({ length: 9 }, (_, i) =>
        view({
          path: `/products/p${i}`,
          concretePath: `/products/p${i}`,
          userAgentHash: 'ua-swarm-01',
          cfAsn: 23201 + i,
          cfCountry: 'US',
          clientVerdict: 'inconsistent',
          createdAt: `2026-08-23T0${i}:00:00.000Z`,
        }),
      ),
    );
    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.uaCandidates).toHaveLength(1);
    expect(summary.verdictFlaggedViews).toBe(9);
    // 9 + 9 would be 18 of 9. The union is a query, not arithmetic.
    expect(summary.flaggedViews).toBe(9);
    expect(summary.totalHumanViews).toBe(9);
  });

  it('excludes bots, operator traffic and rows outside the window', async () => {
    // The same population guarantee the groupings have. A crawler is already
    // `is_bot = 1` and would double-count if this predicate ever drifted.
    await t.db.insert(pageViews).values([
      view({
        userAgentHash: 'ua-bot',
        cfAsn: 15169,
        clientVerdict: 'non-browser',
        isBot: true,
        botName: 'Googlebot',
        createdAt: '2026-08-23T01:00:00.000Z',
      }),
      view({
        userAgentHash: 'ua-op',
        cfAsn: 23700,
        clientVerdict: 'non-browser',
        isOperator: true,
        createdAt: '2026-08-23T02:00:00.000Z',
      }),
      view({
        userAgentHash: 'ua-yesterday',
        cfAsn: 1234,
        clientVerdict: 'non-browser',
        createdAt: '2026-08-22T23:00:00.000Z',
      }),
    ]);
    expect(await detectNonBrowserClients(t.db, DAY_START, DAY_END)).toEqual([]);
    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.verdictFlaggedViews).toBe(0);
    expect(summary.totalHumanViews).toBe(0);
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

  /** Fills the two AECI-744 fields for the cases that are not about them. The
   *  helper exists so a summary literal here cannot silently disagree with the
   *  one `detectSwarms` actually returns. */
  const renderNote = (
    summary: Omit<SwarmSummary, 'verdictCandidates' | 'verdictFlaggedViews'> &
      Partial<Pick<SwarmSummary, 'verdictCandidates' | 'verdictFlaggedViews'>>,
  ): string | null => swarmNote({ verdictCandidates: [], verdictFlaggedViews: 0, ...summary });

  it('is null when nothing was flagged, so the digest stays quiet', () => {
    expect(
      renderNote({
        uaCandidates: [],
        asnCandidates: [],
        truncated: false,
        flaggedViews: 0,
        totalHumanViews: 40,
      }),
    ).toBeNull();
  });

  it('frames the finding as a proportion of the reported number', () => {
    const note = renderNote({
      uaCandidates: [candidate(9), candidate(5)],
      asnCandidates: [],
      truncated: false,
      flaggedViews: 14,
      totalHumanViews: 48,
    });
    expect(note).toContain('14 of 48');
    expect(note).toContain('2 clients');
  });

  it('singularizes a lone client', () => {
    const note = renderNote({
      uaCandidates: [candidate(9)],
      asnCandidates: [],
      truncated: false,
      flaggedViews: 9,
      totalHumanViews: 48,
    });
    expect(note).toContain('1 client');
  });

  it('hedges rather than asserting, because this is a heuristic', () => {
    const note = renderNote({
      uaCandidates: [candidate(9)],
      asnCandidates: [],
      truncated: false,
      flaggedViews: 9,
      totalHumanViews: 48,
    });
    expect(note).toContain('may not be people');
  });

  it("names the second shape in its own words, not the first shape's", () => {
    // The two findings must not read alike: one is many networks behind one
    // fingerprint, the other is many fingerprints behind one network, and an
    // operator deciding what to do needs to know which they are looking at.
    const rotator = {
      cfAsn: 47544,
      asOrganization: 'Example Hosting',
      views: 5,
      distinctUaHashes: 5,
      distinctCountries: 1,
      distinctPaths: 5,
      nonBrowserViews: 5,
      uaRatio: 1,
      pathRatio: 1,
    };
    const note = renderNote({
      uaCandidates: [],
      asnCandidates: [rotator],
      truncated: false,
      flaggedViews: 5,
      totalHumanViews: 40,
    });
    expect(note).toContain('5 of 40');
    expect(note).toContain('1 network');
    expect(note).toContain('rotating its user-agent');
    expect(note).not.toContain('rotating proxy pool');

    const both = renderNote({
      uaCandidates: [candidate(9)],
      asnCandidates: [rotator],
      truncated: false,
      flaggedViews: 13,
      totalHumanViews: 40,
    });
    expect(both).toContain('rotating proxy pool');
    expect(both).toContain('rotating its user-agent');
    expect(both).toContain('; and ');
  });

  it('explains a day whose only flagged views came from the verdict (AECI-744)', () => {
    // The failure this closes: `note: null` tells `AutomationFilter` "the detector
    // ran and flagged nothing", while the headline is `raw - flaggedViews`. A
    // verdict-only day would then subtract 7 views with nothing in the email
    // saying why. Every subtraction gets a sentence.
    const verdictOnly = renderNote({
      uaCandidates: [],
      asnCandidates: [],
      verdictCandidates: [
        {
          cfAsn: 20115,
          asOrganization: 'Charter',
          views: 1,
          distinctUaHashes: 1,
          distinctCountries: 1,
          distinctPaths: 1,
        },
        {
          cfAsn: 199737,
          asOrganization: 'Rockion LLC',
          views: 2,
          distinctUaHashes: 1,
          distinctCountries: 1,
          distinctPaths: 2,
        },
      ],
      verdictFlaggedViews: 3,
      truncated: false,
      flaggedViews: 3,
      totalHumanViews: 37,
    });
    expect(verdictOnly).toContain('3 of 37');
    expect(verdictOnly).toContain('3 views');
    expect(verdictOnly).toContain('2 networks');
    expect(verdictOnly).toContain('do not look like a browser');
    // Its own words, like the other two clauses: this is not a cardinality claim.
    expect(verdictOnly).not.toContain('rotating proxy pool');
    expect(verdictOnly).not.toContain('rotating its user-agent');
  });

  it('singularizes a lone verdict-flagged view and network', () => {
    const one = renderNote({
      uaCandidates: [],
      asnCandidates: [],
      verdictCandidates: [
        {
          cfAsn: 23724,
          asOrganization: 'UCLOUD',
          views: 1,
          distinctUaHashes: 1,
          distinctCountries: 1,
          distinctPaths: 1,
        },
      ],
      verdictFlaggedViews: 1,
      truncated: false,
      flaggedViews: 1,
      totalHumanViews: 37,
    });
    expect(one).toContain('1 view ');
    expect(one).toContain('1 network');
  });

  it('says so when a candidate list was capped, rather than capping silently', () => {
    const note = renderNote({
      uaCandidates: [candidate(9)],
      asnCandidates: [],
      truncated: true,
      flaggedViews: 9,
      totalHumanViews: 48,
    });
    expect(note).toContain(`Only the ${SWARM_MAX_CANDIDATES} largest`);
  });

  it('is plain ASCII so it renders in the plain-text email', () => {
    // Every branch, not just the first: the AECI-683 clause was written with an
    // em dash and this assertion, scoped to a UA-only summary, would not have
    // caught it.
    const rotator = {
      cfAsn: 47544,
      asOrganization: 'Example Hosting',
      views: 5,
      distinctUaHashes: 5,
      distinctCountries: 1,
      distinctPaths: 5,
      nonBrowserViews: 5,
      uaRatio: 1,
      pathRatio: 1,
    };
    const verdict = {
      cfAsn: 199737,
      asOrganization: 'Rockion LLC',
      views: 3,
      distinctUaHashes: 1,
      distinctCountries: 1,
      distinctPaths: 3,
    };
    for (const summary of [
      { uaCandidates: [candidate(9)], asnCandidates: [] },
      { uaCandidates: [], asnCandidates: [rotator] },
      { uaCandidates: [candidate(9)], asnCandidates: [rotator] },
      { uaCandidates: [], asnCandidates: [], verdictCandidates: [verdict], verdictFlaggedViews: 3 },
      {
        uaCandidates: [candidate(9)],
        asnCandidates: [rotator],
        verdictCandidates: [verdict],
        verdictFlaggedViews: 3,
      },
    ]) {
      for (const truncated of [false, true]) {
        const note = renderNote({
          ...summary,
          truncated,
          flaggedViews: 9,
          totalHumanViews: 48,
        });
        // eslint-disable-next-line no-control-regex
        expect(note).toMatch(/^[\x00-\x7F]*$/);
      }
    }
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
    // Separate constants even though the values match today: the two groupings
    // have different false-positive profiles and will be tuned apart.
    expect(ASN_ROTATOR_MIN_VIEWS).toBe(4);
    expect(ASN_ROTATOR_MIN_UA_RATIO).toBe(0.8);
    expect(SWARM_MAX_CANDIDATES).toBe(25);
  });

  it('has no threshold at all for the verdict, which is the point of AECI-744', () => {
    // Pinned as data rather than prose: `analytics-digest.ts` is handed this exact
    // vocabulary to build the complement of the flagged predicate, so a value
    // added here without being added there would leak rows back into the tables.
    expect([...NON_BROWSER_VERDICTS]).toEqual(['inconsistent', 'non-browser']);
  });
});

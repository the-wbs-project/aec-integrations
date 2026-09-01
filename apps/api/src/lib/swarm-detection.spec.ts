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
  detectSwarms,
  detectUaHashSwarms,
  isCorroboratedByRequestShape,
  swarmNote,
  SWARM_MAX_CANDIDATES,
  SWARM_MIN_ASN_RATIO,
  SWARM_MIN_VIEWS,
  SWARM_PRIOR_LOOKBACK_DAYS,
  SWARM_PRIOR_MIN_FLAGGED_DAYS,
  SWARM_RECURRING_ASN_RATIO,
  SWARM_RECURRING_MIN_VIEWS,
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

describe('cross-day memory (AECI-742)', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  /** `2026-08-23` shifted by `days`, as the `YYYY-MM-DD` prefix of a timestamp. */
  function dayOffset(days: number): string {
    const d = new Date(DAY_START);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /**
   * `views` rows for one hash on one day, each on its own ASN unless `asns` says
   * otherwise — i.e. the ratio is `asns / views` by construction.
   */
  function dayOfViews(opts: {
    hash: string;
    dayOffset: number;
    views: number;
    asns?: number;
    isBot?: boolean;
    isOperator?: boolean;
  }): (typeof pageViews.$inferInsert)[] {
    const day = dayOffset(opts.dayOffset);
    const asns = opts.asns ?? opts.views;
    return Array.from({ length: opts.views }, (_, i) =>
      view({
        path: `/products/p${i}`,
        concretePath: `/products/p${i}`,
        userAgentHash: opts.hash,
        // Wraps once `i` passes `asns`, so the distinct count is exactly `asns`.
        cfAsn: 30000 + (i % asns),
        cfCountry: 'US',
        isBot: opts.isBot,
        isOperator: opts.isOperator,
        createdAt: `${day}T${String(i).padStart(2, '0')}:30:00.000Z`,
      }),
    );
  }

  /** Flagged history: `days` separate days at full strength, ending before the
   *  reported day. Offsets are negative, so all of it precedes `DAY_START`. */
  function flaggedHistory(hash: string, days: number): (typeof pageViews.$inferInsert)[] {
    return Array.from({ length: days }, (_, i) =>
      dayOfViews({ hash, dayOffset: -(i + 1), views: SWARM_MIN_VIEWS }),
    ).flat();
  }

  it('flags the quiet day a known swarm used to escape on', async () => {
    // The production regression: `53304b2e...` ran every day of 2026-08-21..30,
    // was flagged on 8/29 at ratio 1.00, and escaped on 8/30 at 10 views over 7
    // networks (0.70). Same client, quieter day.
    await t.db
      .insert(pageViews)
      .values([
        ...flaggedHistory('ua-53304b2e', SWARM_PRIOR_MIN_FLAGGED_DAYS),
        ...dayOfViews({ hash: 'ua-53304b2e', dayOffset: 0, views: 10, asns: 7 }),
      ]);

    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.uaCandidates).toHaveLength(1);
    const [candidate] = summary.uaCandidates;
    expect(candidate.userAgentHash).toBe('ua-53304b2e');
    expect(candidate.asnRatio).toBe(0.7);
    expect(candidate.asnRatio).toBeLessThan(SWARM_MIN_ASN_RATIO);
    expect(candidate.priorFlaggedDays).toBe(SWARM_PRIOR_MIN_FLAGGED_DAYS);
    expect(summary.flaggedViews).toBe(10);
  });

  it('leaves the standing bar exactly where it was for a hash with no history', async () => {
    // The same 0.70 day, no prior. Nothing about the per-day test changed.
    await t.db
      .insert(pageViews)
      .values(dayOfViews({ hash: 'ua-newcomer', dayOffset: 0, views: 10, asns: 7 }));

    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.uaCandidates).toEqual([]);
    expect(summary.flaggedViews).toBe(0);
    expect(summary.totalHumanViews).toBe(10);
  });

  it('never builds a prior out of relaxed flags, so the memory cannot ratchet', async () => {
    // Every history day sits at the RELAXED ratio only (4 views / 2 ASNs = 0.5).
    // If the prior were evaluated at the bar it grants, one such day would justify
    // the next and a hash could never get back out. It is evaluated at full
    // strength, so this history is worth nothing.
    await t.db
      .insert(pageViews)
      .values([
        ...Array.from({ length: SWARM_PRIOR_MIN_FLAGGED_DAYS + 2 }, (_, i) =>
          dayOfViews({ hash: 'ua-weak', dayOffset: -(i + 1), views: SWARM_MIN_VIEWS, asns: 2 }),
        ).flat(),
        ...dayOfViews({ hash: 'ua-weak', dayOffset: 0, views: 10, asns: 7 }),
      ]);

    const summary = await detectSwarms(t.db, DAY_START, DAY_END);
    expect(summary.uaCandidates).toEqual([]);
  });

  it('requires the history to repeat, not merely to exist', async () => {
    await t.db
      .insert(pageViews)
      .values([
        ...flaggedHistory('ua-once', SWARM_PRIOR_MIN_FLAGGED_DAYS - 1),
        ...dayOfViews({ hash: 'ua-once', dayOffset: 0, views: 10, asns: 7 }),
      ]);

    expect(await detectUaHashSwarms(t.db, DAY_START, DAY_END)).toEqual([]);
  });

  it('never counts the reported day toward its own prior', async () => {
    // A hash flagged only INSIDE the window must not use that to lower its own
    // bar — the test would be circular. It is still flagged here, on the standing
    // bar alone, so the assertion that matters is `priorFlaggedDays`.
    await t.db
      .insert(pageViews)
      .values(dayOfViews({ hash: 'ua-today-only', dayOffset: 0, views: 9 }));

    const [candidate] = await detectUaHashSwarms(t.db, DAY_START, DAY_END);
    expect(candidate.asnRatio).toBe(1);
    expect(candidate.priorFlaggedDays).toBe(0);
  });

  it('forgets a flagged day that falls outside the lookback', async () => {
    // One day just inside the window and one just outside it. Only the first
    // counts, which leaves the hash one short of a prior.
    await t.db
      .insert(pageViews)
      .values([
        ...dayOfViews({ hash: 'ua-stale', dayOffset: -SWARM_PRIOR_LOOKBACK_DAYS, views: 6 }),
        ...dayOfViews({ hash: 'ua-stale', dayOffset: -(SWARM_PRIOR_LOOKBACK_DAYS + 1), views: 6 }),
        ...dayOfViews({ hash: 'ua-stale', dayOffset: 0, views: 10, asns: 7 }),
      ]);

    expect(await detectUaHashSwarms(t.db, DAY_START, DAY_END)).toEqual([]);
  });

  it('catches a known swarm on a day too quiet for the standing floor', async () => {
    // Two views is below `SWARM_MIN_VIEWS` and would have been invisible. With a
    // fortnight of flagged history behind it, two views on two networks is
    // corroboration rather than coincidence.
    await t.db
      .insert(pageViews)
      .values([
        ...flaggedHistory('ua-quiet', SWARM_PRIOR_MIN_FLAGGED_DAYS),
        ...dayOfViews({ hash: 'ua-quiet', dayOffset: 0, views: SWARM_RECURRING_MIN_VIEWS }),
      ]);

    const [candidate] = await detectUaHashSwarms(t.db, DAY_START, DAY_END);
    expect(candidate.userAgentHash).toBe('ua-quiet');
    expect(candidate.views).toBe(SWARM_RECURRING_MIN_VIEWS);
  });

  it('still needs some spread today: one view is never enough on its own', async () => {
    // A single view is trivially "1 ASN for 1 view". Flagging it would mean the
    // prior alone decided, with no evidence from the day being reported.
    await t.db
      .insert(pageViews)
      .values([
        ...flaggedHistory('ua-single', SWARM_PRIOR_MIN_FLAGGED_DAYS),
        ...dayOfViews({ hash: 'ua-single', dayOffset: 0, views: 1 }),
      ]);

    expect(await detectUaHashSwarms(t.db, DAY_START, DAY_END)).toEqual([]);
  });

  it('a settled hash is forgiven: the bar is lowered, never removed', async () => {
    // Full history, but today it read 10 pages from 2 networks (0.20) — the shape
    // of a person, not a proxy pool. A prior must not be a one-way list.
    await t.db
      .insert(pageViews)
      .values([
        ...flaggedHistory('ua-reformed', SWARM_PRIOR_MIN_FLAGGED_DAYS),
        ...dayOfViews({ hash: 'ua-reformed', dayOffset: 0, views: 10, asns: 2 }),
      ]);

    expect(await detectUaHashSwarms(t.db, DAY_START, DAY_END)).toEqual([]);
  });

  it('builds no prior out of bot or operator history', async () => {
    // The prior reuses the digest's own HUMAN + NOT_INTERNAL predicates, so a
    // population the headline never counted cannot lower anything's bar either.
    await t.db.insert(pageViews).values([
      ...Array.from({ length: SWARM_PRIOR_MIN_FLAGGED_DAYS }, (_, i) =>
        dayOfViews({ hash: 'ua-bot', dayOffset: -(i + 1), views: SWARM_MIN_VIEWS, isBot: true }),
      ).flat(),
      ...Array.from({ length: SWARM_PRIOR_MIN_FLAGGED_DAYS }, (_, i) =>
        dayOfViews({
          hash: 'ua-lapsed',
          dayOffset: -(i + 1),
          views: SWARM_MIN_VIEWS,
          isOperator: true,
        }),
      ).flat(),
      ...dayOfViews({ hash: 'ua-bot', dayOffset: 0, views: 10, asns: 7 }),
      ...dayOfViews({ hash: 'ua-lapsed', dayOffset: 0, views: 10, asns: 7 }),
    ]);

    expect(await detectUaHashSwarms(t.db, DAY_START, DAY_END)).toEqual([]);
  });

  it('says out loud that a lower bar applied, since the day alone cannot show it', async () => {
    await t.db
      .insert(pageViews)
      .values([
        ...flaggedHistory('ua-noted', SWARM_PRIOR_MIN_FLAGGED_DAYS),
        ...dayOfViews({ hash: 'ua-noted', dayOffset: 0, views: 10, asns: 7 }),
      ]);

    const note = swarmNote(await detectSwarms(t.db, DAY_START, DAY_END));
    expect(note).toContain(`already flagged on ${SWARM_PRIOR_MIN_FLAGGED_DAYS}+ of the previous`);
    expect(note).toContain(`${SWARM_PRIOR_LOOKBACK_DAYS} days`);
    // eslint-disable-next-line no-control-regex
    expect(note).toMatch(/^[\x00-\x7F]*$/);
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

describe('swarmNote', () => {
  const candidate = (views: number, priorFlaggedDays = 0): SwarmCandidate => ({
    userAgentHash: 'ua',
    views,
    distinctAsns: views,
    distinctCountries: views,
    distinctPaths: views,
    nonBrowserViews: views,
    asnRatio: 1,
    pathRatio: 1,
    priorFlaggedDays,
  });

  it('is null when nothing was flagged, so the digest stays quiet', () => {
    expect(
      swarmNote({
        uaCandidates: [],
        asnCandidates: [],
        truncated: false,
        flaggedViews: 0,
        totalHumanViews: 40,
      }),
    ).toBeNull();
  });

  it('frames the finding as a proportion of the reported number', () => {
    const note = swarmNote({
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
    const note = swarmNote({
      uaCandidates: [candidate(9)],
      asnCandidates: [],
      truncated: false,
      flaggedViews: 9,
      totalHumanViews: 48,
    });
    expect(note).toContain('1 client');
  });

  it('hedges rather than asserting, because this is a heuristic', () => {
    const note = swarmNote({
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
    const note = swarmNote({
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

    const both = swarmNote({
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

  it('says so when a candidate list was capped, rather than capping silently', () => {
    const note = swarmNote({
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
    for (const summary of [
      { uaCandidates: [candidate(9)], asnCandidates: [] },
      { uaCandidates: [], asnCandidates: [rotator] },
      { uaCandidates: [candidate(9)], asnCandidates: [rotator] },
    ]) {
      for (const truncated of [false, true]) {
        const note = swarmNote({
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
      priorFlaggedDays: 0,
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
    // AECI-742's cross-day memory. The relaxed pair must stay strictly looser
    // than the standing pair and strictly above zero: a bar of 0 would make the
    // prior a one-way list no hash could ever leave.
    expect(SWARM_PRIOR_LOOKBACK_DAYS).toBe(14);
    expect(SWARM_PRIOR_MIN_FLAGGED_DAYS).toBe(2);
    expect(SWARM_RECURRING_ASN_RATIO).toBe(0.5);
    expect(SWARM_RECURRING_MIN_VIEWS).toBe(2);
    expect(SWARM_RECURRING_ASN_RATIO).toBeGreaterThan(0);
    expect(SWARM_RECURRING_ASN_RATIO).toBeLessThan(SWARM_MIN_ASN_RATIO);
    expect(SWARM_RECURRING_MIN_VIEWS).toBeGreaterThan(1);
    expect(SWARM_RECURRING_MIN_VIEWS).toBeLessThan(SWARM_MIN_VIEWS);
  });
});

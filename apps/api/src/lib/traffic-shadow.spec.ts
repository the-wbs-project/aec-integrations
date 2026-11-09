/**
 * Unit tests for the AECI-872 shadow runner core: the SELECT-only guard, label
 * matching, the §3c metric arithmetic, and one load → classify → report pass over
 * the real migrations.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestDb, type TestDb } from '../test/d1';
import { classifyPageView, TRAFFIC_CLASSIFIER_VERSION } from './traffic-classifier';
import {
  assertSelectOnly,
  buildAsnRegistrySql,
  buildClassificationDay,
  buildPageViewChunkSql,
  daysBetween,
  evidenceWindows,
  familyMoves,
  findSharedProxyCandidates,
  loadPulledRows,
  matchLabelledSession,
  parseLabelsFile,
  PULL_COLUMNS,
  readCrawlShapeWindows,
  renderShadowMarkdown,
  runShadow,
  sliceMetrics,
  type PulledPageView,
  type ShadowMeta,
  type ShadowRowOutcome,
} from './traffic-shadow';

describe('assertSelectOnly', () => {
  it('accepts one SELECT, with or without a trailing semicolon', () => {
    expect(assertSelectOnly('SELECT 1')).toBe('SELECT 1');
    expect(assertSelectOnly('  select id from page_views;  ')).toBe('select id from page_views');
  });

  it.each([
    ['a delete', 'DELETE FROM page_views'],
    ['a CTE', 'WITH x AS (SELECT 1) DELETE FROM page_views'],
    ['a second statement', 'SELECT 1; DROP TABLE page_views'],
    ['a write keyword inside a select', 'SELECT * FROM page_views WHERE 1 = (UPDATE x SET y = 1)'],
    ['a pragma', 'PRAGMA table_info(page_views)'],
    ['an insert', 'INSERT INTO page_views (path) VALUES (1)'],
  ])('refuses %s', (_name, statement) => {
    expect(() => assertSelectOnly(statement)).toThrow(/Refusing/);
  });

  it('does not trip on column names that contain a keyword', () => {
    expect(() => assertSelectOnly('SELECT created_at, updated_at FROM t')).not.toThrow();
  });
});

describe('pull SQL', () => {
  it('builds an id-keyed chunk that passes the guard', () => {
    const sql = buildPageViewChunkSql({
      fromIso: '2026-09-13T00:00:00.000Z',
      toIso: '2026-09-14T00:00:00.000Z',
      afterId: 42,
      limit: 500,
    });
    expect(sql).toContain(`SELECT ${PULL_COLUMNS.join(', ')} FROM page_views`);
    expect(sql).toContain('id > 42 ORDER BY id LIMIT 500');
    expect(sql).not.toContain('is_operator = 1');
  });

  it('narrows to operator anchors on request', () => {
    const sql = buildPageViewChunkSql({
      fromIso: '2026-09-13T00:00:00.000Z',
      toIso: '2026-09-14T00:00:00.000Z',
      afterId: 0,
      limit: 1,
      operatorOnly: true,
    });
    expect(sql).toContain('AND is_operator = 1');
  });

  it('refuses a malformed bound rather than interpolating it', () => {
    expect(() =>
      buildPageViewChunkSql({ fromIso: "2026' OR 1=1 --", toIso: 'x', afterId: 0, limit: 1 }),
    ).toThrow(/ISO/);
    expect(() =>
      buildPageViewChunkSql({
        fromIso: '2026-09-13T00:00:00.000Z',
        toIso: '2026-09-14T00:00:00.000Z',
        afterId: -1,
        limit: 1,
      }),
    ).toThrow(/integer/);
  });

  it('reads the registry only for ASNs in the window', () => {
    const sql = buildAsnRegistrySql('2026-09-13T00:00:00.000Z', '2026-09-14T00:00:00.000Z');
    expect(sql).toMatch(/^SELECT asn, info_type/);
    expect(sql).toContain('SELECT DISTINCT cf_asn FROM page_views');
  });
});

describe('windows', () => {
  it('lists days inclusively and refuses a reversed range', () => {
    expect(daysBetween('2026-09-30', '2026-10-02')).toEqual([
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
    expect(() => daysBetween('2026-10-02', '2026-10-01')).toThrow(/after/);
  });

  it('widens the pull for the swarm prior, the SPA margin and the operator retro-join', () => {
    const w = evidenceWindows('2026-09-13', '2026-09-14');
    expect(w.reported).toEqual({
      from: '2026-09-13T00:00:00.000Z',
      to: '2026-09-15T00:00:00.000Z',
    });
    expect(w.rows).toEqual({ from: '2026-08-30T00:00:00.000Z', to: '2026-09-15T00:30:00.000Z' });
    expect(w.operatorAnchors).toEqual({
      from: '2026-07-31T00:00:00.000Z',
      to: '2026-10-15T00:00:00.000Z',
    });
  });
});

describe('labels', () => {
  const session = {
    slice: 'privacy_hardened' as const,
    browser: 'Firefox strict + GPC',
    startUtc: '2026-10-20T08:00:00.000Z',
    endUtc: '2026-10-20T08:10:00.000Z',
    cfAsn: 7713,
  };

  it('parses a labels file and defaults the empty parts', () => {
    expect(parseLabelsFile({})).toEqual({ sessions: [], heldOutDays: [] });
    expect(
      parseLabelsFile({ sessions: [session], heldOutDays: ['2026-10-20'] }).sessions,
    ).toHaveLength(1);
  });

  it('refuses a malformed file or a session that ends before it starts', () => {
    expect(() => parseLabelsFile({ sessions: [{ ...session, slice: 'bot' }] })).toThrow();
    expect(() => parseLabelsFile({ heldOutDays: ['20/10/2026'] })).toThrow();
    expect(() =>
      parseLabelsFile({ sessions: [{ ...session, endUtc: '2026-10-20T07:00:00.000Z' }] }),
    ).toThrow(/ends before/);
  });

  /** A row as the classifier reads it: no privacy signal unless a test says so. */
  function row(createdAt: string, cfAsn: number | null) {
    return { createdAt, cfAsn, concretePath: '/products/procore', privacySignal: false };
  }

  it('matches by window, inclusive, and home ASN', () => {
    expect(matchLabelledSession(row('2026-10-20T08:00:00.000Z', 7713), [session])).toBe(session);
    expect(matchLabelledSession(row('2026-10-20T08:10:00.000Z', 7713), [session])).toBe(session);
    expect(matchLabelledSession(row('2026-10-20T08:10:01.000Z', 7713), [session])).toBeNull();
    expect(matchLabelledSession(row('2026-10-20T07:59:59.000Z', 7713), [session])).toBeNull();
    expect(matchLabelledSession(row('2026-10-20T08:05:00.000Z', 4761), [session])).toBeNull();
    expect(matchLabelledSession(row('2026-10-20T08:05:00.000Z', null), [session])).toBeNull();
  });

  describe('a DNT/GPC row (AECI-1582)', () => {
    const gpc = {
      slice: 'privacy_hardened' as const,
      browser: 'Firefox strict + GPC',
      startUtc: '2026-10-20T08:20:00.000Z',
      endUtc: '2026-10-20T08:30:00.000Z',
      paths: ['/products/procore'],
    };
    const privacyRow = (createdAt: string, concretePath: string | null = '/products/procore') => ({
      createdAt,
      cfAsn: null,
      concretePath,
      privacySignal: true,
    });

    it('matches on its hour-cut time when the window starts mid-hour', () => {
      expect(matchLabelledSession(privacyRow('2026-10-20T08:00:00.000Z'), [gpc])).toBe(gpc);
    });

    it('matches both hours of a window that crosses an hour', () => {
      const crossing = {
        ...gpc,
        startUtc: '2026-10-20T08:55:00.000Z',
        endUtc: '2026-10-20T09:05:00.000Z',
      };
      expect(matchLabelledSession(privacyRow('2026-10-20T08:00:00.000Z'), [crossing])).toBe(
        crossing,
      );
      expect(matchLabelledSession(privacyRow('2026-10-20T09:00:00.000Z'), [crossing])).toBe(
        crossing,
      );
    });

    it('misses another page, another hour, and a row with no path', () => {
      expect(
        matchLabelledSession(privacyRow('2026-10-20T08:00:00.000Z', '/products/other'), [gpc]),
      ).toBeNull();
      expect(matchLabelledSession(privacyRow('2026-10-20T07:00:00.000Z'), [gpc])).toBeNull();
      expect(matchLabelledSession(privacyRow('2026-10-20T09:00:00.000Z'), [gpc])).toBeNull();
      expect(matchLabelledSession(privacyRow('2026-10-20T08:00:00.000Z', null), [gpc])).toBeNull();
    });

    it('never matches a row without the signal on its page alone', () => {
      expect(
        matchLabelledSession({ ...privacyRow('2026-10-20T08:25:00.000Z'), privacySignal: false }, [
          gpc,
        ]),
      ).toBeNull();
      expect(
        matchLabelledSession({ ...privacyRow('2026-10-20T08:25:00.000Z'), privacySignal: null }, [
          gpc,
        ]),
      ).toBeNull();
    });

    it('lets one session match either way, so Brave need not be known in advance', () => {
      const both = { ...gpc, cfAsn: 7713 };
      expect(matchLabelledSession(privacyRow('2026-10-20T08:00:00.000Z'), [both])).toBe(both);
      expect(matchLabelledSession(row('2026-10-20T08:25:00.000Z', 7713), [both])).toBe(both);
      // The network match keeps its exact window: the hour floor is for privacy rows only.
      expect(matchLabelledSession(row('2026-10-20T08:00:00.000Z', 7713), [both])).toBeNull();
    });

    it('refuses a session with neither key, and a path that concrete_path cannot hold', () => {
      const { paths: _paths, ...neither } = gpc;
      expect(() => parseLabelsFile({ sessions: [neither] })).toThrow(/needs a cfAsn, paths/);
      expect(() => parseLabelsFile({ sessions: [{ ...gpc, paths: [] }] })).toThrow();
      expect(() => parseLabelsFile({ sessions: [{ ...gpc, paths: ['products/a'] }] })).toThrow();
      expect(() => parseLabelsFile({ sessions: [{ ...gpc, paths: ['/a?b=1'] }] })).toThrow();
      expect(() => parseLabelsFile({ sessions: [{ ...gpc, paths: ['/a#b'] }] })).toThrow();
    });

    it('refuses two sessions sharing a page in one hour, even with separate windows', () => {
      const later = {
        ...gpc,
        browser: 'Brave',
        startUtc: '2026-10-20T08:40:00.000Z',
        endUtc: '2026-10-20T08:50:00.000Z',
      };
      expect(() => parseLabelsFile({ sessions: [gpc, later] })).toThrow(
        /share \/products\/procore/,
      );
      expect(
        parseLabelsFile({ sessions: [gpc, { ...later, paths: ['/products/other'] }] }).sessions,
      ).toHaveLength(2);
      expect(
        parseLabelsFile({
          sessions: [
            gpc,
            { ...later, startUtc: '2026-10-20T09:00:00.000Z', endUtc: '2026-10-20T09:10:00.000Z' },
          ],
        }).sessions,
      ).toHaveLength(2);
    });
  });
});

describe('sliceMetrics', () => {
  function outcome(o: Partial<ShadowRowOutcome>): ShadowRowOutcome {
    return {
      day: '2026-10-20',
      slice: 'privacy_hardened',
      heldOut: false,
      current: 'HUMAN',
      currentAutomation: false,
      class: 'browser_with_human_evidence',
      baselineClass: 'browser_with_human_evidence',
      internal: false,
      ...o,
    };
  }

  it('counts false exclusions on a human slice, new and current', () => {
    const rows = [
      outcome({
        class: 'suspected_automation',
        current: 'automation_flagged',
        currentAutomation: true,
      }),
      outcome({ class: 'unresolved' }),
      outcome({}),
      outcome({ class: 'identified_automation' }),
    ];
    const m = sliceMetrics(rows, 'privacy_hardened', 'all');
    expect(m.falseExclusions).toEqual({ new: 2, newShare: 0.5, current: 1 });
    expect(m.missedAutomation).toBeNull();
    expect(m.unresolved).toBe(1);
    expect(m.unresolvedShare).toBe(0.25);
  });

  it('counts missed automation on the known-bot slice', () => {
    const rows = [
      outcome({ slice: 'known_bot', class: 'identified_automation', current: 'BOT' }),
      outcome({ slice: 'known_bot', class: 'browser_with_human_evidence', current: 'HUMAN' }),
    ];
    const m = sliceMetrics(rows, 'known_bot', 'all');
    expect(m.missedAutomation).toEqual({ new: 1, newShare: 0.5, current: 1 });
    expect(m.falseExclusions).toBeNull();
  });

  it('partitions held-out days from tuning days and reports an empty slice as n/a', () => {
    const rows = [
      outcome({ heldOut: true }),
      outcome({ heldOut: false }),
      outcome({ heldOut: false }),
    ];
    expect(sliceMetrics(rows, 'privacy_hardened', 'held_out').rows).toBe(1);
    expect(sliceMetrics(rows, 'privacy_hardened', 'tuning').rows).toBe(2);
    expect(sliceMetrics(rows, 'operator', 'all').unresolvedShare).toBeNull();
  });
});

describe('familyMoves', () => {
  const base: ShadowRowOutcome = {
    day: '2026-10-20',
    slice: 'unknown',
    heldOut: false,
    current: 'BOT',
    currentAutomation: true,
    class: 'suspected_automation',
    baselineClass: 'unresolved',
    internal: false,
  };

  it('counts only changed rows, by slice and partition, largest first', () => {
    const moves = familyMoves([
      base,
      { ...base, heldOut: true },
      { ...base, heldOut: true },
      { ...base, class: 'unresolved' },
      { ...base, slice: 'operator', baselineClass: 'browser_with_human_evidence' },
    ]);
    expect(moves.map((m) => [m.slice, m.partition, m.from, m.rows])).toEqual([
      ['unknown', 'held_out', 'unresolved', 2],
      ['operator', 'tuning', 'browser_with_human_evidence', 1],
      ['unknown', 'tuning', 'unresolved', 1],
    ]);
  });
});

describe('findSharedProxyCandidates', () => {
  it('lists an eyeball ASN carrying many UA hashes in one hour, and nothing else', () => {
    const base = { isBot: false, cfAsn: 7713 };
    const rows = [
      ...['a', 'b', 'c', 'd', 'e'].map((h, i) => ({
        ...base,
        id: i + 1,
        userAgentHash: h,
        createdAt: `2026-10-20T08:0${i}:00.000Z`,
      })),
      { ...base, id: 10, userAgentHash: 'f', createdAt: '2026-10-20T09:00:00.000Z' },
      { ...base, id: 11, cfAsn: 16509, userAgentHash: 'g', createdAt: '2026-10-20T08:00:00.000Z' },
    ];
    const classes = new Map([
      [7713, 'eyeball' as const],
      [16509, 'non_eyeball' as const],
    ]);
    const { candidates, rowIds } = findSharedProxyCandidates(rows, classes, 5);
    expect(candidates).toEqual([
      { cfAsn: 7713, hour: '2026-10-20T08', distinctUaHashes: 5, views: 5 },
    ]);
    expect([...rowIds].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('runShadow over the real migrations', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  /** A pulled row exactly as `wrangler d1 execute --json` returns it: 0/1 booleans. */
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

  describe('the privacy slices (AECI-1582)', () => {
    const privacy = {
      user_agent_hash: null,
      cf_asn: null,
      tls_version: null,
      privacy_signal: 1,
    };
    const labels = parseLabelsFile({
      sessions: [
        {
          slice: 'privacy_hardened',
          browser: 'Firefox strict + GPC',
          startUtc: '2026-10-01T10:20:00.000Z',
          endUtc: '2026-10-01T10:30:00.000Z',
          paths: ['/products/quiet-page'],
        },
      ],
    });

    it('labels the session row, and keeps every other privacy row out of the human truth', async () => {
      const at = '2026-10-01T10:00:00.000Z';
      await loadPulledRows(
        t.db,
        [
          pulled({ id: 1, created_at: at, concrete_path: '/products/quiet-page', ...privacy }),
          pulled({ id: 2, created_at: at, concrete_path: '/products/busy-page', ...privacy }),
          pulled({
            id: 3,
            created_at: at,
            concrete_path: '/products/busy-page',
            is_bot: 1,
            bot_name: 'Googlebot',
            ...privacy,
          }),
          pulled({ id: 4, created_at: '2026-10-01T10:25:00.000Z' }),
        ],
        [],
      );

      const result = await runShadow(t.db, {
        fromDay: '2026-10-01',
        toDay: '2026-10-01',
        labels,
      });

      const all = (slice: string) =>
        result.slices.find((s) => s.slice === slice && s.partition === 'all');
      expect(all('privacy_hardened')).toMatchObject({
        rows: 1,
        truth: 'human',
        falseExclusions: { new: 0, current: 0 },
      });
      expect(all('privacy_unlabelled')).toMatchObject({
        rows: 1,
        truth: 'unknown',
        falseExclusions: null,
        missedAutomation: null,
      });
      expect(all('known_bot')?.rows).toBe(1);
      expect(all('unknown')?.rows).toBe(1);
      expect(result.labelledSessions[0]).toMatchObject({ matchedRows: 1, matchedPrivacyRows: 1 });

      const md = renderShadowMarkdown(
        {
          classifierVersion: TRAFFIC_CLASSIFIER_VERSION,
          fingerprint: 'f',
          gitSha: 'g',
          generatedAt: '2026-10-02T00:00:00.000Z',
          target: 't',
          window: { fromDay: '2026-10-01', toDay: '2026-10-01' },
          evidenceWindows: evidenceWindows('2026-10-01', '2026-10-01'),
          pulled: { pageViews: 4, asnRegistry: 0 },
          labelsPath: null,
          heldOutDays: [],
          ruleInputs: {},
        },
        result,
      );
      expect(md).toContain('| Matched rows | Of which privacy rows |');
      expect(md).toContain(
        '| privacy_hardened | Firefox strict + GPC | 2026-10-01T10:20:00.000Z | 2026-10-01T10:30:00.000Z | (none) | 1 | 1 |',
      );
    });
  });

  describe('the crawl-shape and burst families (AECI-1578)', () => {
    const NO_LABELS = { sessions: [], heldOutDays: [] };
    const AWS = {
      is_bot: 1,
      bot_name: 'Datacenter (AWS)',
      cf_asn: 14618,
      user_agent_hash: '7484a43e0000',
    };
    const REGISTRY = [
      {
        asn: 7713,
        info_type: 'Cable/DSL/ISP',
        as_name: 'Telkom',
        source: 'peeringdb',
        fetched_at: '2026-10-01T00:00:00.000Z',
      },
    ];

    it('moves a browser-shaped datacenter crawler to Suspected and reports the client', async () => {
      const crawl = Array.from({ length: 20 }, (_, i) =>
        pulled({
          ...AWS,
          id: i + 1,
          created_at: `2026-10-01T10:${String(i).padStart(2, '0')}:00.000Z`,
          concrete_path: `/products/p${i}`,
        }),
      );
      await loadPulledRows(t.db, crawl, REGISTRY);

      const result = await runShadow(t.db, {
        fromDay: '2026-10-01',
        toDay: '2026-10-01',
        labels: NO_LABELS,
      });

      expect(result.familyMoves).toEqual([
        {
          slice: 'unknown',
          partition: 'tuning',
          from: 'unresolved',
          to: 'suspected_automation',
          rows: 20,
        },
      ]);
      expect(result.newFamilyClients).toHaveLength(1);
      expect(result.newFamilyClients[0]).toMatchObject({
        day: '2026-10-01',
        userAgentHash: '7484a43e0000',
        cfAsn: 14618,
        views: 20,
        crawlShapeViews: 20,
        burstViews: 0,
      });
      expect(result.newFamilyClients[0]?.classCounts.suspected_automation).toBe(20);
    });

    /** One datacenter arrival a day on `paths`, in the days before and on 2026-10-15. */
    function slowCrawl(paths: (i: number) => string) {
      return Array.from({ length: 15 }, (_, i) =>
        pulled({
          ...AWS,
          id: i + 1,
          created_at: `2026-10-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`,
          concrete_path: paths(i),
        }),
      );
    }
    const REPORT_DAY = { fromDay: '2026-10-15', toDay: '2026-10-15', labels: NO_LABELS };

    it('catches a slow crawler across the window, on the reported day only', async () => {
      await loadPulledRows(
        t.db,
        slowCrawl((i) => `/products/p${i}`),
        REGISTRY,
      );

      const result = await runShadow(t.db, REPORT_DAY);

      expect(result.days[0]?.rows).toBe(1);
      expect(result.days[0]?.classCounts.suspected_automation).toBe(1);
      expect(result.crawlReach).toMatchObject({
        population: 1,
        dayOnly: 0,
        trailingOnly: 1,
        both: 0,
        neither: 0,
      });
      expect(result.crawlExclusionPairs).toEqual([
        {
          day: '2026-10-15',
          userAgentHash: '7484a43e0000',
          cfAsn: 14618,
          test: 'trailingOnly',
          dayViews: 1,
          windowArrivals: 15,
          distinctPaths: 15,
          activeDays: 15,
          referredViews: 0,
        },
      ]);
    });

    it('counts true distinct URLs across days, not a sum of per-day counts', async () => {
      await loadPulledRows(
        t.db,
        slowCrawl((i) => `/products/p${i % 5}`),
        REGISTRY,
      );

      const result = await runShadow(t.db, REPORT_DAY);

      expect(result.days[0]?.classCounts.suspected_automation).toBe(0);
      expect(result.crawlReach.neither).toBe(1);
    });

    /**
     * `dayViews` distinct paths on 2026-11-01, then `priorViews` arrivals over the 14
     * days before it. The prior rows repeat `dayViews` paths after their `priorNew` new
     * ones, so the window holds `dayViews + priorNew` distinct paths.
     */
    function crawler(opts: { dayViews: number; priorViews: number; priorNew: number }) {
      const onDay = Array.from({ length: opts.dayViews }, (_, i) =>
        pulled({
          ...AWS,
          id: i + 1,
          created_at: `2026-11-01T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
          concrete_path: `/products/p${i}`,
        }),
      );
      const prior = Array.from({ length: opts.priorViews }, (_, i) =>
        pulled({
          ...AWS,
          id: opts.dayViews + i + 1,
          created_at: `2026-10-${18 + (i % 14)}T10:00:00.000Z`,
          concrete_path:
            i < opts.priorNew ? `/vendors/v${i}` : `/products/p${i % Math.max(opts.dayViews, 1)}`,
        }),
      );
      return { onDay, prior };
    }
    const CRAWL_DAY = { fromDay: '2026-11-01', toDay: '2026-11-01', labels: NO_LABELS };
    const verifiedHop = (id: number, created_at: string) =>
      pulled({
        ...AWS,
        id,
        created_at,
        navigation: 'spa',
        writer_provenance: 'browser-spa',
      });

    it('reaches the 11-01 shape on the day test when the trailing ratio has fallen', async () => {
      const { onDay, prior } = crawler({ dayViews: 606, priorViews: 3747, priorNew: 2700 });
      await loadPulledRows(t.db, [...onDay, ...prior], REGISTRY);

      expect(await readCrawlShapeWindows(t.db, '2026-11-01')).toEqual([
        {
          userAgentHash: '7484a43e0000',
          cfAsn: 14618,
          arrivals: 4353,
          distinctPaths: 3306,
          activeDays: 15,
          dayArrivals: 606,
          dayDistinctPaths: 606,
          verifiedHops: 0,
        },
      ]);

      const result = await runShadow(t.db, CRAWL_DAY);
      expect(result.days[0]?.classCounts.suspected_automation).toBe(606);
      expect(result.crawlReach).toMatchObject({ dayOnly: 606, trailingOnly: 0, both: 0 });
      expect(result.crawlExclusionPairs[0]?.test).toBe('dayOnly');

      const day = await buildClassificationDay(t.db, '2026-11-01');
      const first = day.rows[0];
      if (!first) throw new Error('no rows');
      const classified = classifyPageView(first, day.ctx);
      expect(classified.class).toBe('suspected_automation');
      expect(classified.reasonCodes).toEqual(
        expect.arrayContaining(['asn_datacenter', 'crawl_shape_member']),
      );
    });

    it('reaches a slow crawler on the trailing test: 12 on the day, 144 in the window', async () => {
      const { onDay, prior } = crawler({ dayViews: 12, priorViews: 132, priorNew: 132 });
      await loadPulledRows(t.db, [...onDay, ...prior], REGISTRY);

      const result = await runShadow(t.db, CRAWL_DAY);

      expect(result.days[0]?.classCounts.suspected_automation).toBe(12);
      expect(result.crawlReach).toMatchObject({ dayOnly: 0, trailingOnly: 12, both: 0 });
    });

    it('counts a pair that passes on both spans once, as both', async () => {
      const { onDay, prior } = crawler({ dayViews: 20, priorViews: 20, priorNew: 20 });
      await loadPulledRows(t.db, [...onDay, ...prior], REGISTRY);

      const result = await runShadow(t.db, CRAWL_DAY);

      expect(result.crawlReach).toMatchObject({
        dayOnly: 0,
        trailingOnly: 0,
        both: 20,
        neither: 0,
      });
    });

    it('gives no signal under 15 views on both spans', async () => {
      const { onDay } = crawler({ dayViews: 14, priorViews: 0, priorNew: 0 });
      await loadPulledRows(t.db, onDay, REGISTRY);

      const result = await runShadow(t.db, CRAWL_DAY);

      expect(result.days[0]?.classCounts.suspected_automation).toBe(0);
      expect(result.crawlReach).toMatchObject({ population: 14, neither: 14 });
    });

    it('gives no signal under 80% distinct on both spans', async () => {
      const { onDay } = crawler({ dayViews: 20, priorViews: 0, priorNew: 0 });
      const repeats = onDay.map((v, i) => ({ ...v, concrete_path: `/products/p${i % 10}` }));
      await loadPulledRows(t.db, repeats, REGISTRY);

      const result = await runShadow(t.db, CRAWL_DAY);

      expect(result.days[0]?.classCounts.suspected_automation).toBe(0);
      expect(result.crawlReach).toMatchObject({ population: 20, neither: 20 });
    });

    it('lets a hop in the prior 14 days veto a day-alone pass, and lists the pair', async () => {
      const { onDay, prior } = crawler({ dayViews: 20, priorViews: 100, priorNew: 0 });
      await loadPulledRows(
        t.db,
        [...onDay, ...prior, verifiedHop(900, '2026-10-20T10:30:00.000Z')],
        REGISTRY,
      );

      const result = await runShadow(t.db, CRAWL_DAY);

      expect(result.days[0]?.classCounts.suspected_automation).toBe(0);
      expect(result.crawlReach.neither).toBe(20);
      expect(result.crawlExclusionPairs).toEqual([]);
      expect(result.crawlVetoedPairs).toEqual([
        {
          day: '2026-11-01',
          userAgentHash: '7484a43e0000',
          cfAsn: 14618,
          test: 'dayOnly',
          dayArrivals: 20,
          dayDistinctPaths: 20,
          windowArrivals: 120,
          distinctPaths: 20,
          verifiedHops: 1,
        },
      ]);
    });

    it('reads a hop in the 30-minute margin as a veto, and not one past it', async () => {
      const { onDay } = crawler({ dayViews: 20, priorViews: 0, priorNew: 0 });
      await loadPulledRows(
        t.db,
        [...onDay, verifiedHop(900, '2026-11-02T00:40:00.000Z')],
        REGISTRY,
      );
      expect((await runShadow(t.db, CRAWL_DAY)).days[0]?.classCounts.suspected_automation).toBe(20);

      await loadPulledRows(t.db, [verifiedHop(901, '2026-11-02T00:10:00.000Z')], []);
      expect((await runShadow(t.db, CRAWL_DAY)).days[0]?.classCounts.suspected_automation).toBe(0);
    });

    it('never gives the signal to rows from prior days', async () => {
      const { onDay, prior } = crawler({ dayViews: 20, priorViews: 100, priorNew: 100 });
      await loadPulledRows(t.db, [...onDay, ...prior], REGISTRY);

      const day = await buildClassificationDay(t.db, '2026-11-01');

      expect([...day.ctx.crawlShapeRowIds].sort((a, b) => a - b)).toEqual(onDay.map((v) => v.id));
    });

    it('gives no ids and no veto entry to a window pass with no arrivals on the day', async () => {
      const { prior } = crawler({ dayViews: 0, priorViews: 20, priorNew: 20 });
      await loadPulledRows(
        t.db,
        [...prior, verifiedHop(900, '2026-10-20T10:30:00.000Z')],
        REGISTRY,
      );

      const result = await runShadow(t.db, CRAWL_DAY);

      expect(result.crawlVetoedPairs).toEqual([]);
      expect(result.days[0]?.rows).toBe(0);
    });

    it('exempts the pair when the app ran anywhere in the window', async () => {
      const hop = pulled({
        ...AWS,
        id: 50,
        created_at: '2026-10-03T10:30:00.000Z',
        navigation: 'spa',
        writer_provenance: 'browser-spa',
      });
      await loadPulledRows(t.db, [...slowCrawl((i) => `/products/p${i}`), hop], REGISTRY);

      const result = await runShadow(t.db, REPORT_DAY);

      expect(result.days[0]?.classCounts.suspected_automation).toBe(0);
    });

    it('never looks forward: a later day cannot change an earlier one', async () => {
      await loadPulledRows(
        t.db,
        slowCrawl((i) => `/products/p${i}`),
        REGISTRY,
      );

      const result = await runShadow(t.db, {
        fromDay: '2026-10-14',
        toDay: '2026-10-14',
        labels: NO_LABELS,
      });

      expect(result.days[0]?.classCounts.suspected_automation).toBe(0);
    });

    it('states the window in the evidence bounds a stored row carries', () => {
      expect(evidenceWindows('2026-10-15', '2026-10-15').rows.from).toBe(
        '2026-10-01T00:00:00.000Z',
      );
    });

    it('sees a burst across midnight on the second day, and not the first', async () => {
      const blank = {
        ...AWS,
        user_agent_hash: null,
        bot_name: 'Datacenter (Microsoft)',
        cf_asn: 8075,
        client_verdict: 'unknown',
      };
      const before = Array.from({ length: 10 }, (_, i) =>
        pulled({ ...blank, id: i + 1, created_at: `2026-10-14T23:59:${50 + i}.000Z` }),
      );
      const after = Array.from({ length: 10 }, (_, i) =>
        pulled({ ...blank, id: i + 21, created_at: `2026-10-15T00:00:0${i}.000Z` }),
      );
      await loadPulledRows(t.db, [...before, ...after], REGISTRY);

      const result = await runShadow(t.db, {
        fromDay: '2026-10-14',
        toDay: '2026-10-15',
        labels: NO_LABELS,
      });

      expect(result.days[0]?.classCounts.suspected_automation).toBe(0);
      expect(result.days[1]?.classCounts.suspected_automation).toBe(10);
    });

    it('moves a blank-user-agent burst to Suspected, and only the burst minute', async () => {
      const blank = {
        ...AWS,
        user_agent_hash: null,
        bot_name: 'Datacenter (Microsoft)',
        cf_asn: 8075,
        client_verdict: 'unknown',
      };
      const burst = Array.from({ length: 20 }, (_, i) =>
        pulled({
          ...blank,
          id: i + 1,
          created_at: `2026-10-01T23:26:${String(i).padStart(2, '0')}.000Z`,
        }),
      );
      const later = pulled({ ...blank, id: 21, created_at: '2026-10-01T23:40:00.000Z' });
      await loadPulledRows(t.db, [...burst, later], REGISTRY);

      const result = await runShadow(t.db, {
        fromDay: '2026-10-01',
        toDay: '2026-10-01',
        labels: NO_LABELS,
      });

      expect(result.newFamilyClients).toHaveLength(1);
      expect(result.newFamilyClients[0]).toMatchObject({ userAgentHash: null, burstViews: 20 });
      expect(result.days[0]?.classCounts.suspected_automation).toBe(20);
      expect(result.days[0]?.classCounts.unresolved).toBe(1);
    });

    it('moves nothing for a reader whose app ran', async () => {
      const reader = Array.from({ length: 20 }, (_, i) =>
        pulled({
          id: i + 1,
          created_at: `2026-10-01T10:${String(i).padStart(2, '0')}:00.000Z`,
          concrete_path: `/products/p${i}`,
        }),
      );
      const hop = pulled({
        id: 50,
        created_at: '2026-10-01T10:30:00.000Z',
        navigation: 'spa',
        writer_provenance: 'browser-spa',
      });
      await loadPulledRows(t.db, [...reader, hop], REGISTRY);

      const result = await runShadow(t.db, {
        fromDay: '2026-10-01',
        toDay: '2026-10-01',
        labels: NO_LABELS,
      });

      expect(result.familyMoves).toEqual([]);
      expect(result.newFamilyClients).toEqual([]);
    });

    it('carries privacy_signal through the pull, so the runner agrees with the writer', async () => {
      await loadPulledRows(
        t.db,
        [
          pulled({
            id: 1,
            created_at: '2026-10-01T10:00:00.000Z',
            navigation: 'spa',
            writer_provenance: 'browser-spa',
            user_agent_hash: null,
            cf_asn: null,
            tls_version: null,
            privacy_signal: 1,
          }),
        ],
        [],
      );

      const result = await runShadow(t.db, {
        fromDay: '2026-10-01',
        toDay: '2026-10-01',
        labels: NO_LABELS,
      });

      expect(result.days[0]?.classCounts.browser_with_human_evidence).toBe(0);
      expect(result.reasonCodeCounts.evidence_privacy_signal).toBe(1);
    });

    it('renders both sections', async () => {
      await loadPulledRows(
        t.db,
        Array.from({ length: 20 }, (_, i) =>
          pulled({
            ...AWS,
            id: i + 1,
            created_at: `2026-10-01T10:${String(i).padStart(2, '0')}:00.000Z`,
            concrete_path: `/products/p${i}`,
          }),
        ),
        REGISTRY,
      );
      const result = await runShadow(t.db, {
        fromDay: '2026-10-01',
        toDay: '2026-10-01',
        labels: NO_LABELS,
      });
      const md = renderShadowMarkdown(
        {
          classifierVersion: TRAFFIC_CLASSIFIER_VERSION,
          fingerprint: 'f',
          gitSha: 'g',
          generatedAt: '2026-10-02T00:00:00.000Z',
          target: 't',
          window: { fromDay: '2026-10-01', toDay: '2026-10-01' },
          evidenceWindows: evidenceWindows('2026-10-01', '2026-10-01'),
          pulled: { pageViews: 20, asnRegistry: 1 },
          labelsPath: null,
          heldOutDays: [],
          ruleInputs: {},
        } satisfies ShadowMeta,
        result,
      );
      expect(md).toContain('## Moved by the crawl-shape and burst families');
      expect(md).toContain('| unknown | tuning | unresolved | suspected_automation | 20 |');
      expect(md).toContain('## Clients carrying a new family (top 50 of 1)');
      expect(md).toContain('## Crawl shape: day test beside the trailing test');
      expect(md).toContain('| Total | 20 | 0 | 0 | 20 | 0 |');
      expect(md).toContain('## False-exclusion review');
      expect(md).toContain('| both | 20 | 20 | 20 | 1 | 0 |');
      expect(md).toContain('## Crawl shape: pairs the hop veto stopped (top 50 of 0)');
      expect(md).toContain('`7484a43e`');
    });
  });

  describe('the coordinated-identities candidate (AECI-1659)', () => {
    const NO_LABELS = { sessions: [], heldOutDays: [] };
    const DAY = { fromDay: '2026-10-15', toDay: '2026-10-15', labels: NO_LABELS };
    const SEEDBOX = 214483;

    /**
     * Four identities on one non-datacenter network, starting within seconds, on
     * disjoint pages. `c0` also shows on AWS, `c1` once ran the app on a home
     * network, and `c3` once came from a verified crawler.
     */
    function coordinatedDay(): PulledPageView[] {
      let id = 0;
      const rows: PulledPageView[] = [];
      for (let i = 0; i < 4; i += 1) {
        for (let v = 0; v < 10; v += 1) {
          rows.push(
            pulled({
              id: ++id,
              created_at: `2026-10-15T0${v}:00:0${i}.000Z`,
              cf_asn: SEEDBOX,
              user_agent_hash: `c${i}`,
              concrete_path: `/products/c${i}-${v}`,
            }),
          );
        }
      }
      for (let v = 0; v < 2; v += 1) {
        rows.push(
          pulled({
            id: ++id,
            created_at: `2026-10-15T12:00:0${v}.000Z`,
            cf_asn: 14618,
            is_bot: 1,
            bot_name: 'Datacenter (AWS)',
            user_agent_hash: 'c0',
            concrete_path: `/vendors/aws-${v}`,
          }),
        );
      }
      rows.push(
        pulled({
          id: ++id,
          created_at: '2026-10-15T13:00:00.000Z',
          navigation: 'spa',
          writer_provenance: 'browser-spa',
          user_agent_hash: 'c1',
          concrete_path: '/categories/home',
        }),
        pulled({
          id: ++id,
          created_at: '2026-10-15T14:00:00.000Z',
          cf_asn: SEEDBOX,
          cf_verified_bot_category: 'Search Engine Crawler',
          user_agent_hash: 'c3',
          concrete_path: '/categories/verified',
        }),
      );
      for (let i = 0; i < 20; i += 1) {
        rows.push(
          pulled({
            id: ++id,
            created_at: `2026-10-15T1${i % 10}:30:00.000Z`,
            user_agent_hash: `person${i}`,
            concrete_path: `/products/p${i % 4}`,
          }),
        );
      }
      return rows;
    }

    it('overlays the group without moving any existing count or the digest comparison', async () => {
      await loadPulledRows(t.db, coordinatedDay(), []);
      const result = await runShadow(t.db, DAY);

      expect(result.days[0]?.reproducesDigest).toBe(true);
      // The running classifier is untouched: nothing reaches Suspected without the overlay.
      expect(result.days[0]?.classCounts.suspected_automation).toBe(0);

      const group = result.coordinated.groups.find((g) => g.cfAsn === SEEDBOX);
      expect(group).toMatchObject({
        identities: 4,
        views: 44,
        kind: 'ordinary',
        passes: { start: true, partition: true, share: true },
        coordinated: true,
      });
      expect(result.coordinated.reach).toEqual([
        {
          day: '2026-10-15',
          heldOut: false,
          groups: 1,
          memberRows: 44,
          toSuspected: 2,
          singleSignalOnly: 40,
          humanToUnresolved: 1,
          ordinaryNetworkRows: 44,
          ordinaryNetworkToSuspected: 2,
        },
      ]);
      expect(result.coordinated.secondFamilies).toEqual([{ families: 'network', rows: 2 }]);
    });

    it('never moves an identified row, and sends human evidence to Unresolved, not Suspected', async () => {
      await loadPulledRows(t.db, coordinatedDay(), []);
      const result = await runShadow(t.db, DAY);
      const moves = result.coordinated.moves.map((m) => [m.from, m.to, m.rows]);

      expect(moves).toEqual(
        expect.arrayContaining([
          ['unresolved', 'suspected_automation', 2],
          ['browser_with_human_evidence', 'unresolved', 1],
        ]),
      );
      expect(moves.some(([from]) => from === 'identified_automation')).toBe(false);
      expect(moves.some(([, to]) => to === 'identified_automation')).toBe(false);
    });

    it('renders its sections and the overlay slice table', async () => {
      await loadPulledRows(t.db, coordinatedDay(), []);
      const result = await runShadow(t.db, DAY);
      const md = renderShadowMarkdown(
        {
          classifierVersion: TRAFFIC_CLASSIFIER_VERSION,
          fingerprint: 'f',
          gitSha: 'g',
          generatedAt: 'now',
          target: 'test',
          window: { fromDay: DAY.fromDay, toDay: DAY.toDay },
          evidenceWindows: evidenceWindows(DAY.fromDay, DAY.toDay),
          pulled: { pageViews: 0, asnRegistry: 0 },
          labelsPath: null,
          heldOutDays: [],
          ruleInputs: {},
        },
        result,
      );
      expect(md).toContain('## Coordinated identities candidate (AECI-1659)');
      expect(md).toContain('| 2026-10-15 | no | 214483 | ordinary | 4 | 44 |');
      expect(md).toContain('| 2026-10-15 | 1 | 44 | 2 | 40 | 1 | 44 | 2 |');
      expect(md).toContain('### Slice metrics with the coordinated family (§3c step 3)');
      expect(md).toContain('| network | 2 |');
    });
  });

  it('reproduces the digest headline and sets each row beside it', async () => {
    const operator = pulled({
      id: 5,
      created_at: '2026-10-01T11:00:00.000Z',
      is_operator: 1,
      cf_asn: 4761,
      user_agent_hash: 'ua-op',
    });
    const loaded = await loadPulledRows(
      t.db,
      [
        pulled({
          id: 1,
          created_at: '2026-10-01T09:00:00.000Z',
          is_bot: 1,
          bot_name: 'Googlebot',
          cf_asn: 15169,
        }),
        pulled({ id: 2, created_at: '2026-10-01T10:00:00.000Z', referrer_source: 'Google' }),
        pulled({
          id: 3,
          created_at: '2026-10-01T10:05:00.000Z',
          navigation: 'spa',
          writer_provenance: 'browser-spa',
        }),
        pulled({
          id: 4,
          created_at: '2026-10-01T10:10:00.000Z',
          client_verdict: 'non-browser',
          user_agent_hash: 'ua-cli',
        }),
        operator,
        operator, // the operator-anchor pull overlaps the row pull
        pulled({
          id: 6,
          created_at: '2026-10-01T12:00:00.000Z',
          is_bot: 1,
          bot_name: 'Datacenter (AWS)',
          cf_asn: 16509,
          client_verdict: 'inconsistent',
        }),
        pulled({
          id: 7,
          created_at: '2026-10-01T13:00:00.000Z',
          cf_asn: null,
          user_agent_hash: 'ua-blind',
        }),
        pulled({ id: 8, created_at: '2026-10-02T00:00:00.000Z' }), // outside the reported day
      ],
      [
        {
          asn: 7713,
          info_type: 'Cable/DSL/ISP',
          as_name: 'Telkom',
          source: 'peeringdb',
          fetched_at: '2026-10-01T00:00:00.000Z',
        },
        {
          asn: 16509,
          info_type: 'Content',
          as_name: 'Amazon',
          source: 'peeringdb',
          fetched_at: '2026-10-01T00:00:00.000Z',
        },
      ],
    );
    expect(loaded).toEqual({ pageViews: 8, asnRegistry: 2 });

    const result = await runShadow(t.db, {
      fromDay: '2026-10-01',
      toDay: '2026-10-01',
      labels: parseLabelsFile({
        sessions: [
          {
            slice: 'operator',
            browser: 'Chrome, signed in',
            startUtc: '2026-10-01T10:55:00.000Z',
            endUtc: '2026-10-01T11:10:00.000Z',
            cfAsn: 4761,
          },
        ],
        heldOutDays: ['2026-10-01'],
      }),
    });

    const [day] = result.days;
    expect(day).toMatchObject({
      day: '2026-10-01',
      rows: 7,
      internal: 1,
      evidenceIncomplete: 1,
      digest: { humanRaw: 4, flagged: 1, humanAfterAutomation: 3 },
      currentCounts: { internal: 1, BOT: 2, automation_flagged: 1, HUMAN: 3 },
      reproducesDigest: true,
      degraded: true, // 5 of 6 arrivals carry an ASN: 83% < 95%
    });
    expect(day?.classCounts).toEqual({
      identified_automation: 1,
      suspected_automation: 1,
      browser_with_human_evidence: 2,
      unresolved: 3,
    });
    // Unresolved among non-internal rows: the verdict-only row and the blind arrival.
    expect(day?.unresolved).toBe(2);
    expect(day?.unresolvedShare).toBeCloseTo(2 / 6, 4);

    expect(result.confusion.automation_flagged.unresolved).toBe(1);
    expect(result.confusion.BOT).toMatchObject({
      identified_automation: 1,
      suspected_automation: 1,
    });
    expect(result.confusion.HUMAN).toMatchObject({ browser_with_human_evidence: 2, unresolved: 1 });

    const operatorHeldOut = result.slices.find(
      (s) => s.slice === 'operator' && s.partition === 'held_out',
    );
    expect(operatorHeldOut).toMatchObject({ rows: 1, falseExclusions: { new: 0, current: 0 } });
    expect(result.labelledSessions[0]?.matchedRows).toBe(1);
    const knownBots = result.slices.find((s) => s.slice === 'known_bot' && s.partition === 'all');
    expect(knownBots).toMatchObject({ rows: 1, missedAutomation: { new: 0, current: 0 } });

    expect(result.reasonCodeCounts.spa_followup).toBe(1);
    expect(result.reasonCodeCounts.search_referred).toBe(1);
    expect(result.reasonCodeCounts.evidence_no_asn).toBe(1);

    const meta: ShadowMeta = {
      classifierVersion: TRAFFIC_CLASSIFIER_VERSION,
      fingerprint: 'f'.repeat(64),
      gitSha: 'abc',
      generatedAt: '2026-10-14T00:00:00.000Z',
      target: 'test',
      window: { fromDay: '2026-10-01', toDay: '2026-10-01' },
      evidenceWindows: evidenceWindows('2026-10-01', '2026-10-01'),
      pulled: loaded,
      labelsPath: null,
      heldOutDays: ['2026-10-01'],
      ruleInputs: {},
    };
    const md = renderShadowMarkdown(meta, result);
    expect(md).toContain(`\`${TRAFFIC_CLASSIFIER_VERSION}\``);
    expect(md).toContain('| 2026-10-01 | 7 | 1 | 1 | 2 | 3 | 1 |');
    expect(md).toContain('Report-only.');
  });
});

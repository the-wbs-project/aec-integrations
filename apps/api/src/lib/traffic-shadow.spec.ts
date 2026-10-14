/**
 * Unit tests for the AECI-872 shadow runner core: the SELECT-only guard, label
 * matching, the §3c metric arithmetic, and one load → classify → report pass over
 * the real migrations.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestDb, type TestDb } from '../test/d1';
import { TRAFFIC_CLASSIFIER_VERSION } from './traffic-classifier';
import {
  assertSelectOnly,
  buildAsnRegistrySql,
  buildPageViewChunkSql,
  daysBetween,
  evidenceWindows,
  findSharedProxyCandidates,
  loadPulledRows,
  matchLabelledSession,
  parseLabelsFile,
  PULL_COLUMNS,
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

  it('matches by window, inclusive, and home ASN', () => {
    expect(
      matchLabelledSession({ createdAt: '2026-10-20T08:00:00.000Z', cfAsn: 7713 }, [session]),
    ).toBe(session);
    expect(
      matchLabelledSession({ createdAt: '2026-10-20T08:10:00.000Z', cfAsn: 7713 }, [session]),
    ).toBe(session);
    expect(
      matchLabelledSession({ createdAt: '2026-10-20T08:10:01.000Z', cfAsn: 7713 }, [session]),
    ).toBeNull();
    expect(
      matchLabelledSession({ createdAt: '2026-10-20T08:05:00.000Z', cfAsn: 4761 }, [session]),
    ).toBeNull();
    expect(
      matchLabelledSession({ createdAt: '2026-10-20T08:05:00.000Z', cfAsn: null }, [session]),
    ).toBeNull();
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

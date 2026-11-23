/**
 * Pure specs for the AECI-1716 browser-report candidates: the two detectors, the
 * override, the collector's tables, and the `--exclude-ids` parser.
 */

import { describe, expect, it } from 'vitest';

import { BROWSER_EVIDENCE_WINDOW_MS } from '../routes/page-views';
import {
  classifyPageView,
  type ClassifierContext,
  type ClassifierRow,
  type PageViewClassification,
} from './traffic-classifier';
import {
  BROWSER_REPORT_SETTLE_MINUTES,
  BrowserEvidenceCollector,
  browserEvidenceState,
  INTERACTED_OVERRIDES_FAMILIES,
  INTERACTED_OVERRIDES_WITHOUT_NETWORK,
  INTERACTED_RULE_SEAM_DAY,
  interactedClass,
  interactedClassWithoutNetworkDrop,
  interactedHeldAsKnownBot,
  interactedRuleFor,
  noBrowserReportClass,
  parseIdRanges,
  renderBrowserEvidenceMarkdown,
  type BrowserEvidenceRow,
} from './traffic-shadow-browser-evidence';

const READ_AT = '2026-12-01T12:00:00.000Z';
const READ_AT_MS = Date.parse(READ_AT);
const CAPTURE_FROM = '2026-11-01T00:00:00.000Z';
const OPTS = { readAtMs: READ_AT_MS, captureFromMs: Date.parse(CAPTURE_FROM) };
const SETTLED_AT = '2026-12-01T10:00:00.000Z';

function classifierRow(overrides: Partial<ClassifierRow> = {}): ClassifierRow {
  return {
    id: 1,
    createdAt: SETTLED_AT,
    concretePath: '/products/procore',
    navigation: 'arrival',
    writerProvenance: 'ssr-arrival',
    clientVerdict: 'browser',
    isBot: false,
    botName: null,
    cfAsn: 7922,
    cfVerifiedBot: null,
    cfVerifiedBotCategory: null,
    hasSecChUa: true,
    hasAcceptLanguage: true,
    secFetchDest: 'document',
    tlsVersion: 'TLSv1.3',
    referrerSource: 'Direct',
    isOperator: false,
    userAgentHash: 'ua-visitor',
    privacySignal: false,
    ...overrides,
  };
}

function row(
  overrides: Partial<ClassifierRow> &
    Partial<Pick<BrowserEvidenceRow, 'cfCountry' | 'browserEvidence'>> = {},
): ClassifierRow & Pick<BrowserEvidenceRow, 'cfCountry' | 'browserEvidence'> {
  return { cfCountry: 'US', browserEvidence: null, ...classifierRow(overrides), ...overrides };
}

function ctx(overrides: Partial<ClassifierContext> = {}): ClassifierContext {
  return {
    swarmUaHashes: new Set(),
    rotatorAsns: new Set(),
    networkClassByAsn: new Map([[7922, 'eyeball']]),
    internalRowIds: new Set(),
    spaFollowupRowIds: new Set(),
    crawlShapeRowIds: new Set(),
    burstRowIds: new Set(),
    ...overrides,
  };
}

/** A pair crawl-shape row: one hash-level family, so the classifier leaves it Unresolved. */
const CRAWL = ctx({ crawlShapeRowIds: new Set([1]) });

/** An ASN `asn_registry` calls non-eyeball and `DATACENTER_ASNS` does not list: no `is_bot`. */
const NON_EYEBALL_ASN = 64512;
const NON_EYEBALL = ctx({ networkClassByAsn: new Map([[NON_EYEBALL_ASN, 'non_eyeball']]) });

/** What ingest stores for any row on a `DATACENTER_ASNS` network (`classifyTraffic`). */
const ASN_RULE_BOT = { cfAsn: 14618, isBot: true, botName: 'Datacenter (AWS)' } as const;

describe('the settle time', () => {
  it('is no shorter than the endpoint window, so a settled row can no longer change', () => {
    expect(BROWSER_REPORT_SETTLE_MINUTES * 60_000).toBeGreaterThanOrEqual(
      BROWSER_EVIDENCE_WINDOW_MS,
    );
  });
});

describe('browserEvidenceState: no_browser_report', () => {
  it('marks a settled, captured, browser-verdict arrival with no report', () => {
    expect(browserEvidenceState(row(), OPTS)).toBe('no_browser_report');
  });

  it('never marks a privacy-signal row: it is not collected', () => {
    const privacy = row({ privacySignal: true, cfAsn: null, userAgentHash: null });
    expect(browserEvidenceState(privacy, OPTS)).toBe('not_collected_privacy');
  });

  it.each([
    ['an EEA country', 'DE'],
    ['the UK', 'GB'],
    ['Switzerland', 'CH'],
    ['an unknown country', null],
  ])('never marks a held-region row: %s', (_name, cfCountry) => {
    expect(browserEvidenceState(row({ cfCountry }), OPTS)).toBe('not_collected_held_region');
  });

  it('never marks an errored page: only the gateway writes an arrival, and only for 200 HTML', () => {
    // A 404 or 5xx writes no row at all. A row with no trusted writer is the closest
    // stored shape, and it is never a candidate.
    expect(browserEvidenceState(row({ writerProvenance: null }), OPTS)).toBe('not_arrival');
    expect(browserEvidenceState(row({ writerProvenance: 'browser-spa' }), OPTS)).toBe(
      'not_arrival',
    );
  });

  it('leaves a row under the settle time in flight', () => {
    const young = new Date(READ_AT_MS - (BROWSER_REPORT_SETTLE_MINUTES * 60_000 - 1)).toISOString();
    expect(browserEvidenceState(row({ createdAt: young }), OPTS)).toBe('in_flight');
    const settled = new Date(READ_AT_MS - BROWSER_REPORT_SETTLE_MINUTES * 60_000).toISOString();
    expect(browserEvidenceState(row({ createdAt: settled }), OPTS)).toBe('no_browser_report');
  });

  it('reads a row written before capture as capture off, never as no report', () => {
    const before = row({ createdAt: '2026-10-31T23:59:59.999Z' });
    expect(browserEvidenceState(before, OPTS)).toBe('capture_off');
    expect(browserEvidenceState(row(), { readAtMs: READ_AT_MS, captureFromMs: null })).toBe(
      'capture_off',
    );
  });

  it('skips a known bot and a non-browser verdict', () => {
    expect(browserEvidenceState(row({ isBot: true, botName: 'Googlebot' }), OPTS)).toBe(
      'known_bot',
    );
    expect(browserEvidenceState(row({ clientVerdict: 'inconsistent' }), OPTS)).toBe(
      'verdict_not_browser',
    );
    expect(browserEvidenceState(row({ clientVerdict: null }), OPTS)).toBe('verdict_not_browser');
  });

  it('reads a report that arrived', () => {
    expect(browserEvidenceState(row({ browserEvidence: 'ran' }), OPTS)).toBe('ran');
    expect(browserEvidenceState(row({ browserEvidence: 'interacted' }), OPTS)).toBe('interacted');
  });
});

describe('noBrowserReportClass', () => {
  it('is one family: alone it stays Unresolved', () => {
    const result = classifyPageView(classifierRow(), ctx());
    expect(result.class).toBe('unresolved');
    expect(noBrowserReportClass('no_browser_report', result)).toBe('unresolved');
  });

  it('reaches Suspected with a second family', () => {
    const result = classifyPageView(classifierRow(), CRAWL);
    expect(result.reasonCodes).toContain('single_signal_crawl_shape');
    expect(noBrowserReportClass('no_browser_report', result)).toBe('suspected_automation');
  });

  it('does nothing on a not-collected or in-flight row', () => {
    const result = classifyPageView(classifierRow(), CRAWL);
    for (const state of [
      'not_collected_privacy',
      'not_collected_held_region',
      'in_flight',
    ] as const) {
      expect(noBrowserReportClass(state, result)).toBe('unresolved');
    }
  });
});

describe('interactedClass: the human override', () => {
  it('outweighs crawl shape', () => {
    const r = row({ browserEvidence: 'interacted' });
    const result = classifyPageView(r, CRAWL);
    expect(result.class).toBe('unresolved');
    expect(interactedClass(r, result)).toBe('browser_with_human_evidence');
  });

  it('outweighs a pairing of overridable hash-level families that reached Suspected', () => {
    const r = row({ browserEvidence: 'interacted' });
    const result = classifyPageView(
      r,
      ctx({ crawlShapeRowIds: new Set([1]), swarmUaHashes: new Set(['ua-visitor']) }),
    );
    expect(result.class).toBe('suspected_automation');
    expect(interactedClass(r, result)).toBe('browser_with_human_evidence');
  });

  it('never lets `ran` count as human evidence, crawl shape or not', () => {
    const r = row({ browserEvidence: 'ran' });
    const result = classifyPageView(r, CRAWL);
    expect(interactedClass(r, result)).toBe('unresolved');
    const plain = classifyPageView(r, ctx());
    expect(interactedClass(r, plain)).toBe('unresolved');
  });

  it('does not outweigh a known bot user agent', () => {
    const r = row({ browserEvidence: 'interacted', isBot: true, botName: 'Googlebot' });
    const result = classifyPageView(r, ctx());
    expect(result.class).toBe('identified_automation');
    expect(interactedClass(r, result)).toBe('identified_automation');
  });

  it('does not outweigh a stored is_bot the ASN rule wrote, network family or not', () => {
    const r = row({ browserEvidence: 'interacted', ...ASN_RULE_BOT });
    const result = classifyPageView(r, ctx());
    expect(result.reasonCodes).toContain('asn_datacenter');
    expect(result.class).toBe('unresolved');
    expect(interactedClass(r, result)).toBe('unresolved');
    expect(interactedHeldAsKnownBot(r, result)).toBe(true);
    // With a second family it stays Suspected: the known bot is never read.
    const suspected = classifyPageView(r, ctx({ crawlShapeRowIds: new Set([1]) }));
    expect(suspected.class).toBe('suspected_automation');
    expect(interactedClass(r, suspected)).toBe('suspected_automation');
  });

  it('outweighs a network family alone (2026-11-22 ruling)', () => {
    const r = row({ browserEvidence: 'interacted', cfAsn: NON_EYEBALL_ASN });
    const result = classifyPageView(r, NON_EYEBALL);
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(['asn_non_eyeball', 'single_signal_network']),
    );
    expect(interactedClass(r, result)).toBe('browser_with_human_evidence');
    // Before the ruling the network family stood.
    expect(interactedClassWithoutNetworkDrop(r, result)).toBe('unresolved');
  });

  it('outweighs a datacenter code on a row the ASN rule did not mark', () => {
    // A row written before its ASN joined DATACENTER_ASNS keeps `is_bot = 0`.
    const r = row({ browserEvidence: 'interacted', cfAsn: 14618, isBot: false, botName: null });
    const result = classifyPageView(r, ctx());
    expect(result.reasonCodes).toContain('asn_datacenter');
    expect(interactedClass(r, result)).toBe('browser_with_human_evidence');
  });

  it('outweighs a network family with crawl shape', () => {
    const r = row({ browserEvidence: 'interacted', cfAsn: NON_EYEBALL_ASN });
    const result = classifyPageView(r, ctx({ ...NON_EYEBALL, crawlShapeRowIds: new Set([1]) }));
    expect(result.class).toBe('suspected_automation');
    expect(interactedClass(r, result)).toBe('browser_with_human_evidence');
    expect(interactedClassWithoutNetworkDrop(r, result)).toBe('unresolved');
  });

  it('leaves request shape standing beside a network family: one family left, unresolved', () => {
    const r = row({
      browserEvidence: 'interacted',
      cfAsn: NON_EYEBALL_ASN,
      clientVerdict: 'non-browser',
    });
    const result = classifyPageView(r, NON_EYEBALL);
    expect(result.class).toBe('suspected_automation');
    expect(interactedClass(r, result)).toBe('unresolved');
  });

  it('leaves a request-shape family standing', () => {
    const r = row({ browserEvidence: 'interacted', clientVerdict: 'inconsistent' });
    const result = classifyPageView(r, CRAWL);
    expect(result.class).toBe('suspected_automation');
    expect(interactedClass(r, result)).toBe('unresolved');
  });

  describe('burst stands (2026-11-23 ruling)', () => {
    const BURST = { burstRowIds: new Set([1]) };

    it('leaves burst alone: one family left, unresolved', () => {
      const r = row({ browserEvidence: 'interacted' });
      const result = classifyPageView(r, ctx(BURST));
      expect(result.reasonCodes).toContain('single_signal_burst');
      expect(result.class).toBe('unresolved');
      expect(interactedClass(r, result)).toBe('unresolved');
    });

    it('drops crawl shape beside a burst: one family left, unresolved', () => {
      const r = row({ browserEvidence: 'interacted' });
      const result = classifyPageView(r, ctx({ ...BURST, crawlShapeRowIds: new Set([1]) }));
      expect(result.class).toBe('suspected_automation');
      expect(interactedClass(r, result)).toBe('unresolved');
    });

    it('keeps a burst with request shape in Suspected: two families stand', () => {
      const r = row({ browserEvidence: 'interacted', clientVerdict: 'inconsistent' });
      const result = classifyPageView(r, ctx(BURST));
      expect(result.class).toBe('suspected_automation');
      expect(interactedClass(r, result)).toBe('suspected_automation');
    });

    it('drops a network family beside a burst, and the network drop changes nothing', () => {
      const r = row({ browserEvidence: 'interacted', cfAsn: NON_EYEBALL_ASN });
      const result = classifyPageView(r, ctx({ ...NON_EYEBALL, ...BURST }));
      expect(result.class).toBe('suspected_automation');
      expect(interactedClass(r, result)).toBe('unresolved');
      // Without the network drop two families stand, so the drop moved this row.
      expect(interactedClassWithoutNetworkDrop(r, result)).toBe('suspected_automation');
    });

    it('counts a burst row in the forgery check and never rescues it', () => {
      const c = new BrowserEvidenceCollector(
        { readAt: READ_AT, captureFrom: CAPTURE_FROM, captureFromSource: 'input', excludeIds: [] },
        false,
      );
      c.addDay('2026-12-01', false, new Map([[7922, 'eyeball']]));
      const r = row({ browserEvidence: 'interacted' });
      const result = classifyPageView(r, ctx(BURST));
      const out = c.addRow({
        row: r,
        turnstileVerdict: null,
        result,
        session: null,
        coordinatedMember: false,
        spaFollowup: false,
      });
      expect(out.interacted).toBe('unresolved');
      const report = c.finish();
      expect(report.interactedWithAutomation).toEqual([
        expect.objectContaining({ families: 'burst', rows: 1, rescued: 0 }),
      ]);
      expect(report.moves.filter((m) => m.signal === 'interacted')).toEqual([]);
    });
  });

  it('overrides exactly swarm, rotator, crawl shape, coordinated identities and network', () => {
    expect([...INTERACTED_OVERRIDES_FAMILIES].sort()).toEqual(
      ['coordinated_identities', 'crawl_shape', 'network', 'rotator', 'swarm'].sort(),
    );
    expect(INTERACTED_OVERRIDES_FAMILIES).not.toContain('request_shape');
    expect(INTERACTED_OVERRIDES_FAMILIES).not.toContain('burst');
  });

  it('compares against the same set less network, so the network drop is the only difference', () => {
    expect([...INTERACTED_OVERRIDES_WITHOUT_NETWORK, 'network'].sort()).toEqual(
      [...INTERACTED_OVERRIDES_FAMILIES].sort(),
    );
    expect(INTERACTED_OVERRIDES_WITHOUT_NETWORK).not.toContain('network');
  });

  it('never reads a not-collected row, even one carrying a value', () => {
    const r = row({ browserEvidence: 'interacted', cfCountry: 'FR' });
    const result = classifyPageView(r, ctx());
    expect(interactedClass(r, result)).toBe(result.class);
  });
});

describe('interactedRuleFor', () => {
  it('splits the share at the AECI-1987/1988 deploy day', () => {
    expect(interactedRuleFor('2026-11-19')).toBe('before');
    expect(interactedRuleFor(INTERACTED_RULE_SEAM_DAY)).toBe('seam_day');
    expect(interactedRuleFor('2026-11-21')).toBe('after');
  });
});

describe('parseIdRanges', () => {
  it('reads ids and inclusive ranges', () => {
    expect(parseIdRanges('492-537, 412937-412951,7')).toEqual([
      { from: 492, to: 537 },
      { from: 412937, to: 412951 },
      { from: 7, to: 7 },
    ]);
  });

  it.each(['1-', 'a', '10-2', '1;2'])('refuses %s', (spec) => {
    expect(() => parseIdRanges(spec)).toThrow(/--exclude-ids/);
  });
});

describe('BrowserEvidenceCollector', () => {
  function collect(
    inputs: Array<{
      r: ReturnType<typeof row>;
      c?: ClassifierContext;
      turnstileVerdict?: string | null;
      coordinatedMember?: boolean;
      session?: string | null;
      spaFollowup?: boolean;
    }>,
    opts: { excludeIds?: { from: number; to: number }[]; sessions?: boolean } = {},
  ) {
    const collector = new BrowserEvidenceCollector(
      {
        readAt: READ_AT,
        captureFrom: CAPTURE_FROM,
        captureFromSource: 'input',
        excludeIds: opts.excludeIds ?? [],
      },
      opts.sessions ?? false,
    );
    collector.addDay('2026-12-01', false, new Map([[7922, 'eyeball']]));
    const classes: { excluded: boolean; interacted: string; noBrowserReport: string }[] = [];
    for (const i of inputs) {
      const result: PageViewClassification = classifyPageView(i.r, i.c ?? ctx());
      classes.push(
        collector.addRow({
          row: i.r,
          result,
          turnstileVerdict: i.turnstileVerdict ?? null,
          coordinatedMember: i.coordinatedMember ?? false,
          session: i.session ?? null,
          spaFollowup: i.spaFollowup ?? false,
        }),
      );
    }
    return { report: collector.finish(), classes };
  }

  it('counts the blocker loss over Turnstile-pass arrivals that could report', () => {
    const { report } = collect([
      { r: row({ id: 1 }), turnstileVerdict: 'pass' },
      { r: row({ id: 2, browserEvidence: 'ran' }), turnstileVerdict: 'pass' },
      { r: row({ id: 3, cfCountry: 'DE' }), turnstileVerdict: 'pass' },
      { r: row({ id: 4, createdAt: '2026-10-01T00:00:00.000Z' }), turnstileVerdict: 'pass' },
    ]);
    expect(report.days[0]).toMatchObject({ turnstilePass: 2, turnstilePassNoReport: 1 });
    expect(report.days[0]?.arrivals).toMatchObject({
      no_browser_report: 1,
      ran: 1,
      not_collected_held_region: 1,
      capture_off: 1,
    });
  });

  it('counts a missing report whose client made a verified hop as lost', () => {
    const { report } = collect([{ r: row({ id: 1 }), spaFollowup: true }, { r: row({ id: 2 }) }]);
    expect(report.days[0]).toMatchObject({ noReportWithHop: 1 });
    expect(report.days[0]?.arrivals.no_browser_report).toBe(2);
  });

  it('counts coordinated members that pair with the missing report', () => {
    const { report } = collect([
      { r: row({ id: 1 }), coordinatedMember: true },
      { r: row({ id: 2, browserEvidence: 'interacted' }), coordinatedMember: true },
    ]);
    expect(report.coordinated[0]).toMatchObject({
      memberRows: 2,
      withNoReport: 1,
      toSuspected: 1,
      onlyPartner: 1,
      interacted: 1,
    });
  });

  it('lists an interacted row carrying crawl shape in the forgery check, by network', () => {
    const { report, classes } = collect([
      { r: row({ id: 1, browserEvidence: 'interacted' }), c: CRAWL },
    ]);
    expect(classes[0]?.interacted).toBe('browser_with_human_evidence');
    expect(report.interactedWithAutomation).toEqual([
      {
        cfAsn: 7922,
        kind: 'ordinary',
        families: 'crawl_shape',
        rows: 1,
        rescued: 1,
        rescuedByNetworkDrop: 0,
        heldKnownBot: 0,
      },
    ]);
    expect(report.moves).toContainEqual({
      signal: 'interacted',
      cfAsn: 7922,
      kind: 'ordinary',
      from: 'unresolved',
      to: 'browser_with_human_evidence',
      rows: 1,
      byNetworkDrop: 0,
    });
  });

  it('keeps network-family rows in the forgery check and splits out the network drop', () => {
    const nonEyeball = ctx({ networkClassByAsn: new Map([[NON_EYEBALL_ASN, 'non_eyeball']]) });
    const { report, classes } = collect([
      // Network only: rescued by the network drop alone.
      { r: row({ id: 1, browserEvidence: 'interacted', cfAsn: NON_EYEBALL_ASN }), c: nonEyeball },
      // Crawl shape only: rescued without it.
      {
        r: row({ id: 2, browserEvidence: 'interacted' }),
        c: ctx({ crawlShapeRowIds: new Set([2]) }),
      },
      // A DATACENTER_ASNS row the ASN rule marked: listed, held, never rescued.
      { r: row({ id: 3, browserEvidence: 'interacted', ...ASN_RULE_BOT }) },
    ]);
    expect(classes.map((c) => c.interacted)).toEqual([
      'browser_with_human_evidence',
      'browser_with_human_evidence',
      'unresolved',
    ]);
    expect(report.interactedWithAutomation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cfAsn: NON_EYEBALL_ASN,
          families: 'network',
          rescued: 1,
          rescuedByNetworkDrop: 1,
          heldKnownBot: 0,
        }),
        expect.objectContaining({ cfAsn: 7922, rescued: 1, rescuedByNetworkDrop: 0 }),
        expect.objectContaining({
          cfAsn: 14618,
          families: 'network',
          rows: 1,
          rescued: 0,
          rescuedByNetworkDrop: 0,
          heldKnownBot: 1,
        }),
      ]),
    );
    const moves = report.moves.filter((m) => m.signal === 'interacted');
    expect(moves).toContainEqual(
      expect.objectContaining({ cfAsn: NON_EYEBALL_ASN, rows: 1, byNetworkDrop: 1 }),
    );
    expect(moves).toContainEqual(expect.objectContaining({ cfAsn: 7922, byNetworkDrop: 0 }));
    expect(moves.some((m) => m.cfAsn === 14618)).toBe(false);
    const md = renderBrowserEvidenceMarkdown(report).join('\n');
    expect(md).toContain('| By the network drop |');
    expect(md).toContain('| Network drop only | Held: known bot |');
  });

  it('leaves excluded ids out of every browser-report table', () => {
    const { report, classes } = collect([{ r: row({ id: 500 }), c: CRAWL }], {
      excludeIds: [{ from: 492, to: 537 }],
    });
    expect(classes[0]).toMatchObject({ excluded: true, noBrowserReport: 'unresolved' });
    expect(report.days[0]?.excluded).toBe(1);
    expect(report.days[0]?.arrivals.no_browser_report).toBe(0);
    expect(report.moves).toEqual([]);
  });

  it('computes the operator share and says when no labelled session was supplied', () => {
    const { report } = collect([
      { r: row({ id: 1, isOperator: true, browserEvidence: 'interacted' }) },
      { r: row({ id: 2, isOperator: true, browserEvidence: 'ran' }) },
      { r: row({ id: 3, isOperator: true, privacySignal: true }) },
    ]);
    expect(report.operatorShare).toEqual([
      {
        group: 'operator rows',
        rule: 'after',
        writer: 'arrival',
        rows: 2,
        interacted: 1,
        ran: 1,
        none: 0,
        notCollected: 1,
      },
    ]);
    expect(report.labelledShare).toBeNull();
    const md = renderBrowserEvidenceMarkdown(report).join('\n');
    expect(md).toContain('Labelled sessions: none supplied.');
    expect(md).toContain('### Blocker loss: Turnstile-pass arrivals with no report');
    expect(md).toContain('### Not collected');
  });

  it('reports labelled sessions when supplied', () => {
    const { report } = collect(
      [{ r: row({ id: 1, browserEvidence: 'interacted' }), session: 'operator: Chrome' }],
      { sessions: true },
    );
    expect(report.labelledShare).toMatchObject([{ group: 'operator: Chrome', interacted: 1 }]);
  });
});

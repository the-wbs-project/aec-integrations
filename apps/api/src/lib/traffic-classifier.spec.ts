/**
 * Unit tests for the versioned traffic classifier (AECI-872 / `ADMIN_PANEL_SPEC.md`
 * §13 D19).
 *
 * Four properties the decision depends on are asserted here: every class and
 * every reason code is reachable; an unresolved row always says why; network
 * ownership alone never reaches suspected automation; and internal traffic is a
 * flag, never a class. The version pin at the bottom fails any rule edit that
 * does not bump `TRAFFIC_CLASSIFIER_VERSION`.
 */

import { describe, expect, it } from 'vitest';

import type { AsnNetworkClass } from './asn-registry';
import {
  classifierFingerprint,
  classifyPageView,
  findSpaFollowups,
  REASON_CODES,
  TRAFFIC_CLASSES,
  TRAFFIC_CLASSIFIER_VERSION,
  type ClassifierContext,
  type ClassifierRow,
  type ReasonCode,
} from './traffic-classifier';

const AWS = 16509; // in DATACENTER_ASNS
const HOME_ISP = 7713; // an eyeball network, in no list
const CONTENT_ASN = 64512; // non_eyeball in the registry fixture, not a datacenter
const ROTATOR_ASN = 64513;

/** A browser arrival with every input present and nothing suspicious. */
function row(overrides: Partial<ClassifierRow> = {}): ClassifierRow {
  return {
    id: 1,
    createdAt: '2026-10-01T10:00:00.000Z',
    navigation: 'arrival',
    writerProvenance: 'ssr-arrival',
    clientVerdict: 'browser',
    isBot: false,
    botName: null,
    cfAsn: HOME_ISP,
    cfVerifiedBot: null,
    cfVerifiedBotCategory: null,
    hasSecChUa: true,
    hasAcceptLanguage: true,
    secFetchDest: 'document',
    tlsVersion: 'TLSv1.3',
    referrerSource: 'Direct',
    isOperator: false,
    userAgentHash: 'ua-home',
    privacySignal: false,
    ...overrides,
  };
}

/** A browser-verified SPA hop: the app executed. */
function spaHop(overrides: Partial<ClassifierRow> = {}): ClassifierRow {
  return row({
    navigation: 'spa',
    writerProvenance: 'browser-spa',
    secFetchDest: 'empty',
    ...overrides,
  });
}

function ctx(overrides: Partial<ClassifierContext> = {}): ClassifierContext {
  return {
    swarmUaHashes: new Set(['ua-swarm']),
    rotatorAsns: new Set([ROTATOR_ASN]),
    networkClassByAsn: new Map<number, AsnNetworkClass>([
      [HOME_ISP, 'eyeball'],
      [CONTENT_ASN, 'non_eyeball'],
      [AWS, 'non_eyeball'],
    ]),
    internalRowIds: new Set<number>(),
    spaFollowupRowIds: new Set<number>(),
    ...overrides,
  };
}

/** One fixture per behaviour; together they must reach every class and code. */
const FIXTURES: ReadonlyArray<{ name: string; row: ClassifierRow; ctx?: ClassifierContext }> = [
  {
    name: 'edge-verified search crawler',
    row: row({ cfVerifiedBot: true, cfVerifiedBotCategory: 'Search Engine Crawler' }),
  },
  {
    name: 'edge-verified assistant fetch',
    row: row({ cfVerifiedBot: true, cfVerifiedBotCategory: 'AI Assistant' }),
  },
  {
    name: 'edge-verified link preview',
    row: row({ cfVerifiedBot: true, cfVerifiedBotCategory: 'Page Preview' }),
  },
  { name: 'self-declared training crawler', row: row({ isBot: true, botName: 'GPTBot (OpenAI)' }) },
  { name: 'self-declared uptime monitor', row: row({ isBot: true, botName: 'Uptime monitor' }) },
  { name: 'generic bot token', row: row({ isBot: true, botName: 'Other bot' }) },
  {
    name: 'datacenter + inconsistent headers',
    row: row({
      isBot: true,
      botName: 'Datacenter (AWS)',
      cfAsn: AWS,
      clientVerdict: 'inconsistent',
    }),
  },
  {
    name: 'swarm member + non-browser verdict',
    row: row({ userAgentHash: 'ua-swarm', clientVerdict: 'non-browser' }),
  },
  {
    name: 'rotator + content network',
    row: row({ cfAsn: ROTATOR_ASN }),
    ctx: ctx({ networkClassByAsn: new Map([[ROTATOR_ASN, 'non_eyeball']]) }),
  },
  { name: 'app executed, search referral', row: spaHop({ referrerSource: 'Google' }) },
  {
    name: 'arrival with SPA follow-up, external referral',
    row: row({ id: 7, referrerSource: 'LinkedIn' }),
    ctx: ctx({ spaFollowupRowIds: new Set([7]) }),
  },
  { name: 'plain browser arrival, nothing to corroborate', row: row() },
  {
    name: 'app executed from a datacenter',
    row: spaHop({ cfAsn: AWS, isBot: true, botName: 'Datacenter (AWS)' }),
  },
  {
    name: 'stored bot verdict the rules cannot reproduce',
    row: row({ isBot: true, botName: 'Datacenter (Retired)' }),
  },
  { name: 'datacenter only', row: row({ isBot: true, botName: 'Datacenter (AWS)', cfAsn: AWS }) },
  { name: 'non-browser verdict only', row: row({ clientVerdict: 'non-browser' }) },
  { name: 'inconsistent verdict only', row: row({ clientVerdict: 'inconsistent' }) },
  { name: 'swarm only', row: row({ userAgentHash: 'ua-swarm' }) },
  { name: 'rotator only', row: row({ cfAsn: ROTATOR_ASN }) },
  { name: 'content network only', row: row({ cfAsn: CONTENT_ASN }) },
  { name: 'arrival without its network', row: row({ cfAsn: null }) },
  { name: 'arrival without TLS', row: row({ tlsVersion: null }) },
  { name: 'row written before writer provenance', row: row({ writerProvenance: null }) },
  {
    // AECI-1386: what ingest stores for a DNT/GPC request.
    name: 'privacy-signal SPA hop with the app executed',
    row: spaHop({ privacySignal: true, userAgentHash: null, cfAsn: null, tlsVersion: null }),
  },
];

function classify(f: (typeof FIXTURES)[number]) {
  return classifyPageView(f.row, f.ctx ?? ctx());
}

describe('classifyPageView', () => {
  it('reaches every class', () => {
    const reached = new Set(FIXTURES.map((f) => classify(f).class));
    expect([...reached].sort()).toEqual([...TRAFFIC_CLASSES].sort());
  });

  it('emits every reason code from at least one fixture', () => {
    const emitted = new Set<ReasonCode>(FIXTURES.flatMap((f) => classify(f).reasonCodes));
    const missing = REASON_CODES.filter((c) => !emitted.has(c));
    expect(missing).toEqual([]);
  });

  it('never returns an empty reason list, over a grid of inputs', () => {
    const verdicts = ['browser', 'inconsistent', 'non-browser', 'unknown', null];
    const writers = ['ssr-arrival', 'browser-spa', null];
    const asns = [HOME_ISP, AWS, CONTENT_ASN, ROTATOR_ASN, null];
    const bots: [boolean | null, string | null][] = [
      [false, null],
      [null, null],
      [true, 'Datacenter (AWS)'],
      [true, 'Googlebot'],
      [true, 'Datacenter (Retired)'],
    ];
    for (const clientVerdict of verdicts)
      for (const writerProvenance of writers)
        for (const cfAsn of asns)
          for (const [isBot, botName] of bots)
            for (const userAgentHash of ['ua-home', 'ua-swarm', null]) {
              const r = row({
                clientVerdict,
                writerProvenance,
                cfAsn,
                isBot,
                botName,
                userAgentHash,
              });
              const result = classifyPageView(r, ctx({ spaFollowupRowIds: new Set([1]) }));
              expect(result.reasonCodes.length, JSON.stringify(r)).toBeGreaterThan(0);
            }
  });

  it('fits the 8-code cap API_CONTRACTS.md §6.10 drafts for the wire', () => {
    // A follow-up needs a non-null pair (findSpaFollowups), so the ctx mirrors that.
    let max = 0;
    for (const clientVerdict of ['browser', 'inconsistent', 'non-browser', null])
      for (const writerProvenance of ['ssr-arrival', 'browser-spa', null])
        for (const cfAsn of [HOME_ISP, AWS, CONTENT_ASN, ROTATOR_ASN, null])
          for (const [isBot, botName] of [
            [false, null],
            [true, 'Datacenter (AWS)'],
            [true, 'Datacenter (Retired)'],
          ] as const)
            for (const userAgentHash of ['ua-home', 'ua-swarm', null])
              for (const tlsVersion of ['TLSv1.3', null])
                for (const referrerSource of ['Direct', 'Google']) {
                  const r = row({
                    clientVerdict,
                    writerProvenance,
                    cfAsn,
                    isBot,
                    botName,
                    userAgentHash,
                    tlsVersion,
                    referrerSource,
                  });
                  const paired = cfAsn !== null && userAgentHash !== null;
                  const result = classifyPageView(
                    r,
                    ctx({ spaFollowupRowIds: new Set(paired ? [1] : []) }),
                  );
                  max = Math.max(max, result.reasonCodes.length);
                }
    expect(max).toBeLessThanOrEqual(8);
  });

  it('places an unresolved row with a code that says why', () => {
    const plain = classifyPageView(row(), ctx());
    expect(plain.class).toBe('unresolved');
    expect(plain.reasonCodes).toEqual(['no_corroboration']);
  });

  it('never reaches suspected on network ownership alone', () => {
    // Two network facts about one ASN are one family, not two signals.
    const both = classifyPageView(
      row({ isBot: true, botName: 'Datacenter (AWS)', cfAsn: AWS }),
      ctx(),
    );
    expect(both.class).toBe('unresolved');
    expect(both.reasonCodes).toEqual([
      'asn_datacenter',
      'asn_non_eyeball',
      'single_signal_network',
    ]);

    const content = classifyPageView(row({ cfAsn: CONTENT_ASN }), ctx());
    expect(content.class).toBe('unresolved');
    expect(content.reasonCodes).toContain('single_signal_network');
  });

  it('needs two signal families for suspected automation', () => {
    const one = classifyPageView(row({ clientVerdict: 'non-browser' }), ctx());
    expect(one.class).toBe('unresolved');
    expect(one.reasonCodes).toContain('single_signal_request_shape');

    const two = classifyPageView(row({ clientVerdict: 'non-browser', cfAsn: AWS }), ctx());
    expect(two.class).toBe('suspected_automation');
    expect(two.reasonCodes).toEqual(['asn_datacenter', 'asn_non_eyeball', 'verdict_non_browser']);
  });

  it('puts identification ahead of every other signal', () => {
    const r = classifyPageView(
      row({ isBot: true, botName: 'Googlebot', cfAsn: AWS, clientVerdict: 'non-browser' }),
      ctx(),
    );
    expect(r.class).toBe('identified_automation');
    expect(r.reasonCodes).toEqual(['ua_self_declared', 'purpose_indexing']);
  });

  it('does not call a label self-declared when the ASN rule could have written it', () => {
    // 'Censys (scanner)' is both a NAMED_BOTS label and a DATACENTER_ASNS label.
    const fromAsn = classifyPageView(
      row({ isBot: true, botName: 'Censys (scanner)', cfAsn: 398324 }),
      ctx(),
    );
    expect(fromAsn.class).toBe('unresolved');
    expect(fromAsn.reasonCodes).toEqual(['asn_datacenter', 'single_signal_network']);

    const fromUa = classifyPageView(
      row({ isBot: true, botName: 'Censys (scanner)', cfAsn: HOME_ISP }),
      ctx(),
    );
    expect(fromUa.class).toBe('identified_automation');
  });

  it('gives a merged crawler label purpose_unknown, not a guess', () => {
    const r = classifyPageView(row({ isBot: true, botName: 'OpenAI' }), ctx());
    expect(r.reasonCodes).toEqual(['ua_self_declared', 'purpose_unknown']);
  });

  it('treats a category with a NULL boolean as edge-verified', () => {
    // Production since 2026-10-01: category populated, cf_verified_bot NULL.
    const r = classifyPageView(
      row({ cfVerifiedBot: null, cfVerifiedBotCategory: 'Search Engine Crawler' }),
      ctx(),
    );
    expect(r.class).toBe('identified_automation');
    expect(r.reasonCodes).toEqual(['verified_edge', 'purpose_indexing']);

    const neither = classifyPageView(
      row({ cfVerifiedBot: null, cfVerifiedBotCategory: null }),
      ctx(),
    );
    expect(neither.reasonCodes).not.toContain('verified_edge');
  });

  it('prefers the edge category over the stored label for purpose', () => {
    const r = classifyPageView(
      row({
        isBot: true,
        botName: 'OpenAI',
        cfVerifiedBot: true,
        cfVerifiedBotCategory: 'AI Assistant',
      }),
      ctx(),
    );
    expect(r.reasonCodes).toEqual([
      'verified_edge',
      'ua_self_declared',
      'purpose_assistant_retrieval',
    ]);
  });

  it('does not let a body claim of spa stand in for app execution', () => {
    // navigation = 'spa' with no trusted writer is the AECI-871 forgery shape.
    const r = classifyPageView(row({ navigation: 'spa', writerProvenance: null }), ctx());
    expect(r.class).toBe('unresolved');
  });

  it('keeps internal a flag beside the class, never a class', () => {
    const operator = classifyPageView(row({ isOperator: true }), ctx());
    expect(operator.internal).toBe(true);
    expect(operator.class).toBe('unresolved');

    const retroJoined = classifyPageView(
      row({ id: 9, clientVerdict: 'non-browser', cfAsn: AWS }),
      ctx({ internalRowIds: new Set([9]) }),
    );
    expect(retroJoined.internal).toBe(true);
    expect(retroJoined.class).toBe('suspected_automation');

    expect(TRAFFIC_CLASSES as readonly string[]).not.toContain('internal');
  });

  it('marks an arrival with no cf_asn as evidence-incomplete', () => {
    const r = classifyPageView(row({ cfAsn: null }), ctx());
    expect(r.evidenceComplete).toBe(false);
    expect(r.reasonCodes).toContain('evidence_no_asn');

    expect(classifyPageView(row(), ctx()).evidenceComplete).toBe(true);
  });

  it('does not ask an SPA hop for arrival metadata', () => {
    const r = classifyPageView(spaHop({ cfAsn: null, tlsVersion: null }), ctx());
    expect(r.evidenceComplete).toBe(true);
    expect(r.class).toBe('browser_with_human_evidence');
  });

  describe('privacy-signal rows (AECI-1386)', () => {
    const privacyRow = (overrides: Partial<ClassifierRow> = {}) =>
      row({
        privacySignal: true,
        userAgentHash: null,
        cfAsn: null,
        tlsVersion: null,
        hasSecChUa: null,
        hasAcceptLanguage: null,
        secFetchDest: null,
        ...overrides,
      });

    it('never classifies as browser_with_human_evidence, even when the app executed', () => {
      const r = classifyPageView(
        privacyRow({ navigation: 'spa', writerProvenance: 'browser-spa' }),
        ctx(),
      );
      expect(r.class).toBe('unresolved');
      expect(r.reasonCodes).toEqual([
        'app_executed',
        'no_corroboration',
        'evidence_privacy_signal',
      ]);
      expect(r.reasonCodes).not.toContain('conflicting_signals');
    });

    it('replaces the missing ASN and TLS gaps with one privacy code', () => {
      const r = classifyPageView(privacyRow(), ctx());
      expect(r.reasonCodes).toEqual(['no_corroboration', 'evidence_privacy_signal']);
      expect(r.reasonCodes).not.toContain('evidence_no_asn');
      expect(r.reasonCodes).not.toContain('evidence_no_tls');
      expect(r.evidenceComplete).toBe(false);
    });

    it('leaves the identified and suspected steps as they were', () => {
      expect(classifyPageView(privacyRow({ isBot: true, botName: 'Googlebot' }), ctx()).class).toBe(
        'identified_automation',
      );
      expect(
        classifyPageView(
          privacyRow({
            navigation: 'spa',
            writerProvenance: 'browser-spa',
            clientVerdict: 'non-browser',
          }),
          ctx(),
        ).reasonCodes,
      ).toContain('single_signal_request_shape');
    });

    it('never reads a label the ASN rule can write as self-declared', () => {
      // Censys is both a NAMED_BOTS and a DATACENTER_ASNS label. The row has no ASN
      // to tell which rule wrote it, so it is not `ua_self_declared`.
      const r = classifyPageView(privacyRow({ isBot: true, botName: 'Censys (scanner)' }), ctx());
      expect(r.reasonCodes).not.toContain('ua_self_declared');
      expect(r.class).toBe('unresolved');
      expect(r.reasonCodes).toContain('bot_label_unmapped');
    });

    it('reads a NULL privacy_signal as false, so history keeps its class', () => {
      const r = classifyPageView(spaHop({ privacySignal: null }), ctx());
      expect(r.class).toBe('browser_with_human_evidence');
    });
  });

  it('stamps the version on every result', () => {
    expect(classifyPageView(row(), ctx()).version).toBe(TRAFFIC_CLASSIFIER_VERSION);
  });
});

describe('findSpaFollowups', () => {
  const arrival = row({ id: 1, createdAt: '2026-10-01T10:00:00.000Z' });

  it('pairs an arrival with a browser-verified hop on the same pair inside the window', () => {
    const hop = spaHop({ id: 2, createdAt: '2026-10-01T10:29:00.000Z' });
    expect([...findSpaFollowups([arrival, hop])]).toEqual([1]);
  });

  it('ignores a hop outside the window, on another network, or unverified', () => {
    const late = spaHop({ id: 2, createdAt: '2026-10-01T10:31:00.000Z' });
    const before = spaHop({ id: 3, createdAt: '2026-10-01T09:59:00.000Z' });
    const elsewhere = spaHop({ id: 4, cfAsn: AWS, createdAt: '2026-10-01T10:05:00.000Z' });
    const unverified = spaHop({
      id: 5,
      clientVerdict: 'unknown',
      createdAt: '2026-10-01T10:05:00.000Z',
    });
    expect(findSpaFollowups([arrival, late, before, elsewhere, unverified]).size).toBe(0);
  });

  it('never pairs on a NULL hash or ASN', () => {
    const a = row({ id: 1, userAgentHash: null });
    const hop = spaHop({ id: 2, userAgentHash: null, createdAt: '2026-10-01T10:05:00.000Z' });
    expect(findSpaFollowups([a, hop]).size).toBe(0);
  });
});

describe('classifier version pin', () => {
  it('matches the pinned version and rule fingerprint', async () => {
    // A rule input changed if this fails. Bump TRAFFIC_CLASSIFIER_VERSION in
    // traffic-classifier.ts, then update BOTH literals below in the same change.
    const PINNED = {
      version: 'tc-2026.10.3',
      fingerprint: 'c7ce31fb1d669930aa5b3cafcdc7cba25247744591c0166b0721def9e2d0fdb7',
    };
    expect(
      { version: TRAFFIC_CLASSIFIER_VERSION, fingerprint: await classifierFingerprint() },
      'A classifier rule input changed. Bump TRAFFIC_CLASSIFIER_VERSION and update both pinned literals.',
    ).toEqual(PINNED);
  });
});

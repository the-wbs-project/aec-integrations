/**
 * Unit tests for the AECI-1345 nightly writer: what one run stores, that a re-run
 * of the same version stores nothing, that a new version writes beside the old,
 * that the stored classes are the shadow runner's, and that a chunk stays inside
 * D1's real value limit.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestDb, type TestDb } from '../test/d1';
import {
  CLASSIFICATION_ROWS_PER_STATEMENT,
  classifierRunConstants,
  classifyDay,
  classifyDayFor,
  D1_MAX_VALUE_BYTES,
  type ClassificationPayloadRow,
} from './traffic-classification-writer';
import { AdminPageViewClassificationSchema } from '@aeci/shared';

import { GENERIC_BOT_LABEL } from './bot-classification';
import {
  classifyPageView,
  REASON_CODES,
  TRAFFIC_CLASSIFIER_VERSION,
  type ClassifierContext,
  type ClassifierRow,
} from './traffic-classifier';
import {
  loadPulledRows,
  parseLabelsFile,
  PULL_COLUMNS,
  runShadow,
  type PulledPageView,
} from './traffic-shadow';

const DAY = '2026-10-01';
const NOW = new Date('2026-10-02T00:45:00.000Z');

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

const ROWS: PulledPageView[] = [
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
  pulled({
    id: 5,
    created_at: '2026-10-01T11:00:00.000Z',
    is_operator: 1,
    cf_asn: 4761,
    user_agent_hash: 'ua-op',
  }),
  pulled({
    id: 7,
    created_at: '2026-10-01T13:00:00.000Z',
    cf_asn: null,
    user_agent_hash: 'ua-blind',
  }),
  pulled({ id: 8, created_at: '2026-10-02T00:00:00.000Z' }), // the next day
];

interface StoredRow {
  page_view_id: number;
  class: string;
  reason_codes: string;
  classifier_version: string;
  evaluated_at: string;
  evidence_from: string;
  evidence_to: string;
  view_day: string;
}

describe('classifyDay', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
    await loadPulledRows(t.db, ROWS, []);
  });
  afterEach(() => t.dispose());

  const stored = () =>
    t.raw
      .prepare(
        `SELECT page_view_id, class, reason_codes, classifier_version, evaluated_at,
                evidence_from, evidence_to, view_day
           FROM page_view_classifications ORDER BY page_view_id, classifier_version`,
      )
      .all() as StoredRow[];

  it('stores one row per view of the day, internal rows included, with the evidence window', async () => {
    const result = await classifyDay(t.db, DAY, NOW);

    expect(result).toMatchObject({
      day: DAY,
      classifierVersion: TRAFFIC_CLASSIFIER_VERSION,
      rowsSeen: 6,
      rowsWritten: 6,
      evidenceIncomplete: 1,
      swarmTruncated: false,
    });
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(result.countsByClass).reduce((a, b) => a + b, 0)).toBe(6);

    const rows = stored();
    expect(rows.map((r) => r.page_view_id)).toEqual([1, 2, 3, 4, 5, 7]);
    for (const r of rows) {
      expect(r).toMatchObject({
        classifier_version: TRAFFIC_CLASSIFIER_VERSION,
        evaluated_at: NOW.toISOString(),
        evidence_from: '2026-09-17T00:00:00.000Z', // SWARM_PRIOR_LOOKBACK_DAYS before
        evidence_to: '2026-10-02T00:30:00.000Z', // the SPA follow-up margin after
        view_day: DAY,
      });
      const codes = JSON.parse(r.reason_codes) as string[];
      expect(codes.length).toBeGreaterThan(0);
      for (const c of codes) expect(REASON_CODES).toContain(c);
    }
    expect(rows.find((r) => r.page_view_id === 1)?.class).toBe('identified_automation');
    expect(JSON.parse(rows.find((r) => r.page_view_id === 7)!.reason_codes)).toContain(
      'evidence_no_asn',
    );
  });

  it('is idempotent per version: a re-run stores nothing new and changes nothing', async () => {
    await classifyDay(t.db, DAY, NOW);
    const first = stored();
    const again = await classifyDay(t.db, DAY, new Date('2026-10-02T03:00:00.000Z'));
    expect(again.rowsWritten).toBe(0);
    expect(again.rowsSeen).toBe(6);
    expect(stored()).toEqual(first);
  });

  it('writes the current version beside an older one, never over it', async () => {
    t.raw
      .prepare(
        `INSERT INTO page_view_classifications
           (page_view_id, class, reason_codes, classifier_version, evaluated_at,
            evidence_from, evidence_to, view_day, created_at)
         VALUES (2, 'unresolved', '["no_corroboration"]', 'tc-old', ?, ?, ?, ?, ?)`,
      )
      .run('2026-09-01T00:00:00.000Z', 'a', 'b', DAY, '2026-09-01T00:00:00.000Z');

    const result = await classifyDay(t.db, DAY, NOW);
    expect(result.rowsWritten).toBe(6);
    const forTwo = stored().filter((r) => r.page_view_id === 2);
    expect(forTwo.map((r) => r.classifier_version).sort()).toEqual(
      ['tc-old', TRAFFIC_CLASSIFIER_VERSION].sort(),
    );
    expect(forTwo.find((r) => r.classifier_version === 'tc-old')?.class).toBe('unresolved');
  });

  it('stores the classes the shadow runner counts for the same day (D19(h))', async () => {
    const result = await classifyDay(t.db, DAY, NOW);
    const shadow = await runShadow(t.db, {
      fromDay: DAY,
      toDay: DAY,
      labels: parseLabelsFile({}),
    });
    expect(result.countsByClass).toEqual(shadow.days[0]?.classCounts);
    const byClass = t.raw
      .prepare(
        `SELECT class, count(*) AS n FROM page_view_classifications GROUP BY class ORDER BY class`,
      )
      .all() as { class: string; n: number }[];
    for (const { class: cls, n } of byClass) {
      expect(result.countsByClass[cls as keyof typeof result.countsByClass]).toBe(n);
    }
  });

  it('stores nothing for an empty day', async () => {
    const result = await classifyDay(t.db, '2026-09-01', NOW);
    expect(result).toMatchObject({ rowsSeen: 0, rowsWritten: 0 });
    expect(stored()).toEqual([]);
  });
});

describe('writer limits and constants', () => {
  it('never emits more reason codes than the wire cap (16), over every input combination', () => {
    // §6.10 drafted max(8). Enumerate the inputs the classifier branches on and
    // take the true maximum, so the cap is pinned to what the rules can emit.
    const codesSchema = AdminPageViewClassificationSchema.shape.reason_codes;
    const cap = 16;
    expect(codesSchema.safeParse(Array(cap).fill('x')).success).toBe(true);
    expect(codesSchema.safeParse(Array(cap + 1).fill('x')).success).toBe(false);
    const ctx: ClassifierContext = {
      swarmUaHashes: new Set(['ua-swarm']),
      rotatorAsns: new Set([16509]),
      networkClassByAsn: new Map([
        [16509, 'non_eyeball'],
        [7713, 'eyeball'],
        [64512, 'non_eyeball'],
      ]),
      internalRowIds: new Set([1]),
      spaFollowupRowIds: new Set([1]),
    };
    let worst = 0;
    for (const isBot of [null, false, true])
      for (const botName of [null, 'Googlebot', GENERIC_BOT_LABEL, 'Datacenter (AWS)', 'Old label'])
        for (const cfAsn of [null, 7713, 16509, 64512])
          for (const clientVerdict of [null, 'browser', 'non-browser', 'inconsistent'])
            for (const userAgentHash of [null, 'ua', 'ua-swarm'])
              for (const writerProvenance of [null, 'ssr-arrival', 'browser-spa'])
                for (const navigation of [null, 'arrival', 'spa'])
                  for (const tlsVersion of [null, 'TLSv1.3'])
                    for (const referrerSource of [null, 'Direct', 'Google', 'LinkedIn'])
                      for (const cfVerifiedBotCategory of [null, 'Search Engine Crawler']) {
                        const row: ClassifierRow = {
                          id: 1,
                          createdAt: '2026-10-01T10:00:00.000Z',
                          navigation,
                          writerProvenance,
                          clientVerdict,
                          isBot,
                          botName,
                          cfAsn,
                          cfVerifiedBot: null,
                          cfVerifiedBotCategory,
                          hasSecChUa: null,
                          hasAcceptLanguage: null,
                          secFetchDest: null,
                          tlsVersion,
                          referrerSource,
                          isOperator: null,
                          userAgentHash,
                          privacySignal: null,
                        };
                        worst = Math.max(worst, classifyPageView(row, ctx).reasonCodes.length);
                      }
    expect(worst).toBeGreaterThan(8);
    expect(worst).toBeLessThanOrEqual(cap);
  });

  it('keeps a worst-case chunk far under D1’s value limit', () => {
    // Upper bound: every reason code on every row, the longest class, an id past 2^31.
    const worst: ClassificationPayloadRow = {
      i: 9_007_199_254,
      c: 'browser_with_human_evidence',
      r: [...REASON_CODES],
    };
    const chunk = JSON.stringify(Array(CLASSIFICATION_ROWS_PER_STATEMENT).fill(worst));
    expect(new TextEncoder().encode(chunk).length).toBeLessThan(D1_MAX_VALUE_BYTES / 2);
  });

  it('records the scalar tunables and the swarm block, not the ASN tables', () => {
    const constants = classifierRunConstants();
    expect(Object.keys(constants).sort()).toEqual([
      'SPA_FOLLOWUP_WINDOW_MINUTES',
      'SUSPECTED_MIN_SIGNAL_FAMILIES',
      'swarm',
    ]);
    expect(JSON.stringify(constants).length).toBeLessThan(2_000);
  });

  it('classifies the prior complete UTC day', () => {
    expect(classifyDayFor(NOW)).toBe(DAY);
    expect(classifyDayFor(new Date('2026-10-01T23:59:59.999Z'))).toBe('2026-09-30');
  });
});

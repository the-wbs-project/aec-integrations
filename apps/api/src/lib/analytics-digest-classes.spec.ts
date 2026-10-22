/**
 * The 05:00 digest leads with the D19 traffic classes (AECI-1346, D19 Phase 3).
 *
 * Formatter cases over fixtures, plus one D1 case that the collector reads the
 * classes through the same functions `/admin/overview` uses. Covers the three
 * states that must never look alike (classified, not classified, read failed),
 * the classifier seam, and both §3d collection-method treatments.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pageViews } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  buildAnalyticsDigest,
  collectAnalyticsMetrics,
  digestMethodSeams,
  windowsForDay,
  type AnalyticsMetrics,
  type DigestClassification,
} from './analytics-digest';
import type { ArrivalCfCoverage } from './arrival-coverage';

const HEALTHY: ArrivalCfCoverage = { arrivals: 900, arrivalsWithAsn: 900, coverage: 1 };

type Views = DigestClassification['day']['summary']['counts'][number];

function classification(opts: {
  version?: string | null;
  views?: [number, number, number, number];
  visitors?: [number, number, number, number];
  prior?: { version: string; views: [number, number, number, number] } | null;
  internal?: number;
  leak?: number;
  seam?: DigestClassification['versionSeam'];
}): DigestClassification {
  const version = opts.version === undefined ? 'tc-2026.10.2' : opts.version;
  const views = version === null ? [0, 0, 0, 0] : (opts.views ?? [9000, 880, 412, 1203]);
  const visitors = opts.visitors ?? [30, 12, 100, 300];
  const classes = [
    'identified_automation',
    'suspected_automation',
    'browser_with_human_evidence',
    'unresolved',
  ] as const;
  const counts: Views[] = classes.map((c, i) => ({
    class: c,
    views: views[i]!,
    visitors: version === null ? 0 : visitors[i]!,
    delta_day: null,
  }));
  const classified = views.reduce((a, b) => a + b, 0);
  const priorIn =
    opts.prior === undefined ? { version, views: [8000, 800, 400, 1200] } : opts.prior;
  const prior =
    priorIn && priorIn.version
      ? {
          version: priorIn.version,
          views: Object.fromEntries(classes.map((c, i) => [c, priorIn.views[i]!])) as Record<
            (typeof classes)[number],
            number
          >,
        }
      : null;
  return {
    day: {
      summary: {
        classifier_version: version,
        counts,
        internal_excluded: { views: opts.internal ?? 40, operator_leak_inferred: opts.leak ?? 3 },
        basis: 'requests',
        version_seam: null,
        method_seams: [],
      },
      unresolved: views[3]!,
      classified,
      unresolvedShareExceeded: classified > 0 && views[3]! / classified > 0.5,
    },
    prior,
    versionSeam: opts.seam ?? null,
  };
}

const base: AnalyticsMetrics = {
  pageViews: { day: 1700, prior: 1600 },
  botPageViews: { day: 9000, prior: 8000 },
  newUsers: { day: 2, prior: 1 },
  totalUsers: 140,
  pendingModeration: 0,
  topProducts: [{ name: 'Revit', slug: 'revit', views: 120 }],
  referrers: [{ source: 'Direct', views: 300 }],
  botActivity: [{ name: 'Bingbot', crawls: 9000 }],
  corroboratedViews: { day: 12, prior: 9 },
  corroboratedVisitors: 7,
  operatorLeakViews: 3,
  automation: { flagged: { day: 500, prior: 450 }, note: null },
  swarm: null,
  arrivalCoverage: HEALTHY,
  priorArrivalCoverage: HEALTHY,
  classification: classification({}),
};

const opts = {
  env: 'production',
  dayLabel: '2026-09-20',
  generatedAt: new Date('2026-09-21T05:00:05.000Z'),
};

describe('buildAnalyticsDigest: the classes lead (AECI-1346)', () => {
  it('leads the subject with the classes and the version', () => {
    const { subject } = buildAnalyticsDigest(base, opts);
    expect(subject).toBe(
      'AECi daily digest (production) — 2026-09-20: 412 with human evidence · 1203 unresolved · 9880 automation (tc-2026.10.2), 2 new users · top: Revit · 9000 crawls',
    );
    expect(subject).not.toContain('unresolved origin');
  });

  it('prints the class section first, in D19(b) order, with views, visitors and a day delta', () => {
    const { text } = buildAnalyticsDigest(base, opts);
    const classAt = text.indexOf('== Traffic by class (requests) ==');
    const residualAt = text.indexOf('== Previous measure: requests of unresolved origin ==');
    expect(classAt).toBeGreaterThan(0);
    expect(residualAt).toBeGreaterThan(classAt);
    expect(text).toContain('Classifier tc-2026.10.2. Counts are requests, not people.');
    const lines = [
      'Identified automation: 9000 views from 30 visitors (+1000 (+13%) vs 8000 prior day)',
      'Suspected automation: 880 views from 12 visitors (+80 (+10%) vs 800 prior day)',
      'Browser activity with supporting human evidence: 412 views from 100 visitors (+12 (+3%) vs 400 prior day)',
      'Unresolved: 1203 views from 300 visitors (+3 (+0%) vs 1200 prior day)',
    ];
    let last = classAt;
    for (const l of lines) {
      const at = text.indexOf(l);
      expect(at, l).toBeGreaterThan(last);
      last = at;
    }
    expect(text).toContain(
      'Internal traffic, excluded by identity: 40 views. Operator-leak inference: 3 views. It is not a class, and no class above counts it.',
    );
  });

  it('puts the heuristic caveat beside the human-evidence line, always', () => {
    const { text, html } = buildAnalyticsDigest(base, opts);
    const human = text.indexOf('Browser activity with supporting human evidence:');
    const caveat = text.indexOf('This class is a heuristic.');
    expect(caveat).toBeGreaterThan(human);
    expect(caveat).toBeLessThan(text.indexOf('Unresolved: 1203'));
    expect(html).toContain('This class is a heuristic.');
  });

  it('warns about the unresolved share only above 50%', () => {
    expect(buildAnalyticsDigest(base, opts).text).not.toContain(
      'classified requests are unresolved',
    );
    const heavy = {
      ...base,
      classification: classification({ views: [100, 0, 50, 300] }),
    };
    const { text, html } = buildAnalyticsDigest(heavy, opts);
    expect(text).toContain(
      'More than 50% of the classified requests are unresolved (300 of 450). Read the split as mostly unknown, not as a confident breakdown.',
    );
    expect(html).toContain('classified requests are unresolved (300 of 450)');
  });

  it('keeps the residual section, its content and caveats, below the classes', () => {
    const { text, html } = buildAnalyticsDigest(base, opts);
    expect(text).toContain(
      'Requests of unresolved origin: 1200 (+50 (+4%) vs 1150 prior day)  [previous measure]',
    );
    expect(text).toContain('[supporting evidence]');
    expect(html.indexOf('Traffic by class (requests)')).toBeLessThan(
      html.indexOf('Previous measure: requests of unresolved origin'),
    );
  });

  it('says the classifier did not run, and prints no zeros, on an unclassified day', () => {
    const m = { ...base, classification: classification({ version: null, prior: null }) };
    const { subject, text, html } = buildAnalyticsDigest(m, opts);
    expect(subject).toContain('1200 requests of unresolved origin (1700 raw) · NOT CLASSIFIED');
    expect(text).toContain('The classifier did not run for this day. No class counts are shown.');
    expect(text).not.toContain('Identified automation:');
    expect(text).not.toMatch(/: 0 views from 0 visitors/);
    expect(html).toContain('The classifier did not run for this day.');
  });

  it('says the classes could not be read when the read failed, distinct from unclassified', () => {
    const { subject, text } = buildAnalyticsDigest({ ...base, classification: null }, opts);
    expect(subject).toContain('· CLASSES UNAVAILABLE');
    expect(text).toContain('The traffic classes could not be read for this day.');
    expect(text).not.toContain('The classifier did not run');
  });

  it('keeps the telemetry suffix in both subject forms', () => {
    const blind = { arrivals: 900, arrivalsWithAsn: 0, coverage: 0 };
    expect(buildAnalyticsDigest({ ...base, arrivalCoverage: blind }, opts).subject).toMatch(
      /\(tc-2026\.10\.2\).* · NO NETWORK TELEMETRY$/,
    );
    expect(
      buildAnalyticsDigest(
        { ...base, arrivalCoverage: blind, classification: classification({ version: null }) },
        opts,
      ).subject,
    ).toMatch(/NOT CLASSIFIED.* · NO NETWORK TELEMETRY$/);
  });

  it('suppresses every class delta across a classifier seam and names both versions', () => {
    const m = {
      ...base,
      classification: classification({
        prior: { version: 'tc-2026.10.1', views: [1, 2, 3, 4] },
        seam: {
          from_version: 'tc-2026.10.1',
          to_version: 'tc-2026.10.2',
          changed_on: '2026-09-20',
        },
      }),
    };
    const { text, html } = buildAnalyticsDigest(m, opts);
    expect(text).toContain(
      'Classifier changed from tc-2026.10.1 to tc-2026.10.2 on 2026-09-20. Each day is counted on its own version, so the changes vs the prior day are not shown.',
    );
    expect(text).toContain(
      'Identified automation: 9000 views from 30 visitors (not comparable with the prior day (classifier changed))',
    );
    expect(text).not.toContain('+8999');
    // The residual is not a class figure, so a classifier seam leaves its delta alone.
    expect(text).toContain('Requests of unresolved origin: 1200 (+50 (+4%) vs 1150 prior day)');
    expect(html).toContain('Classifier changed from tc-2026.10.1 to tc-2026.10.2');
  });

  it('says the prior day was not classified rather than comparing against zero', () => {
    const m = { ...base, classification: classification({ prior: null }) };
    expect(buildAnalyticsDigest(m, opts).text).toContain(
      'Unresolved: 1203 views from 300 visitors (not comparable with the prior day (the prior day was not classified))',
    );
  });
});

describe('buildAnalyticsDigest: §3d collection-method changes (AECI-1346)', () => {
  it('finds a row only on its own tier, between the prior day and the reported day', () => {
    expect(digestMethodSeams('staging', '2026-10-21').map((r) => r.issue)).toEqual(['AECI-1297']);
    // The prior day of 10-22 is 10-21, so the staging row still spans the pair.
    expect(digestMethodSeams('staging', '2026-10-22').map((r) => r.issue)).toEqual(['AECI-1297']);
    expect(digestMethodSeams('staging', '2026-10-23')).toEqual([]);
    expect(digestMethodSeams('production', '2026-10-21')).toEqual([]);
    expect(digestMethodSeams('development', '2026-10-21')).toEqual([]);
  });

  it('a non-comparable row suppresses class AND residual deltas', () => {
    const { text } = buildAnalyticsDigest(base, {
      ...opts,
      env: 'staging',
      dayLabel: '2026-10-21',
    });
    expect(text).toContain(
      'Collection method changed at 2026-10-21 10:38 UTC: the SSR gateway writes the arrival row on a cache hit as well as a miss (AECI-1297). Counts either side are not comparable, so the changes vs the prior day are not shown.',
    );
    expect(text).toContain(
      'Identified automation: 9000 views from 30 visitors (not comparable with the prior day (collection method changed))',
    );
    expect(text).toContain(
      'Requests of unresolved origin: 1200 (not comparable with the prior day (collection method changed))',
    );
    // Sign-ins read no page_views row, so their delta stands.
    expect(text).toContain('New sign-ins (new accounts): 2 (+1 (+100%) vs 1 prior day)');
  });

  it('a comparable row is informational: the line prints and the deltas stand', () => {
    const { text, html } = buildAnalyticsDigest(base, {
      ...opts,
      env: 'production',
      dayLabel: '2026-10-22',
    });
    expect(text).toContain(
      'Collection method changed at 2026-10-22 03:53 UTC: native cache enabled; arrival rows survive a cache hit (AECI-1443). Arrival counts stay comparable, so the changes vs the prior day stand.',
    );
    expect(text).toContain('Identified automation: 9000 views from 30 visitors (+1000 (+13%)');
    expect(text).toContain('Requests of unresolved origin: 1200 (+50 (+4%) vs 1150 prior day)');
    expect(html).toContain('Arrival counts stay comparable');
  });

  it('prints the method line even when the day was not classified', () => {
    const { text } = buildAnalyticsDigest(
      { ...base, classification: classification({ version: null }) },
      { ...opts, env: 'staging', dayLabel: '2026-10-21' },
    );
    expect(text).toContain('The classifier did not run for this day.');
    expect(text).toContain('Collection method changed at 2026-10-21 10:38 UTC');
  });
});

describe('collectAnalyticsMetrics: the class read (AECI-1346)', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  async function view(createdAt: string, extra: Partial<typeof pageViews.$inferInsert> = {}) {
    const [row] = await t.db
      .insert(pageViews)
      .values({ path: '/x', createdAt, userAgentHash: 'ua', cfAsn: 7713, ...extra })
      .returning({ id: pageViews.id });
    return row!.id;
  }

  function classify(id: number, cls: string, version: string, day: string) {
    t.raw
      .prepare(
        `INSERT INTO page_view_classifications
           (page_view_id, class, reason_codes, classifier_version, evaluated_at,
            evidence_from, evidence_to, view_day, created_at)
         VALUES (?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        cls,
        version,
        `${day}T23:59:00.000Z`,
        `${day}T00:00:00.000Z`,
        `${day}T00:00:00.000Z`,
        day,
        `${day}T23:59:00.000Z`,
      );
  }

  it('reads the day, the prior day and the seam; an unclassified window is not null', async () => {
    const w = windowsForDay('2026-09-20');
    const empty = await collectAnalyticsMetrics(t.db, w);
    expect(empty.classification?.day.summary.classifier_version).toBeNull();
    expect(empty.classification?.prior).toBeNull();

    classify(await view('2026-09-19T10:00:00.000Z'), 'unresolved', 'v1', '2026-09-19');
    classify(await view('2026-09-20T10:00:00.000Z'), 'unresolved', 'v2', '2026-09-20');
    const m = await collectAnalyticsMetrics(t.db, w);
    expect(m.classification?.day.summary.classifier_version).toBe('v2');
    expect(m.classification?.prior?.version).toBe('v1');
    expect(m.classification?.versionSeam).toEqual({
      from_version: 'v1',
      to_version: 'v2',
      changed_on: '2026-09-20',
    });
    expect(m.classification?.day.summary.internal_excluded.operator_leak_inferred).toBe(
      m.operatorLeakViews,
    );
  });

  it('skips the read when asked, for the metrics_daily snapshot', async () => {
    const m = await collectAnalyticsMetrics(t.db, windowsForDay('2026-09-20'), {
      classification: false,
    });
    expect(m.classification).toBeNull();
  });
});

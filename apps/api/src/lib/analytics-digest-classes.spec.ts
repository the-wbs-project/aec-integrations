/**
 * The 05:00 digest leads with the D19 traffic classes (AECI-1346, D19 Phase 3).
 *
 * Formatter cases over fixtures, plus one D1 case that the collector reads the
 * classes through the same functions `/admin/overview` uses. Covers the three
 * states that must never look alike (classified, not classified, read failed),
 * the classifier seam, and both §3d collection-method treatments.
 *
 * AECI-1460 removed the residual below the classes, so these cases also pin
 * that it stays gone, and that a comparable §3d row is flagged without nulling
 * a class delta.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pageViews } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  buildAnalyticsDigest,
  collectAnalyticsMetrics,
  digestMethodSeams,
  readDigestUnresolvedClients,
  readDigestUnresolvedIdentities,
  unresolvedClientsDetail,
  unresolvedIdentitiesDetail,
  UNRESOLVED_IDENTITIES_NONE_NOTE,
  UNRESOLVED_IDENTITIES_TITLE,
  UNRESOLVED_IDENTITIES_UNREAD_NOTE,
  windowsForDay,
  type AnalyticsMetrics,
  type DigestClassification,
} from './analytics-digest';
import type { Db } from '../db/client';
import type { TopUnresolvedClient, TopUnresolvedIdentity } from './admin-classification';
import type { ArrivalCfCoverage } from './arrival-coverage';
import { COLLECTION_METHOD_CHANGES } from './collection-method-changes';

/** The real production AECI-1460 §3d row (AECI-1465). */
const AECI_1460_ROW = COLLECTION_METHOD_CHANGES.find(
  (r) => r.issue === 'AECI-1460' && r.tier === 'production',
)!;

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
  tablesUnclassified: false,
  botActivity: [{ name: 'Bingbot', crawls: 9000 }],
  operatorLeakViews: 3,
  arrivalCoverage: HEALTHY,
  priorArrivalCoverage: HEALTHY,
  classification: classification({}),
};

const opts = {
  env: 'production',
  dayLabel: '2026-09-20',
  generatedAt: new Date('2026-09-21T05:00:05.000Z'),
  unresolvedClients: [] as TopUnresolvedClient[] | null,
  unresolvedIdentities: [] as TopUnresolvedIdentity[] | null,
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
    expect(classAt).toBeGreaterThan(0);
    expect(classAt).toBeLessThan(
      text.indexOf('== Most viewed products (excluding classed automation) =='),
    );
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

  it('prints no residual, no referrer floor and no PostHog line (AECI-1460)', () => {
    const { text, html } = buildAnalyticsDigest(base, opts);
    for (const body of [text, html]) {
      expect(body).not.toMatch(/unresolved origin/i);
      expect(body).not.toMatch(/previous measure/i);
      expect(body).not.toMatch(/corroborat/i);
      expect(body).not.toContain('PostHog');
      expect(body).not.toMatch(/browser start/i);
      expect(body).not.toContain('after automation');
      expect(body).not.toContain('upper bound');
    }
  });

  it('says the classifier did not run, and prints no zeros, on an unclassified day', () => {
    const m = { ...base, classification: classification({ version: null, prior: null }) };
    const { subject, text, html } = buildAnalyticsDigest(m, opts);
    // AECI-1460: no residual fallback. The reason, and no traffic count.
    expect(subject).toBe(
      'AECi daily digest (production) — 2026-09-20: NOT CLASSIFIED, 2 new users · top: Revit · 9000 crawls',
    );
    expect(subject).not.toContain('unresolved origin');
    expect(subject).not.toContain(' raw)');
    expect(text).toContain('The classifier did not run for this day. No class counts are shown.');
    expect(text).not.toContain('Identified automation:');
    expect(text).not.toMatch(/: 0 views from 0 visitors/);
    expect(html).toContain('The classifier did not run for this day.');
  });

  it('says the classes could not be read when the read failed, distinct from unclassified', () => {
    const { subject, text } = buildAnalyticsDigest({ ...base, classification: null }, opts);
    expect(subject).toBe(
      'AECi daily digest (production) — 2026-09-20: CLASSES UNAVAILABLE, 2 new users · top: Revit · 9000 crawls',
    );
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
    // The crawler figure is not a class figure, so a classifier seam leaves its delta alone.
    expect(text).toContain('Bot/crawler page views: 9000 (+1000 (+13%) vs 8000 prior day)');
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
    // AECI-1460's staging row (10-23 04:02) spans the 10-23 and 10-24 pairs.
    expect(digestMethodSeams('staging', '2026-10-23').map((r) => r.issue)).toEqual(['AECI-1460']);
    expect(digestMethodSeams('staging', '2026-10-24').map((r) => r.issue)).toEqual(['AECI-1460']);
    expect(digestMethodSeams('staging', '2026-10-25')).toEqual([]);
    expect(digestMethodSeams('production', '2026-10-21')).toEqual([]);
    expect(digestMethodSeams('development', '2026-10-21')).toEqual([]);
  });

  it('a non-comparable row suppresses class AND crawler deltas', () => {
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
      'Bot/crawler page views: 9000 (not comparable with the prior day (collection method changed))',
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
    expect(text).toContain('Bot/crawler page views: 9000 (+1000 (+13%) vs 8000 prior day)');
    expect(html).toContain('Arrival counts stay comparable');
  });

  it('flags a comparable AECI-1460 row and leaves every class delta standing', () => {
    expect(digestMethodSeams('production', '2026-10-26').map((r) => r.issue)).toEqual([
      'AECI-1460',
    ]);
    const { text, html } = buildAnalyticsDigest(base, {
      ...opts,
      env: 'production',
      dayLabel: '2026-10-26',
    });
    expect(text).toContain(
      'Collection method changed at 2026-10-26 08:15 UTC: residual and AutomationExclusion retired; traffic.page_views_human_after_automation frozen (AECI-1460). Arrival counts stay comparable, so the changes vs the prior day stand.',
    );
    expect(html).toContain(`${AECI_1460_ROW.summary} (AECI-1460)`);
    expect(text).toContain(
      'Identified automation: 9000 views from 30 visitors (+1000 (+13%) vs 8000 prior day)',
    );
    expect(text).toContain('Unresolved: 1203 views from 300 visitors (+3 (+0%) vs 1200 prior day)');
    expect(text).not.toContain('collection method changed)');
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

describe('buildAnalyticsDigest: top Unresolved clients (AECI-1579)', () => {
  const TITLE = 'Top Unresolved clients (requests)';
  const client = (extra: Partial<TopUnresolvedClient> = {}): TopUnresolvedClient => ({
    userAgentHash: '7484a43eaaaaaaaaaaaaaaaaaaaaaaaa',
    cfAsn: 14618,
    asOrganization: 'AMAZON-AES',
    views: 791,
    distinctUrls: 640,
    reasonCodes: ['asn_datacenter', 'single_signal_network'],
    ...extra,
  });
  // 5000 classified, non-internal views.
  const day = {
    ...base,
    classification: classification({ views: [3000, 500, 300, 1200] }),
  };

  it('lists the client with every column, above the tables, in both renderings', () => {
    const { text, html } = buildAnalyticsDigest(day, { ...opts, unresolvedClients: [client()] });
    expect(text.indexOf(`== ${TITLE} ==`)).toBeGreaterThan(
      text.indexOf('== Traffic by class (requests) =='),
    );
    expect(text.indexOf(`== ${TITLE} ==`)).toBeLessThan(text.indexOf('== Most viewed products'));
    expect(text).toContain(
      '1. 7484a43e AS14618 AMAZON-AES — 791 views · 15.8% · 640 URLs · asn_datacenter, single_signal_network',
    );
    expect(text).toContain("Each share is of the day's 5000 classified, non-internal requests.");
    expect(text).toContain('This list changes no class, no is_bot value and no network list.');
    expect(html).toContain(TITLE);
    expect(html).toContain('7484a43e AS14618 AMAZON-AES');
    expect(html).toContain('15.8% · 640 URLs · asn_datacenter, single_signal_network');
  });

  it('prints only the hash prefix, and says when a client has no network', () => {
    const { text } = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedClients: [client({ cfAsn: null, asOrganization: null, reasonCodes: [] })],
    });
    expect(text).toContain('7484a43e no ASN — 791 views · 15.8% · 640 URLs · no codes');
    expect(text).not.toContain('7484a43ea');
  });

  it('names a client with no user agent as that, in the row and the alert', () => {
    const { subject, text, html } = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedClients: [client({ userAgentHash: null })],
    });
    expect(text).toContain('1. no user agent AS14618 AMAZON-AES — 791 views');
    expect(html).toContain('no user agent AS14618 AMAZON-AES');
    const sentence =
      "A client with no user agent on AS14618 AMAZON-AES passed 5% of the day's traffic";
    expect(text).toContain(`** ${sentence}`);
    expect(html).toContain(sentence);
    expect(subject).toContain(' · UNRESOLVED CLIENT ABOVE 5%');
  });

  it('shows the 2026-10-23 shape above the alert line, in the subject and the body', () => {
    const { subject, text, html } = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedClients: [client()],
    });
    const sentence =
      "Client 7484a43e on AS14618 AMAZON-AES passed 5% of the day's traffic: 791 of 5000 requests (15.8%).";
    expect(subject).toContain(' · UNRESOLVED CLIENT ABOVE 5%');
    expect(text).toContain(`** ${sentence}`);
    expect(html).toContain(sentence);
  });

  it('keeps the client out of the subject, because PostHog Logs copies the subject', () => {
    const { subject } = buildAnalyticsDigest(day, { ...opts, unresolvedClients: [client()] });
    expect(subject).not.toContain('7484a43e');
    expect(subject).not.toContain('14618');
  });

  it('alerts strictly above the line: exactly 5% does not', () => {
    const at = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedClients: [client({ views: 250 })],
    });
    expect(at.subject).not.toContain('UNRESOLVED CLIENT');
    expect(at.text).not.toContain('passed 5%');
    const above = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedClients: [client({ views: 251 })],
    });
    expect(above.subject).toContain('UNRESOLVED CLIENT ABOVE 5%');
    expect(above.text).toContain('passed 5%');
  });

  it('escapes the holder name in the HTML', () => {
    const { html } = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedClients: [client({ asOrganization: '<b>Evil</b>' })],
    });
    expect(html).not.toContain('<b>Evil</b>');
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
  });

  it('says there were none, which is not the same as a failed read', () => {
    const none = buildAnalyticsDigest(day, { ...opts, unresolvedClients: [] });
    const failed = buildAnalyticsDigest(day, { ...opts, unresolvedClients: null });
    for (const d of [none, failed]) {
      expect(d.text).toContain(`== ${TITLE} ==`);
      expect(d.html).toContain(TITLE);
      expect(d.subject).not.toContain('UNRESOLVED CLIENT');
    }
    expect(none.text).toContain('No Unresolved clients on this day.');
    expect(none.html).toContain('No Unresolved clients on this day.');
    expect(failed.text).toContain('The Unresolved clients could not be read for this day.');
    expect(failed.html).toContain('The Unresolved clients could not be read for this day.');
  });

  it('omits the section and the alert when the day has no classes to divide by', () => {
    for (const c of [null, classification({ version: null })]) {
      const { subject, text, html } = buildAnalyticsDigest(
        { ...base, classification: c },
        { ...opts, unresolvedClients: [client()] },
      );
      expect(text).not.toContain(TITLE);
      expect(html).not.toContain(TITLE);
      expect(subject).not.toContain('UNRESOLVED CLIENT');
    }
  });

  it('gives job_runs counts only, and null for a failed read', () => {
    const detail = unresolvedClientsDetail(day, {
      ...opts,
      unresolvedClients: [client(), client({ userAgentHash: 'b', views: 3 })],
    });
    expect(detail).toEqual({ listed: 2, aboveLine: 1, topViews: 791 });
    expect(unresolvedClientsDetail(day, { ...opts, unresolvedClients: null })).toBeNull();
  });

  it('turns a failed read into null, so one section cannot stop the email', async () => {
    const broken = {
      select: () => {
        throw new Error('D1 down');
      },
    } as unknown as Db;
    await expect(
      readDigestUnresolvedClients(broken, windowsForDay('2026-10-23')),
    ).resolves.toBeNull();
  });
});

describe('buildAnalyticsDigest: the same browser across many networks (AECI-1644)', () => {
  const TITLE = UNRESOLVED_IDENTITIES_TITLE;
  const HASH = '069245a2bbbbbbbbbbbbbbbbbbbbbbbb';
  const identity = (extra: Partial<TopUnresolvedIdentity> = {}): TopUnresolvedIdentity => ({
    userAgentHash: HASH,
    views: 895,
    networks: 389,
    ...extra,
  });
  // 5000 classified, non-internal views.
  const day = {
    ...base,
    classification: classification({ views: [3000, 500, 300, 1200] }),
  };
  const SUFFIX = ' · UNRESOLVED CLIENT ABOVE 5%';

  it('renders the 2026-11-02 shape exactly, after the per-network list', () => {
    // 6130 classified, non-internal views, as on 2026-11-02.
    const nov2 = { ...base, classification: classification({ views: [3000, 500, 630, 2000] }) };
    const { text } = buildAnalyticsDigest(nov2, {
      ...opts,
      unresolvedIdentities: [
        identity(),
        identity({ userAgentHash: 'b1c2d3e4ffff', views: 212, networks: 1 }),
        identity({ userAgentHash: 'c9d8e7f6eeee', views: 140, networks: 37 }),
      ],
    });
    const start = text.indexOf(`== ${TITLE} ==`);
    expect(start).toBeGreaterThan(text.indexOf('== Top Unresolved clients (requests) =='));
    expect(start).toBeLessThan(text.indexOf('== Most viewed products'));
    const section = text.slice(start, text.indexOf('\n\n== Most viewed products'));
    expect(section).toBe(
      [
        `== ${TITLE} ==`,
        'Some programs spread their visits across many home internet connections rented from proxy services. ' +
          'A network here means one internet provider, such as a home broadband company. ' +
          'Counted one network at a time, as in the list above, each part looks small. ' +
          'This list adds up each browser identity across every network it used. ' +
          "Shares are of the day's 6,130 checked visits, leaving out our own traffic.",
        'A browser identity is the browser name and version a visitor reports. ' +
          'Many real people can share a common one, so a high count here is a lead to look into, not a verdict. ' +
          'Nothing is blocked or reclassified because of this list.',
        '',
        "** One browser identity made 895 of the day's 6,130 visits (14.6%), from 389 different networks. " +
          'That usually means one program using rented home connections. ' +
          'To find out what it is and what to do, look up the reference 069245a2 using the steps in POST_LAUNCH_MONITORING.md §3b.',
        '',
        '  1. 895 visits (14.6%) from 389 different networks · reference 069245a2',
        '  2. 212 visits (3.5%) from 1 network · reference b1c2d3e4',
        '  3. 140 visits (2.3%) from 37 different networks · reference c9d8e7f6',
        'Reference: we keep only a scrambled code for each browser name, so this short code is how you look one up. ' +
          'The steps are in POST_LAUNCH_MONITORING.md §3b.',
      ].join('\n'),
    );
  });

  it('uses no classifier jargon in the section', () => {
    const { text } = buildAnalyticsDigest(day, { ...opts, unresolvedIdentities: [identity()] });
    const start = text.indexOf(`== ${TITLE} ==`);
    const section = text.slice(start, text.indexOf('\n\n== Most viewed products'));
    for (const word of ['ASN', 'UA hash', 'user-agent hash', 'asn_', 'unresolved']) {
      expect(section).not.toContain(word);
    }
  });

  it('closes the split case: ten networks at 1% each, the identity at 10% alerts', () => {
    // One hash on ten networks, 50 views each: no pair crosses, the identity does.
    const pairs = Array.from({ length: 10 }, (_, i) => ({
      userAgentHash: HASH,
      cfAsn: 7000 + i,
      asOrganization: `NET-${i}`,
      views: 50,
      distinctUrls: 40,
      reasonCodes: ['no_corroboration'],
    }));
    const pairOnly = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedClients: pairs,
      unresolvedIdentities: [],
    });
    expect(pairOnly.subject).not.toContain('UNRESOLVED CLIENT');

    const both = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedClients: pairs,
      unresolvedIdentities: [identity({ views: 500, networks: 10 })],
    });
    expect(both.subject).toContain(SUFFIX);
    expect(both.text).not.toContain('passed 5%');
    const sentence =
      "One browser identity made 500 of the day's 5,000 visits (10.0%), from 10 different networks.";
    expect(both.text).toContain(`** ${sentence}`);
    expect(both.html).toContain(sentence);
  });

  it('alerts strictly above the line: under and exactly 5% do not', () => {
    for (const views of [249, 250]) {
      const d = buildAnalyticsDigest(day, {
        ...opts,
        unresolvedIdentities: [identity({ views })],
      });
      expect(d.subject).not.toContain('UNRESOLVED CLIENT');
      expect(d.text).not.toContain('One browser identity made');
    }
    const above = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedIdentities: [identity({ views: 251 })],
    });
    expect(above.subject).toContain(SUFFIX);
    expect(above.text).toContain(
      "** One browser identity made 251 of the day's 5,000 visits (5.0%)",
    );
  });

  it('keeps one suffix when both lists cross, and a pair alert alone still sets it', () => {
    const pair: TopUnresolvedClient = {
      userAgentHash: HASH,
      cfAsn: 14618,
      asOrganization: 'AMAZON-AES',
      views: 300,
      distinctUrls: 10,
      reasonCodes: [],
    };
    const pairAlone = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedClients: [pair],
      unresolvedIdentities: [identity({ views: 200 })],
    });
    expect(pairAlone.subject).toContain(SUFFIX);
    const both = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedClients: [pair],
      unresolvedIdentities: [identity()],
    });
    expect(both.subject.split('UNRESOLVED CLIENT').length).toBe(2);
  });

  it('keeps the hash out of the subject, because PostHog Logs copies the subject', () => {
    const { subject } = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedIdentities: [identity()],
    });
    expect(subject).toContain(SUFFIX);
    expect(subject).not.toContain('069245a2');
    expect(subject).not.toContain('389');
  });

  it('says "from 1 network" and drops the rented-connections line for one network', () => {
    const { text } = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedIdentities: [identity({ views: 400, networks: 1 })],
    });
    expect(text).toContain(
      "** One browser identity made 400 of the day's 5,000 visits (8.0%), from 1 network. To find out what it is",
    );
    expect(text).toContain('  1. 400 visits (8.0%) from 1 network · reference 069245a2');
    expect(text).not.toContain('That usually means');
  });

  it('says "from no known network" when every row lacked one', () => {
    const { text } = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedIdentities: [identity({ views: 1, networks: 0 })],
    });
    expect(text).toContain('  1. 1 visit (0.0%) from no known network · reference 069245a2');
  });

  it('prints only the 8-character reference, never the full hash', () => {
    const { text, html } = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedIdentities: [identity()],
    });
    expect(text).not.toContain('069245a2b');
    expect(html).not.toContain('069245a2b');
    expect(html).toContain('Reference 069245a2');
  });

  it('escapes the reference in the HTML', () => {
    const { html } = buildAnalyticsDigest(day, {
      ...opts,
      unresolvedIdentities: [identity({ userAgentHash: '<b>x</b>zzz' })],
    });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('says there were none, which is not the same as a failed read', () => {
    const none = buildAnalyticsDigest(day, { ...opts, unresolvedIdentities: [] });
    const failed = buildAnalyticsDigest(day, { ...opts, unresolvedIdentities: null });
    for (const d of [none, failed]) {
      expect(d.text).toContain(`== ${TITLE} ==`);
      expect(d.html).toContain(TITLE);
      expect(d.subject).not.toContain('UNRESOLVED CLIENT');
    }
    expect(none.text).toContain(UNRESOLVED_IDENTITIES_NONE_NOTE);
    expect(none.html).toContain(UNRESOLVED_IDENTITIES_NONE_NOTE);
    expect(failed.text).toContain(UNRESOLVED_IDENTITIES_UNREAD_NOTE);
    expect(failed.html).toContain(UNRESOLVED_IDENTITIES_UNREAD_NOTE);
  });

  it('omits the section and the alert when the day has no classes to divide by', () => {
    for (const c of [null, classification({ version: null })]) {
      const { subject, text, html } = buildAnalyticsDigest(
        { ...base, classification: c },
        { ...opts, unresolvedIdentities: [identity()] },
      );
      expect(text).not.toContain(TITLE);
      expect(html).not.toContain(TITLE);
      expect(subject).not.toContain('UNRESOLVED CLIENT');
    }
  });

  it('gives job_runs counts only, and null for a failed read', () => {
    const detail = unresolvedIdentitiesDetail(day, {
      ...opts,
      unresolvedIdentities: [identity(), identity({ userAgentHash: 'b', views: 3, networks: 1 })],
    });
    expect(detail).toEqual({ listed: 2, aboveLine: 1, topViews: 895, topNetworks: 389 });
    expect(unresolvedIdentitiesDetail(day, { ...opts, unresolvedIdentities: [] })).toEqual({
      listed: 0,
      aboveLine: 0,
      topViews: 0,
      topNetworks: 0,
    });
    expect(unresolvedIdentitiesDetail(day, { ...opts, unresolvedIdentities: null })).toBeNull();
  });

  it('turns a failed read into null, so one section cannot stop the email', async () => {
    const broken = {
      select: () => {
        throw new Error('D1 down');
      },
    } as unknown as Db;
    await expect(
      readDigestUnresolvedIdentities(broken, windowsForDay('2026-11-02')),
    ).resolves.toBeNull();
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
});

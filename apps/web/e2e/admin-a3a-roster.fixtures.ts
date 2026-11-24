/**
 * AECI-2125: synthetic rows for `/admin/activity`, `/admin/subscribers` and
 * `/admin/catalog`.
 *
 * The local seed has no page views and no subscribers, and its catalog leaves most
 * coverage tables thin. These pages fetch in the browser, so a spec answers those
 * same-origin `GET`s with these rows (`stubA3aRoster`). The SSR gate still needs a
 * real minted admin session (`auth-session.ts`). Every write is refused here, so
 * nothing a spec clicks can reach the local D1.
 *
 * Personal data is fake on purpose: `example.com` addresses and made-up names only.
 * Every row is typed by its `@aeci/shared` contract, so a change to an admin API
 * shape fails this file's typecheck rather than leaving the spec green on stale rows.
 */
import type { Page } from '@playwright/test';

import type {
  AdminCatalogCoverageResponse,
  AdminPageViewRow,
  AdminPageViewsResponse,
  AdminSubscriberRow,
  AdminSubscribersResponse,
  AdminTimeseriesResponse,
  AdminTrafficBreakdownResponse,
  AdminTrafficClass,
} from '@aeci/shared';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-11-24T12:00:00.000Z';
const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(Date.parse(NOW) - hours * HOUR).toISOString();

const WINDOW = { from: '2026-11-18T00:00:00.000Z', to: NOW, timezone: 'UTC' as const, days: 7 };
const NO_FILTER = { available: false, applied: false, asns: [] };

const PROCORE = { id: uuid(9002), name: 'Procore', slug: 'procore' };
const SUMMIT = { id: uuid(9003), name: 'Summit BIM', slug: 'summit-bim' };
const FIELDLINE = { id: uuid(9004), name: 'Fieldline Takeoff', slug: 'fieldline-takeoff' };

// ─── /admin/activity ─────────────────────────────────────────────────────────

function classification(
  cls: AdminTrafficClass,
  reason_codes: string[],
  evidence_complete = true,
): AdminPageViewRow['classification'] {
  return {
    class: cls,
    reason_codes,
    classifier_version: 'd19-v1',
    evaluated_at: ago(2),
    evidence_window: { from: ago(16 * 24), to: ago(1), timezone: 'UTC', days: 16 },
    evidence_complete,
  };
}

function view(id: number, hours: number, over: Partial<AdminPageViewRow>): AdminPageViewRow {
  return {
    id,
    created_at: ago(hours),
    is_bot: false,
    bot_name: null,
    visitor_hash: '365d59e9',
    cf_asn: 7922,
    cf_country: 'US',
    cf_colo: 'IAD',
    path: '/products/:slug',
    entity_type: 'product',
    entity: PROCORE,
    referrer_source: 'Google',
    referrer: 'www.google.com',
    writer_provenance: 'ssr-arrival',
    client_verdict: 'browser',
    asn_registry: {
      asn: 7922,
      info_type: 'Cable/DSL/ISP',
      as_name: 'Comcast',
      network_class: 'eyeball',
      source: 'peeringdb',
      fetched_at: ago(48),
    },
    classification: classification('browser_with_human_evidence', ['app_executed']),
    privacy_signal: false,
    ...over,
  };
}

/** Newest first, over two days, so the day separators show. */
export const PAGE_VIEWS: AdminPageViewRow[] = [
  view(8, 1, { writer_provenance: null, client_verdict: null, classification: null }),
  view(7, 2, {
    visitor_hash: 'a1b2c3d4',
    cf_asn: 16509,
    entity: SUMMIT,
    referrer_source: null,
    referrer: null,
    client_verdict: 'non-browser',
    asn_registry: {
      asn: 16509,
      info_type: 'Content',
      as_name: 'Amazon',
      network_class: 'non_eyeball',
      source: 'peeringdb',
      fetched_at: ago(48),
    },
    classification: classification('suspected_automation', ['asn_datacenter']),
  }),
  view(6, 4, {
    is_bot: true,
    bot_name: 'Googlebot',
    cf_asn: 15169,
    path: '/',
    entity_type: null,
    entity: null,
    referrer_source: null,
    referrer: null,
    client_verdict: 'non-browser',
    asn_registry: null,
    classification: classification('identified_automation', ['verified_edge']),
  }),
  view(5, 6, {
    is_bot: null,
    cf_asn: 174,
    path: '/categories/:slug',
    entity_type: null,
    entity: null,
    referrer_source: 'Direct',
    referrer: null,
    client_verdict: 'inconsistent',
    asn_registry: {
      asn: 174,
      info_type: 'NSP',
      as_name: 'Cogent',
      network_class: 'transit',
      source: 'peeringdb',
      fetched_at: ago(48),
    },
    classification: classification('unresolved', ['evidence_no_asn'], false),
  }),
  view(4, 28, {
    visitor_hash: 'fedcba98',
    entity: FIELDLINE,
    referrer_source: 'LinkedIn',
    referrer: 'www.linkedin.com/feed/update/urn-li-activity-1234567890',
    writer_provenance: 'browser-spa',
  }),
  view(3, 30, {
    visitor_hash: null,
    cf_asn: null,
    cf_colo: null,
    cf_country: 'FR',
    referrer: null,
    asn_registry: null,
    privacy_signal: true,
    classification: classification('unresolved', ['no_corroboration'], false),
  }),
];

function pageViews(): AdminPageViewsResponse {
  return {
    data: PAGE_VIEWS,
    page: 1,
    perPage: 50,
    total: PAGE_VIEWS.length,
    traffic: 'human',
    window: WINDOW,
    generated_at: NOW,
    source: 'live',
    notes: [
      {
        code: 'classification_is_heuristic',
        severity: 'info',
        message: 'Traffic classes are a heuristic judgement about requests.',
      },
    ],
    internal_filter: NO_FILTER,
    window_total: { total: PAGE_VIEWS.length, excluding_internal: null },
    window_visitors: { total: 5, excluding_internal: null },
    window_total_all_classes: null,
    window_visitors_all_classes: null,
  };
}

function breakdown(url: URL): AdminTrafficBreakdownResponse {
  const dimension = (url.searchParams.get('dimension') ?? 'source') as 'source' | 'country';
  const data =
    dimension === 'country'
      ? [
          { key: 'US', label: 'United States', views: 4 },
          { key: 'FR', label: 'France', views: 1 },
        ]
      : [
          { key: 'Google', label: 'Google', views: 3 },
          { key: 'LinkedIn', label: 'LinkedIn', views: 1 },
        ];
  return {
    data: data.map((d) => ({
      ...d,
      ref: null,
      views_excluding_internal: null,
      asn_registry: null,
    })),
    page: 1,
    perPage: 100,
    total: data.length,
    dimension,
    traffic: 'all',
    window: WINDOW,
    generated_at: NOW,
    source: 'live',
    notes: [],
    internal_filter: NO_FILTER,
    window_total: { total: 5, excluding_internal: null },
  };
}

// ─── /admin/subscribers ──────────────────────────────────────────────────────

function subscriber(id: number, over: Partial<AdminSubscriberRow>): AdminSubscriberRow {
  return {
    id,
    email: `person${id}@example.com`,
    created_at: ago(24 * id),
    unsubscribed_at: null,
    status: 'active',
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    referrer: null,
    country: 'US',
    region: 'Colorado',
    city: 'Denver',
    as_organization: 'Example Broadband',
    found_via: null,
    found_via_detail: null,
    ...over,
  };
}

export const SUBSCRIBERS: AdminSubscriberRow[] = [
  subscriber(1, {
    email: 'sam@example.com',
    utm_source: 'newsletter',
    utm_medium: 'email',
    utm_campaign: 'launch',
    found_via: 'ai_tool',
    found_via_detail: 'Asked an assistant for takeoff tools that talk to Procore',
  }),
  subscriber(2, {
    email: 'alex.estimator@example.com',
    referrer: 'https://www.linkedin.com/feed/update/urn-li-activity-1234567890',
    found_via: 'linkedin',
  }),
  subscriber(3, {
    email: 'jordan@example.org',
    status: 'unsubscribed',
    unsubscribed_at: ago(24),
    country: 'GB',
    region: 'England',
    city: 'Leeds',
  }),
  subscriber(4, { email: 'casey@example.net', country: null, region: null, city: null }),
];

function subscribers(): AdminSubscribersResponse {
  return {
    data: SUBSCRIBERS,
    page: 1,
    perPage: 24,
    total: SUBSCRIBERS.length,
    generated_at: NOW,
    source: 'live',
    notes: [],
    subscribers: { active: 3, unsubscribed: 1, total_ever: 4, churn_rate: 0.25 },
  };
}

// ─── /admin/catalog ──────────────────────────────────────────────────────────

export const COVERAGE: AdminCatalogCoverageResponse = {
  generated_at: NOW,
  source: 'live',
  notes: [],
  sample_limit: 5,
  totals: { products: 171, integrations: 496, vendors: 88, claims: 1204, attestations: 37 },
  funnel: {
    stages: [
      { status: 'pending', count: 4 },
      { status: 'ready', count: 2 },
      { status: 'promoted', count: 171 },
      { status: 'retracted', count: 3 },
      { status: 'rejected', count: 1 },
    ],
    total: 181,
    promoted_cohort_only: false,
  },
  research_status: [
    { status: 'pending', count: 6 },
    { status: 'in_progress', count: 2 },
    { status: 'done', count: 160 },
    { status: 'blocked', count: 3 },
  ],
  gaps: [
    {
      key: 'products_without_logo',
      total: 7,
      universe: 171,
      sample: [PROCORE, SUMMIT, FIELDLINE],
      sample_truncated: true,
    },
    {
      key: 'products_without_api_docs',
      total: 2,
      universe: 171,
      sample: [SUMMIT, FIELDLINE],
      sample_truncated: false,
    },
    {
      key: 'products_without_vendor',
      total: 0,
      universe: 171,
      sample: [],
      sample_truncated: false,
    },
    {
      key: 'products_without_trade',
      total: 171,
      universe: 171,
      sample: [],
      sample_truncated: true,
    },
  ],
  taxonomy: [
    {
      facet: 'category',
      counts_what: 'products',
      terms_total: 3,
      terms_used: 2,
      publish_floor: null,
      terms_published: null,
      terms: [
        { id: uuid(9501), slug: 'estimating', name: 'Estimating', count: 41, published: null },
        { id: uuid(9502), slug: 'scheduling', name: 'Scheduling', count: 18, published: null },
        { id: uuid(9503), slug: 'safety', name: 'Safety', count: 0, published: null },
      ],
    },
    {
      facet: 'trade',
      counts_what: 'products',
      terms_total: 2,
      terms_used: 1,
      publish_floor: 3,
      terms_published: 1,
      terms: [
        { id: uuid(9511), slug: 'electrical', name: 'Electrical', count: 5, published: true },
        { id: uuid(9512), slug: 'masonry', name: 'Masonry', count: 0, published: false },
      ],
    },
  ],
  claim_coverage: {
    integrations_total: 496,
    integrations_with_claims: 410,
    integrations_without_claims: 86,
    claims_total: 1204,
    claims_with_active_attestation: 37,
    claims_without_active_attestation: 1167,
    attestations_total: 37,
    integrations_without_claims_sample: [
      { id: uuid(9601), name: null, source_product: PROCORE, target_product: SUMMIT },
      { id: uuid(9602), name: null, source_product: FIELDLINE, target_product: PROCORE },
    ],
    integrations_without_claims_sample_truncated: true,
  },
};

/** One `catalog.*` series over the requested window, with a few non-zero days. */
function timeseries(url: URL): AdminTimeseriesResponse {
  const from = url.searchParams.get('from') ?? '2026-10-26';
  const to = url.searchParams.get('to') ?? '2026-11-24';
  const metric = (url.searchParams.get('metric') ??
    'catalog.products_created') as AdminTimeseriesResponse['metric'];
  const points: AdminTimeseriesResponse['points'] = [];
  for (let d = Date.parse(`${from}T00:00:00Z`), i = 0; d <= Date.parse(`${to}T00:00:00Z`); i++) {
    points.push({
      day: new Date(d).toISOString().slice(0, 10),
      value: i % 4 === 0 ? (i % 3) + 1 : 0,
      value_excluding_internal: null,
      reconstructed: false,
    });
    d += 24 * HOUR;
  }
  return {
    metric,
    interval: 'day',
    basis: 'net',
    window: {
      from: `${from}T00:00:00.000Z`,
      to: `${to}T23:59:59.999Z`,
      timezone: 'UTC',
      days: points.length,
    },
    generated_at: NOW,
    source: 'live',
    notes: [
      {
        code: 'catalog_series_is_surviving_rows',
        severity: 'info',
        message: 'These are the records in the catalog now, counted against the day they arrived.',
      },
    ],
    internal_filter: NO_FILTER,
    points,
    total: { total: points.reduce((a, p) => a + p.value, 0), excluding_internal: null },
  };
}

// ─── The stub ────────────────────────────────────────────────────────────────

/** Each page, and a word that shows once its browser-side fetch has rendered. */
export const A3A_ROSTER_PAGES = [
  { path: '/admin/activity', ready: 'Googlebot' },
  { path: '/admin/subscribers', ready: 'sam@example.com' },
  { path: '/admin/catalog', ready: 'Estimating' },
] as const;

/**
 * Answers the three pages' browser-side reads. Every non-GET to `/api/admin/*` is
 * refused with 403. PostHog is answered locally and any other outside host is
 * aborted.
 */
export async function stubA3aRoster(target: Page): Promise<void> {
  await target.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return route.fallback();
    if (/posthog/.test(host)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
  await target.route(/\/api\/admin\//, (route) => {
    const req = route.request();
    if (req.method() !== 'GET') {
      return route.fulfill({
        status: 403,
        json: { error: { code: 'FORBIDDEN', message: 'e2e stub refuses writes' } },
      });
    }
    const url = new URL(req.url());
    const json = (body: unknown) => route.fulfill({ status: 200, json: body });
    switch (url.pathname) {
      case '/api/admin/page-views':
        return json(pageViews());
      case '/api/admin/traffic/breakdown':
        return json(breakdown(url));
      case '/api/admin/subscribers':
        return json(subscribers());
      case '/api/admin/catalog/coverage':
        return json(COVERAGE);
      case '/api/admin/metrics/timeseries':
        return json(timeseries(url));
      default:
        // Anything else (the shell's summary read) goes to the real local API.
        return route.fallback();
    }
  });
}

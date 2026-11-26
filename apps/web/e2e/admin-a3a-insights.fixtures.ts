/**
 * AECI-2125: synthetic data for `/admin/traffic` and `/admin/audience`.
 *
 * The local seed has no page views, no subscribers and no feedback, so both pages
 * render nothing but empty states. They fetch in the browser, so a spec answers
 * those same-origin `GET`s with these responses (`stubA3aInsights`). The SSR gate
 * still needs a real minted admin session (`auth-session.ts`). Every write is
 * refused here with a 403, so nothing a spec clicks can reach the local D1.
 *
 * Every person here is invented (`@example.com`), and no row comes from
 * production. The breakdowns carry enough rows that the audience charts reach
 * palette slots 3 to 7, which is what the relief rule needs to be seen.
 *
 * Each response is typed by its `@aeci/shared` contract, so a change to an admin
 * API shape fails this file's typecheck rather than leaving the spec green on
 * stale data.
 */
import type { Page } from '@playwright/test';

import type {
  AdminAudienceBreakdownRow,
  AdminAudienceResponse,
  AdminBreakdownDimension,
  AdminBreakdownRow,
  AdminFeedbackResponse,
  AdminMetricKey,
  AdminTimeseriesResponse,
  AdminTrafficBreakdownResponse,
  AdminWindow,
} from '@aeci/shared';

/** Each page, and a word that shows once its browser-side fetch has rendered. */
export const A3A_INSIGHTS_PAGES = [
  { path: '/admin/traffic', ready: 'buildingsmart.org' },
  { path: '/admin/audience', ready: 'A side-by-side comparison' },
] as const;

const GENERATED_AT = '2026-11-24T05:00:00.000Z';
const PRODUCT_A = '00000000-0000-4000-8000-000000009501';
const PRODUCT_B = '00000000-0000-4000-8000-000000009502';

/** The UTC days of a window, oldest first, read from the request's own range so
 *  the page's day axis matches what it asked for. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function windowOf(days: readonly string[]): AdminWindow {
  return {
    from: `${days[0]}T00:00:00.000Z`,
    to: `${days[days.length - 1]}T23:59:59.999Z`,
    timezone: 'UTC',
    days: days.length,
  };
}

const NO_INTERNAL_FILTER = { available: false, applied: false, asns: [] };

/** A deterministic wave, so every run draws the same chart. */
function wave(i: number, base: number, swing: number): number {
  return Math.max(0, Math.round(base + swing * Math.sin(i / 2.3) + ((i * 7) % 5)));
}

function timeseries(metric: AdminMetricKey, days: readonly string[]): AdminTimeseriesResponse {
  const [base, swing] =
    metric === 'traffic.page_views_bot'
      ? [140, 40]
      : metric === 'traffic.unique_visitors'
        ? [36, 9]
        : [92, 24];
  const points = days.map((day, i) => ({
    day,
    value: wave(i, base, swing),
    value_excluding_internal: null,
    reconstructed: false,
  }));
  const total = points.reduce((sum, p) => sum + p.value, 0);
  return {
    metric,
    interval: 'day',
    basis: 'additions',
    window: windowOf(days),
    generated_at: GENERATED_AT,
    source: 'live',
    notes: [],
    internal_filter: NO_INTERNAL_FILTER,
    points,
    total: { total, excluding_internal: null },
  };
}

const row = (
  key: string | null,
  label: string,
  views: number,
  extra: Partial<AdminBreakdownRow> = {},
): AdminBreakdownRow => ({
  key,
  label,
  ref: null,
  views,
  views_excluding_internal: null,
  asn_registry: null,
  ...extra,
});

const BREAKDOWNS: Record<AdminBreakdownDimension, AdminBreakdownRow[]> = {
  source: [
    row('google', 'Google', 1184),
    row('direct', 'Direct', 702),
    row('buildingsmart.org', 'buildingsmart.org', 214),
    row('linkedin', 'LinkedIn', 131),
    row(null, 'Unattributed', 58),
  ],
  path: [
    row('/', '/', 840),
    row('/products/fieldline-takeoff', '/products/fieldline-takeoff', 312),
    row('/categories/estimating', '/categories/estimating', 188),
    row('/vendor-program', '/vendor-program', 97),
  ],
  product: [
    row(PRODUCT_A, 'Fieldline Takeoff', 312, {
      ref: { id: PRODUCT_A, slug: 'fieldline-takeoff', name: 'Fieldline Takeoff' },
    }),
    row(PRODUCT_B, 'Northbeam Schedules', 141, {
      ref: { id: PRODUCT_B, slug: 'northbeam-schedules', name: 'Northbeam Schedules' },
    }),
  ],
  country: [
    row('US', 'United States', 1120),
    row('GB', 'United Kingdom', 402),
    row('AU', 'Australia', 233),
    row('ID', 'Indonesia', 117),
  ],
  bot: [row('Googlebot', 'Googlebot', 2210), row('Bingbot', 'Bingbot', 806)],
  asn: [
    row('7922', 'AS7922', 640, {
      asn_registry: {
        asn: 7922,
        info_type: 'Cable/DSL/ISP',
        as_name: 'Example Cable',
        network_class: 'eyeball',
        source: 'peeringdb',
        fetched_at: GENERATED_AT,
      },
    }),
    row('16509', 'AS16509', 212, {
      asn_registry: {
        asn: 16509,
        info_type: 'Content',
        as_name: 'Example Cloud',
        network_class: 'non_eyeball',
        source: 'peeringdb',
        fetched_at: GENERATED_AT,
      },
    }),
  ],
};

function breakdown(
  dimension: AdminBreakdownDimension,
  days: readonly string[],
): AdminTrafficBreakdownResponse {
  const data = BREAKDOWNS[dimension];
  return {
    data,
    page: 1,
    perPage: 8,
    total: data.length,
    dimension,
    traffic: dimension === 'bot' ? 'bot' : 'human',
    window: windowOf(days),
    generated_at: GENERATED_AT,
    source: 'live',
    notes: [],
    internal_filter: NO_INTERNAL_FILTER,
    window_total: { total: data.reduce((s, r) => s + r.views, 0) + 40, excluding_internal: null },
  };
}

const sub = (
  key: string | null,
  label: string,
  subscribers: number,
): AdminAudienceBreakdownRow => ({
  key,
  label,
  subscribers,
});

function audience(days: readonly string[]): AdminAudienceResponse {
  let active = 112;
  const series = days.map((day, i) => {
    const signups = wave(i, 3, 2);
    const unsubscribes = i % 6 === 0 ? 1 : 0;
    active += signups - unsubscribes;
    return { day, signups, unsubscribes, active_cumulative: active };
  });
  const signups = series.reduce((s, p) => s + p.signups, 0);
  const unsubscribes = series.reduce((s, p) => s + p.unsubscribes, 0);
  return {
    window: windowOf(days),
    generated_at: GENERATED_AT,
    source: 'live',
    notes: [],
    breakdown_limit: 8,
    subscribers: {
      active,
      unsubscribed: 14,
      total_ever: active + 14,
      churn_rate: 14 / (active + 14),
    },
    series,
    window_totals: {
      signups,
      unsubscribes,
      net: signups - unsubscribes,
      active_at_start: 112,
      active_at_end: active,
      churn_rate: unsubscribes / 112,
    },
    utm: {
      source: [
        sub('linkedin', 'linkedin', 41),
        sub('newsletter', 'newsletter', 22),
        sub(null, 'None', 30),
      ],
      medium: [sub('social', 'social', 41), sub('email', 'email', 22)],
      campaign: [sub('launch-2026', 'launch-2026', 38), sub('webinar-nov', 'webinar-nov', 17)],
    },
    geography: {
      country: [
        sub('US', 'United States', 44),
        sub('GB', 'United Kingdom', 21),
        sub('AU', 'Australia', 12),
      ],
      region: [
        sub('CA', 'California', 18),
        sub('ENG', 'England', 17),
        sub('NSW', 'New South Wales', 9),
      ],
      city: [
        sub('sf', 'San Francisco', 11),
        sub('london', 'London', 10),
        sub('sydney', 'Sydney', 6),
      ],
      asn: [sub('7922', 'Example Cable', 25), sub('2856', 'Example Telecom', 13)],
    },
    feedback: { total_ever: 3, in_window: 3 },
    found_via: {
      counts: [
        { channel: 'search', claims: 2, listings: 1, subscribers: 9, feedback: 1, total: 13 },
        { channel: 'ai_tool', claims: 1, listings: 0, subscribers: 4, feedback: 1, total: 6 },
        { channel: 'linkedin', claims: 0, listings: 0, subscribers: 7, feedback: 0, total: 7 },
        { channel: 'colleague', claims: 1, listings: 1, subscribers: 3, feedback: 0, total: 5 },
        { channel: 'vendor', claims: 0, listings: 2, subscribers: 1, feedback: 0, total: 3 },
        { channel: 'event', claims: 0, listings: 0, subscribers: 2, feedback: 0, total: 2 },
        { channel: 'other', claims: 0, listings: 0, subscribers: 1, feedback: 0, total: 1 },
        { channel: null, claims: 3, listings: 1, subscribers: 41, feedback: 1, total: 46 },
      ],
      details: [
        {
          form: 'subscriber',
          id: '901',
          channel: 'ai_tool',
          detail: 'which takeoff tools integrate with our scheduling software',
          created_at: '2026-11-20T09:12:00.000Z',
        },
        {
          form: 'claim',
          id: '00000000-0000-4000-8000-000000009401',
          channel: 'search',
          detail: 'estimating software integrations',
          created_at: '2026-11-18T14:40:00.000Z',
        },
      ],
      details_limit: 100,
    },
  };
}

const FEEDBACK: AdminFeedbackResponse = {
  data: [
    {
      id: 3,
      created_at: '2026-11-22T10:15:00.000Z',
      features: 'A side-by-side comparison of two products and what data each one shares.',
      tools: 'Fieldline Takeoff, Northbeam Schedules',
      email: 'sam@example.com',
      subscribed: true,
      country: 'United States',
      city: 'Denver',
      region: 'Colorado',
      timezone: 'America/Denver',
      referrer: 'https://example.com/blog/aec-tools',
      found_via: 'ai_tool',
      found_via_detail: 'directory of AEC integrations',
    },
    {
      id: 2,
      created_at: '2026-11-19T16:02:00.000Z',
      features: null,
      tools: 'Example CAD, a spreadsheet',
      email: null,
      subscribed: false,
      country: 'United Kingdom',
      city: null,
      region: null,
      timezone: null,
      referrer: null,
      found_via: null,
      found_via_detail: null,
    },
    {
      id: 1,
      created_at: '2026-11-12T08:44:00.000Z',
      features: 'Filter by the trade I work in.',
      tools: null,
      email: 'alex@example.com',
      subscribed: false,
      country: null,
      city: null,
      region: null,
      timezone: null,
      referrer: null,
      found_via: 'search',
      found_via_detail: null,
    },
  ],
  page: 1,
  perPage: 10,
  total: 3,
  generated_at: GENERATED_AT,
  source: 'live',
  notes: [],
};

/** Answers the two pages' browser-side reads, refuses every write with a 403, and
 *  keeps every off-site request (PostHog included) off the network. */
export async function stubA3aInsights(target: Page): Promise<void> {
  await target.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return route.fallback();
    if (/posthog/.test(host)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
  await target.route(
    /\/api\/admin\/(metrics\/timeseries|traffic\/breakdown|audience|feedback)(\/|\?|$)/,
    (route) => {
      const req = route.request();
      if (req.method() !== 'GET') {
        return route.fulfill({
          status: 403,
          json: { error: { code: 'E2E_STUB', message: 'writes are refused in this spec' } },
        });
      }
      const url = new URL(req.url());
      const today = new Date().toISOString().slice(0, 10);
      const days = daysBetween(
        url.searchParams.get('from') ?? today,
        url.searchParams.get('to') ?? today,
      );
      const json = (body: unknown) => route.fulfill({ status: 200, json: body });
      switch (url.pathname) {
        case '/api/admin/metrics/timeseries':
          return json(timeseries(url.searchParams.get('metric') as AdminMetricKey, days));
        case '/api/admin/traffic/breakdown':
          return json(
            breakdown(url.searchParams.get('dimension') as AdminBreakdownDimension, days),
          );
        case '/api/admin/audience': {
          // The audience read sends no from/to when it uses its default window.
          return json(audience(days.length > 1 ? days : daysBetween(lastDays(90), today)));
        }
        case '/api/admin/feedback':
          return json(FEEDBACK);
        default:
          return route.fulfill({
            status: 404,
            json: { error: { code: 'NOT_FOUND', message: 'stub' } },
          });
      }
    },
  );
}

/** The UTC day `n - 1` days before today, so a window of `n` days ends today. */
function lastDays(n: number): string {
  return new Date(Date.now() - (n - 1) * 86_400_000).toISOString().slice(0, 10);
}

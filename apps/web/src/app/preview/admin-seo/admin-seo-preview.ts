import { Component, Injectable } from '@angular/core';

import type {
  AdminNote,
  SeoEngine,
  SeoQueueItem,
  SeoQueueQuery,
  SeoQueueResponse,
  SeoTrendResponse,
  SeoTrendWeek,
} from '@aeci/shared';

import { AdminSeoApi } from '../../admin/seo/admin-seo.api';
import { SeoPage } from '../../admin/seo/seo-page';
import { SeoQueuePanel } from '../../admin/seo/seo-queue-panel';
import { SeoTrendPanel } from '../../admin/seo/seo-trend-panel';

/**
 * AECI-822. `/admin/seo` over component-provided fakes of {@link AdminSeoApi},
 * so the screen can be reviewed, axe-scanned and `impeccable detect`-ed without
 * an admin session. Same arrangement as `/preview/admin-activity`.
 *
 * Dev-only, like every `/preview` route: blocked on the public tiers by the SSR
 * Worker (`isPreviewPath`). The main screen holds every normal state: three
 * lanes with rows, a Google lane that pages, rows never fetched and rows
 * undated, five "Not recorded" weeks, a "None" week, a week with no pages
 * published and an open cohort. Below it, a gallery renders the states one
 * screen cannot show at once: every lane empty, no public site address, and
 * each panel's failed load.
 */
const GENERATED = '2027-01-12T09:00:00.000Z';
const BASE = 'https://www.aecintegrations.com';
const DAY = 86_400_000;

const SLUGS = [
  ['products/bluebeam-revu', 'product'],
  ['vendors/trimble', 'vendor'],
  ['products/archicad/integrations/bimcloud', 'pair'],
  ['products/sage-300-cre', 'product'],
  ['products/procore/integrations/sage-intacct', 'pair'],
  ['vendors/nemetschek', 'vendor'],
  ['products/hcss-heavyjob', 'product'],
  ['products/autodesk-docs/integrations/egnyte', 'pair'],
  ['products/raken', 'product'],
  ['products/fieldwire/integrations/procore', 'pair'],
] as const;

const TAXONOMY = [
  ['categories/estimating', 'category'],
  ['phases/closeout', 'phase'],
  ['trades/mechanical', 'trade'],
] as const;

function iso(daysBefore: number): string {
  return new Date(Date.parse(GENERATED) - daysBefore * DAY).toISOString();
}

/** A deterministic list of `total` URLs, oldest first, undated pages last. */
function buildItems(total: number, engine: SeoEngine): SeoQueueItem[] {
  const items: SeoQueueItem[] = [];
  const dated = total - TAXONOMY.length;
  for (let i = 0; i < dated; i++) {
    const [slug, type] = SLUGS[i % SLUGS.length]!;
    const suffix = i < SLUGS.length ? '' : `-${Math.floor(i / SLUGS.length)}`;
    const age = 144 - Math.floor(i / 3);
    const fetched = (i + (engine === 'bing' ? 1 : 0)) % 3 === 1;
    items.push({
      url: `${BASE}/${slug}${suffix}`,
      page_type: type,
      published_at: iso(age),
      age_days: age,
      last_fetch_at: fetched ? iso(Math.max(30, age - 70)) : null,
    });
  }
  for (const [slug, type] of TAXONOMY) {
    items.push({
      url: `${BASE}/${slug}`,
      page_type: type,
      published_at: null,
      age_days: null,
      last_fetch_at: null,
    });
  }
  return items;
}

const QUEUE_NOTES: AdminNote[] = [
  {
    code: 'crawl_coverage_is_gateway_arrivals',
    severity: 'info',
    message: 'Crawl coverage counts gateway arrival rows.',
  },
  {
    code: 'crawler_label_includes_inspection_tool',
    severity: 'info',
    message: 'The Googlebot label includes Google-InspectionTool.',
  },
];

const WINDOW = { from: iso(28), to: GENERATED, timezone: 'UTC' as const, days: 28 };

const LANE_TOTALS: Record<SeoEngine, number> = { google: 412, bing: 96 };

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewAdminSeoApi extends AdminSeoApi {
  override async queue(query: Partial<SeoQueueQuery> = {}): Promise<SeoQueueResponse> {
    const engine = query.engine ?? 'google';
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 25;
    const all = buildItems(LANE_TOTALS[engine], engine);
    return {
      generated_at: GENERATED,
      window: WINDOW,
      lanes: [
        {
          lane: 'reindex',
          engine: 'google',
          count: 37,
          oldest_tier12_age_days: 3.2,
          href: '/admin/reindex',
        },
        {
          lane: 'uncrawled',
          engine: 'google',
          count: LANE_TOTALS.google,
          oldest_tier12_age_days: null,
          href: null,
        },
        {
          lane: 'uncrawled',
          engine: 'bing',
          count: LANE_TOTALS.bing,
          oldest_tier12_age_days: null,
          href: null,
        },
      ],
      items: {
        lane: 'uncrawled',
        engine,
        data: all.slice((page - 1) * perPage, page * perPage),
        page,
        perPage,
        total: all.length,
      },
      notes: QUEUE_NOTES,
    };
  }

  override async trend(): Promise<SeoTrendResponse> {
    return { generated_at: GENERATED, weeks: TREND_WEEKS, notes: QUEUE_NOTES };
  }
}

/** Oldest first here for readability. The fake returns them newest first, as
 *  the API does. */
const OLDEST_FIRST: Array<{
  start: string;
  published: number;
  google: number;
  bing: number;
  lanes: [number, number | 'none', number, number, number] | null;
  requests: number;
}> = [
  { start: '2026-10-19', published: 22, google: 5, bing: 14, lanes: null, requests: 0 },
  { start: '2026-10-26', published: 9, google: 3, bing: 7, lanes: null, requests: 0 },
  { start: '2026-11-02', published: 14, google: 4, bing: 10, lanes: null, requests: 3 },
  { start: '2026-11-09', published: 31, google: 11, bing: 24, lanes: null, requests: 11 },
  { start: '2026-11-16', published: 6, google: 3, bing: 5, lanes: null, requests: 7 },
  {
    start: '2026-11-23',
    published: 18,
    google: 7,
    bing: 15,
    lanes: [58, 9.1, 498, 140, 862],
    requests: 9,
  },
  {
    start: '2026-11-30',
    published: 12,
    google: 6,
    bing: 11,
    lanes: [49, 6.4, 481, 131, 866],
    requests: 14,
  },
  {
    start: '2026-12-07',
    published: 27,
    google: 12,
    bing: 23,
    lanes: [61, 4, 466, 122, 871],
    requests: 12,
  },
  {
    start: '2026-12-14',
    published: 8,
    google: 5,
    bing: 7,
    lanes: [44, 2.2, 455, 118, 874],
    requests: 6,
  },
  {
    start: '2026-12-21',
    published: 3,
    google: 2,
    bing: 3,
    lanes: [12, 'none', 440, 104, 876],
    requests: 0,
  },
  {
    start: '2026-12-28',
    published: 0,
    google: 0,
    bing: 0,
    lanes: [30, 1.5, 431, 99, 880],
    requests: 2,
  },
  {
    start: '2027-01-04',
    published: 15,
    google: 4,
    bing: 9,
    lanes: [41, 3, 418, 93, 883],
    requests: 9,
  },
];

const rate = (crawled: number, published: number): number | null =>
  published === 0 ? null : Math.round((crawled / published) * 10_000) / 10_000;

const TREND_WEEKS: SeoTrendWeek[] = OLDEST_FIRST.map((w, i) => ({
  week_start: w.start,
  lanes: w.lanes
    ? {
        reindex_pending: w.lanes[0],
        reindex_oldest_tier12_age_days: w.lanes[1],
        uncrawled_google: w.lanes[2],
        uncrawled_bing: w.lanes[3],
        pairs_without_reviews: w.lanes[4],
      }
    : {
        reindex_pending: null,
        reindex_oldest_tier12_age_days: null,
        uncrawled_google: null,
        uncrawled_bing: null,
        pairs_without_reviews: null,
      },
  cohort: {
    published: w.published,
    crawled_within_days: 7,
    open: i === OLDEST_FIRST.length - 1,
    google: { crawled: w.google, rate: rate(w.google, w.published) },
    bing: { crawled: w.bing, rate: rate(w.bing, w.published) },
  },
  requests_self_reported: w.requests,
})).reverse();

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class EmptyAdminSeoApi extends AdminSeoApi {
  override async queue(): Promise<SeoQueueResponse> {
    return {
      generated_at: GENERATED,
      window: WINDOW,
      lanes: [
        {
          lane: 'reindex',
          engine: 'google',
          count: 0,
          oldest_tier12_age_days: null,
          href: '/admin/reindex',
        },
        { lane: 'uncrawled', engine: 'google', count: 0, oldest_tier12_age_days: null, href: null },
        { lane: 'uncrawled', engine: 'bing', count: 0, oldest_tier12_age_days: null, href: null },
      ],
      items: { lane: 'uncrawled', engine: 'google', data: [], page: 1, perPage: 25, total: 0 },
      notes: QUEUE_NOTES,
    };
  }
}

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class UnsetAdminSeoApi extends AdminSeoApi {
  override async queue(): Promise<SeoQueueResponse> {
    return {
      generated_at: GENERATED,
      window: WINDOW,
      lanes: [],
      items: { lane: 'uncrawled', engine: 'google', data: [], page: 1, perPage: 25, total: 0 },
      notes: [
        {
          code: 'public_site_url_unset',
          severity: 'warn',
          message: 'PUBLIC_SITE_URL is unset.',
        },
      ],
    };
  }
}

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class FailingAdminSeoApi extends AdminSeoApi {
  override async queue(): Promise<SeoQueueResponse> {
    throw new Error('preview: failed load');
  }

  override async trend(): Promise<SeoTrendResponse> {
    throw new Error('preview: failed load');
  }
}

@Component({
  selector: 'app-admin-seo-preview-empty',
  imports: [SeoQueuePanel],
  providers: [{ provide: AdminSeoApi, useClass: EmptyAdminSeoApi }],
  template: `<aec-seo-queue-panel idPrefix="preview-empty" />`,
})
class EmptyQueueState {}

@Component({
  selector: 'app-admin-seo-preview-unset',
  imports: [SeoQueuePanel],
  providers: [{ provide: AdminSeoApi, useClass: UnsetAdminSeoApi }],
  template: `<aec-seo-queue-panel idPrefix="preview-unset" />`,
})
class UnsetQueueState {}

@Component({
  selector: 'app-admin-seo-preview-failed',
  imports: [SeoQueuePanel, SeoTrendPanel],
  providers: [{ provide: AdminSeoApi, useClass: FailingAdminSeoApi }],
  template: `
    <div class="grid gap-10 lg:grid-cols-2">
      <aec-seo-queue-panel idPrefix="preview-failed" />
      <aec-seo-trend-panel idPrefix="preview-failed" />
    </div>
  `,
})
class FailedState {}

@Component({
  selector: 'app-admin-seo-preview',
  imports: [SeoPage, EmptyQueueState, UnsetQueueState, FailedState],
  providers: [{ provide: AdminSeoApi, useClass: PreviewAdminSeoApi }],
  host: { class: 'aec-charts block' },
  template: `
    <div class="mx-auto max-w-7xl px-6 py-10">
      <h1 class="mb-6 text-2xl font-bold text-(--text-primary)" i18n="@@preview.adminSeo.heading">
        Admin: search console (preview)
      </h1>
      <aec-seo-page />

      <h2
        class="mt-16 border-t border-(--border-default) pt-10 text-xl font-bold text-(--text-primary)"
        i18n="@@preview.adminSeo.states"
      >
        Other states
      </h2>
      <div class="mt-8 space-y-14">
        <app-admin-seo-preview-empty />
        <app-admin-seo-preview-unset />
        <app-admin-seo-preview-failed />
      </div>
    </div>
  `,
})
export class AdminSeoPreview {}

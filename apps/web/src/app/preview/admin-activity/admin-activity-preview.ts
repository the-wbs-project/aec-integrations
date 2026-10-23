import { Component, Injectable } from '@angular/core';

import {
  ADMIN_PAGE_VIEW_NULL_FILTER,
  type AdminPageViewRow,
  type AdminPageViewsQuery,
  type AdminPageViewsResponse,
  type AdminTrafficBreakdownResponse,
  type AdminTrafficClass,
} from '@aeci/shared';

import { ActivityFeed } from '../../admin/activity/activity-feed';
import { AdminPageViewsApi } from '../../admin/activity/admin-page-views-api';

/**
 * AECI-1461 — `/admin/activity` over a component-provided fake of
 * {@link AdminPageViewsApi}, so the Class column, the class filter and the
 * all-classes figure can be reviewed, axe-scanned and `impeccable detect`-ed
 * without an admin session. Same arrangement as `/preview/admin-email`.
 *
 * Dev-only, like every `/preview` route: blocked on the public tiers by the SSR
 * Worker (`isPreviewPath`). The fixture holds one row per class, one row with
 * incomplete evidence, one row no classifier run has reached and one privacy-signal
 * row. The class filter is applied in memory, so the all-classes line and the
 * no-match state are reachable.
 */
const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();

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

function row(id: number, hours: number, over: Partial<AdminPageViewRow>): AdminPageViewRow {
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
    entity: { id: '00000000-0000-4000-8000-000000000001', name: 'Procore', slug: 'procore' },
    referrer_source: 'Google',
    referrer: 'www.google.com',
    writer_provenance: 'ssr-arrival',
    client_verdict: 'browser',
    asn_registry: null,
    classification: null,
    privacy_signal: false,
    ...over,
  };
}

/** Newest first, as the API orders them. */
const ROWS: AdminPageViewRow[] = [
  // A row the nightly classifier has not reached yet.
  row(7, 0.2, { writer_provenance: null, client_verdict: null }),
  row(6, 1, {
    classification: classification('browser_with_human_evidence', [
      'app_executed',
      'search_referred',
    ]),
  }),
  row(5, 3, {
    visitor_hash: 'a1b2c3d4',
    cf_asn: 16509,
    path: '/vendors/:slug',
    entity_type: 'vendor',
    entity: {
      id: '00000000-0000-4000-8000-000000000009',
      name: 'Autodesk, Inc.',
      slug: 'autodesk',
    },
    referrer_source: null,
    referrer: null,
    client_verdict: 'non-browser',
    classification: classification('suspected_automation', [
      'asn_datacenter',
      'verdict_non_browser',
    ]),
  }),
  row(4, 5, {
    is_bot: true,
    bot_name: 'Googlebot',
    cf_asn: 15169,
    path: '/',
    entity_type: null,
    entity: null,
    referrer_source: null,
    referrer: null,
    writer_provenance: 'ssr-arrival',
    client_verdict: 'non-browser',
    classification: classification('identified_automation', ['verified_edge', 'purpose_indexing']),
  }),
  row(3, 8, {
    cf_asn: null,
    cf_country: null,
    cf_colo: null,
    path: '/categories/:slug',
    entity_type: null,
    entity: null,
    referrer_source: 'Direct',
    referrer: null,
    client_verdict: 'unknown',
    classification: classification('unresolved', ['evidence_no_asn'], false),
  }),
  row(2, 26, {
    visitor_hash: 'fedcba98',
    referrer_source: 'LinkedIn',
    referrer: 'www.linkedin.com',
    writer_provenance: 'browser-spa',
    classification: classification('unresolved', ['no_corroboration']),
  }),
  // A DNT/GPC counter row (AECI-1386): no hash, network, colo or referrer host.
  row(1, 30, {
    visitor_hash: null,
    cf_asn: null,
    cf_colo: null,
    cf_country: 'FR',
    referrer: null,
    privacy_signal: true,
    classification: classification(
      'unresolved',
      ['no_corroboration', 'evidence_privacy_signal'],
      false,
    ),
  }),
];

const classOf = (r: AdminPageViewRow): string =>
  r.classification?.class ?? ADMIN_PAGE_VIEW_NULL_FILTER;

const visitors = (rows: readonly AdminPageViewRow[]): number =>
  new Set(rows.map((r) => `${r.visitor_hash}|${r.cf_asn}`)).size;

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewAdminPageViewsApi extends AdminPageViewsApi {
  override async listPageViews(
    query: Partial<AdminPageViewsQuery>,
  ): Promise<AdminPageViewsResponse> {
    const population = ROWS.filter((r) =>
      query.traffic === 'bot' ? r.is_bot === true : query.traffic === 'all' ? true : !r.is_bot,
    );
    const rows = query.class ? population.filter((r) => classOf(r) === query.class) : population;
    const now = new Date();
    return {
      data: rows,
      page: 1,
      perPage: 50,
      total: rows.length,
      traffic: query.traffic ?? 'human',
      window: {
        from: `${query.from ?? now.toISOString().slice(0, 10)}T00:00:00.000Z`,
        to: now.toISOString(),
        timezone: 'UTC',
        days: 7,
      },
      generated_at: now.toISOString(),
      source: 'live',
      notes: [
        {
          code: 'classification_is_heuristic',
          severity: 'info',
          message: 'Traffic classes are a heuristic judgement about requests.',
        },
      ],
      internal_filter: { available: false, applied: false, asns: [] },
      window_total: { total: rows.length, excluding_internal: null },
      window_visitors: { total: visitors(rows), excluding_internal: null },
      window_total_all_classes: query.class
        ? { total: population.length, excluding_internal: null }
        : null,
      window_visitors_all_classes: query.class
        ? { total: visitors(population), excluding_internal: null }
        : null,
    };
  }

  override async listFilterOptions(
    dimension: 'source' | 'country',
    from: string,
    to: string,
  ): Promise<AdminTrafficBreakdownResponse> {
    return {
      data: [],
      page: 1,
      perPage: 100,
      total: 0,
      dimension,
      traffic: 'all',
      window: { from, to, timezone: 'UTC', days: 7 },
      generated_at: new Date().toISOString(),
      source: 'live',
      notes: [],
      internal_filter: { available: false, applied: false, asns: [] },
      window_total: { total: 0, excluding_internal: null },
    };
  }
}

@Component({
  selector: 'app-admin-activity-preview',
  imports: [ActivityFeed],
  providers: [{ provide: AdminPageViewsApi, useClass: PreviewAdminPageViewsApi }],
  template: `
    <div class="mx-auto max-w-7xl px-6 py-10">
      <h1
        class="mb-6 text-2xl font-bold text-(--text-primary)"
        i18n="@@preview.adminActivity.heading"
      >
        Admin: activity (preview)
      </h1>
      <aec-activity-feed />
    </div>
  `,
})
export class AdminActivityPreview {}

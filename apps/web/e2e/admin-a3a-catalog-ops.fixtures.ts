/**
 * AECI-2125: synthetic rows for `/admin/connectors`, `/admin/connectors/:id` and
 * `/admin/reindex` (the worklist and its submission history).
 *
 * These pages fetch their lists in the browser, so a spec answers those same-origin
 * `GET`s with these rows (`stubA3aCatalogOps`). The SSR gate still needs a real
 * minted admin session (`auth-session.ts`). Every other method is refused with 403,
 * so nothing a spec clicks can hand a lane over, save a mapping, clear a re-index row,
 * write Algolia, promote or send mail.
 *
 * Every row is typed by its `@aeci/shared` contract, so a change to an admin API shape
 * fails this file's typecheck rather than leaving the spec green on stale rows.
 */
import type { Page } from '@playwright/test';

import type {
  AdminConnectorAuditResponse,
  AdminConnectorCatalogDetail,
  AdminConnectorCatalogRow,
  AdminConnectorCounts,
  AdminConnectorEvidencedPairRow,
  AdminConnectorReachablePairRow,
  AdminConnectorStubRow,
  ListReindexQueueResponse,
  ListReindexSubmissionsResponse,
  PaginatedResponse,
} from '@aeci/shared';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The vendor-managed catalogue the detail page opens, so its mapping Edit renders. */
export const A3A_CONNECTOR_ID = 'conn-a3a-mindcloud';

const MINDCLOUD = { id: uuid(9501), name: 'MindCloud', slug: 'mindcloud' };
const AGAVE = { id: uuid(9502), name: 'Agave', slug: 'agave' };
const WORKATO = { id: uuid(9503), name: 'Workato', slug: 'workato' };
const PROCORE = { id: uuid(9504), name: 'Procore', slug: 'procore' };
const AUTODESK_BUILD = { id: uuid(9505), name: 'Autodesk Build', slug: 'autodesk-build' };
const SAGE = { id: uuid(9506), name: 'Sage Intacct', slug: 'sage-intacct' };
const MINDCLOUD_VENDOR = { id: uuid(9511), name: 'MindCloud Inc.', slug: 'mindcloud-inc' };

const COUNTS: AdminConnectorCounts = {
  surfaces: 2,
  stubs_total: 184,
  stubs_removed: 3,
  stubs_undecided: 41,
  mappings_mapped: 96,
  mappings_ruled_out: 12,
  mappings_out_of_scope: 22,
  mappings_no_record: 9,
  mappings_ambiguous_parked: 4,
  mappings_publishable: 88,
  pairs_curated: 14,
  pairs_generated: 220,
  pairs_derived: 0,
  pairs_unknown: 6,
  evidenced_pairs: 2,
};

function catalogRow(
  over: Partial<AdminConnectorCatalogRow> & Pick<AdminConnectorCatalogRow, 'id'>,
): AdminConnectorCatalogRow {
  return {
    connector_product: MINDCLOUD,
    connector_authorship: 'platform',
    managed_by: 'review',
    notes: null,
    last_ingested_at: '2026-11-23T02:00:00.000Z',
    counts: COUNTS,
    updated_at: '2026-11-23T02:05:00.000Z',
    ...over,
  };
}

export const CONNECTOR_CATALOGS: AdminConnectorCatalogRow[] = [
  catalogRow({ id: A3A_CONNECTOR_ID, managed_by: 'vendor' }),
  catalogRow({
    id: 'conn-a3a-agave',
    connector_product: AGAVE,
    connector_authorship: 'partner',
    counts: { ...COUNTS, stubs_total: 62, stubs_undecided: 0, mappings_publishable: 51 },
  }),
  catalogRow({
    id: 'conn-a3a-workato',
    connector_product: WORKATO,
    connector_authorship: 'mixed',
    last_ingested_at: null,
    counts: { ...COUNTS, stubs_total: 0, stubs_undecided: 0, mappings_publishable: 0 },
  }),
];

export const CONNECTOR_DETAIL: AdminConnectorCatalogDetail = {
  ...catalogRow({ id: A3A_CONNECTOR_ID, managed_by: 'vendor', notes: 'Feed moved to v2.' }),
  surfaces: [
    {
      id: 'surf-a3a-1',
      surface_role: 'apps',
      index_kind: 'sitemap',
      index_url: 'https://example.com/mindcloud/apps.xml',
      last_ingested_at: '2026-11-23T02:00:00.000Z',
      notes: null,
    },
    {
      id: 'surf-a3a-2',
      surface_role: 'pairs',
      index_kind: null,
      index_url: null,
      last_ingested_at: null,
      notes: null,
    },
  ],
  handover: {
    vendor: MINDCLOUD_VENDOR,
    reason: 'Partnership track',
    actor: { id: uuid(9599), display_name: 'Local Admin', email: null },
    at: '2026-11-20T10:00:00.000Z',
  },
  advisories: [],
  actor_emails_available: true,
};

function stub(over: Partial<AdminConnectorStubRow> & Pick<AdminConnectorStubRow, 'id'>) {
  const row: AdminConnectorStubRow = {
    slug: 'procore',
    label: 'Procore',
    url: 'https://example.com/mindcloud/procore',
    direction_role: 'both',
    action_count: null,
    actions_fetched: false,
    actions_fetched_at: null,
    first_seen_at: '2026-07-01T00:00:00.000Z',
    last_seen_at: '2026-11-22T00:00:00.000Z',
    removed_at: null,
    mappings: [],
    ...over,
  };
  return row;
}

export const CONNECTOR_STUBS: AdminConnectorStubRow[] = [
  stub({
    id: 'stub-a3a-1',
    action_count: 14,
    actions_fetched: true,
    actions_fetched_at: '2026-11-01T00:00:00.000Z',
    mappings: [
      {
        id: 'map-a3a-1',
        status: 'mapped',
        product: PROCORE,
        confidence: 'high',
        evidence_url: null,
        decided_by: 'auto-name-match',
        decided_at: '2026-11-02T00:00:00.000Z',
        checked_at: null,
        notes: null,
        publishable: true,
      },
    ],
  }),
  stub({
    id: 'stub-a3a-2',
    slug: 'acc',
    label: 'Autodesk Construction Cloud',
    mappings: [
      {
        id: 'map-a3a-2',
        status: 'ambiguous_parked',
        product: null,
        confidence: null,
        evidence_url: null,
        decided_by: 'operator',
        decided_at: '2026-11-03T00:00:00.000Z',
        checked_at: null,
        notes: null,
        publishable: false,
      },
    ],
  }),
  stub({
    id: 'stub-a3a-3',
    slug: 'legacy-erp',
    label: 'Legacy ERP',
    url: null,
    removed_at: '2026-11-10T00:00:00.000Z',
  }),
];

const REACHABLE: AdminConnectorReachablePairRow[] = [
  {
    id: 'pair-a3a-1',
    surface: 'curated',
    side_a: {
      stub_id: 'stub-a3a-1',
      slug: 'procore',
      label: 'Procore',
      product: PROCORE,
      publishable: true,
    },
    side_b: {
      stub_id: 'stub-a3a-4',
      slug: 'sage-intacct',
      label: 'Sage Intacct',
      product: SAGE,
      publishable: false,
    },
    url_a_to_b: null,
    url_b_to_a: null,
    classified_at: null,
    first_seen_at: '2026-07-01T00:00:00.000Z',
    last_seen_at: '2026-11-22T00:00:00.000Z',
    removed_at: null,
  },
];

const EVIDENCED: AdminConnectorEvidencedPairRow[] = [
  {
    id: uuid(9601),
    product_a: PROCORE,
    product_b: AUTODESK_BUILD,
    name: null,
    built_by_vendor: MINDCLOUD_VENDOR,
    mechanism_name: null,
    direction: 'both',
    listing_url: null,
    last_reviewed_at: '2026-11-15T00:00:00.000Z',
    maintained_by: 'aeci',
  },
];

const CONNECTOR_AUDIT: AdminConnectorAuditResponse = {
  data: [],
  page: 1,
  perPage: 25,
  total: 0,
  actor_emails_available: true,
};

export const REINDEX_QUEUE: ListReindexQueueResponse = {
  data: [
    {
      id: 9701,
      url: 'https://www.aecintegrations.com/products/procore',
      priority: 1,
      reason: 'product.updated',
      source: 'promote',
      queued_at: '2026-11-21T09:00:00.000Z',
      last_changed_at: '2026-11-21T08:59:00.000Z',
      inspected_at: '2026-11-22T05:00:00.000Z',
      last_crawl_at: '2026-11-10T00:00:00Z',
      inspect_reason: 'crawl_predates_change',
    },
    {
      id: 9702,
      url: 'https://www.aecintegrations.com/vendors/mindcloud-inc',
      priority: 3,
      reason: 'vendor.minor',
      source: 'vendor',
      queued_at: '2026-11-23T09:00:00.000Z',
      last_changed_at: null,
      inspected_at: null,
      last_crawl_at: null,
      inspect_reason: null,
    },
  ],
  page: 1,
  perPage: 25,
  total: 2,
};

export const REINDEX_SUBMISSIONS: ListReindexSubmissionsResponse = {
  data: [
    {
      id: 9801,
      url: 'https://www.aecintegrations.com/products/autodesk-build',
      channel: 'indexnow',
      outcome: 'accepted',
      http_status: 200,
      priority: 1,
      submitted_at: '2026-11-22T03:00:00.000Z',
      causes: [
        {
          source: 'vendor',
          audit_log_id: uuid(9811),
          action: 'product.update',
          vendor: { id: MINDCLOUD_VENDOR.id, slug: MINDCLOUD_VENDOR.slug, name: 'MindCloud Inc.' },
          product: { id: AUTODESK_BUILD.id, slug: AUTODESK_BUILD.slug, name: 'Autodesk Build' },
          promote_job_id: null,
          queued_at: '2026-11-21T03:00:00.000Z',
        },
      ],
    },
    {
      id: 9802,
      url: 'https://www.aecintegrations.com/products/procore',
      channel: 'indexnow',
      outcome: 'refused',
      http_status: 429,
      priority: 2,
      submitted_at: '2026-11-21T03:00:00.000Z',
      causes: [],
    },
    {
      id: 9803,
      url: 'https://www.aecintegrations.com/vendors/mindcloud-inc',
      channel: 'gsc_manual',
      outcome: 'requested',
      http_status: null,
      priority: null,
      submitted_at: '2026-11-20T03:00:00.000Z',
      causes: [
        {
          source: 'promote',
          audit_log_id: null,
          action: null,
          vendor: null,
          product: null,
          promote_job_id: 'job-a3a-1',
          queued_at: '2026-11-19T03:00:00.000Z',
        },
      ],
    },
  ],
  page: 1,
  perPage: 25,
  total: 3,
};

/** Each page, and a word that shows once its browser-side fetch has rendered. */
export const A3A_CATALOG_OPS_PAGES = [
  { path: '/admin/connectors', ready: 'Agave' },
  { path: `/admin/connectors/${A3A_CONNECTOR_ID}`, ready: 'Autodesk Construction Cloud' },
  { path: '/admin/reindex', ready: 'mindcloud-inc' },
] as const;

/**
 * The buttons that open each inline form on these pages, by accessible name, so an
 * axe pass can check the page with its forms open. Every write behind them is
 * refused by the stub. The Done button opens the dialog; open one at a time and
 * close it (Escape) before the next.
 */
export const A3A_FORM_OPENERS = {
  [`/admin/connectors/${A3A_CONNECTOR_ID}`]: [/^Take the lane back$/, /^Edit mapping for Procore$/],
  '/admin/reindex': [/^Done$/],
} as const satisfies Record<string, readonly RegExp[]>;

/** Click every opener named for `path` (first match each). Dialog openers last. */
export async function openA3aForms(target: Page, path: string): Promise<void> {
  const openers = (A3A_FORM_OPENERS as Record<string, readonly RegExp[]>)[path] ?? [];
  for (const name of openers) {
    await target.getByRole('button', { name }).first().click();
  }
}

function page<T>(data: T[], total = data.length): PaginatedResponse<T> {
  return { data, page: 1, perPage: 25, total };
}

/**
 * Answer the three pages' browser-side reads with the rows above, and refuse every
 * other method (403), so a click can never change the local D1, reindex, write
 * Algolia, promote or send mail. PostHog is answered locally and any other outside
 * host is aborted.
 */
export async function stubA3aCatalogOps(target: Page): Promise<void> {
  await target.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return route.fallback();
    if (/posthog/.test(host)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
  await target.route(
    /\/api\/admin\/(connector-catalogs|connector-stub-mappings|reindex|vendors)(\/|\?|$)/,
    (route) => {
      const req = route.request();
      if (req.method() !== 'GET') {
        return route.fulfill({
          status: 403,
          json: { error: { code: 'E2E_STUB', message: 'stub refuses every write' } },
        });
      }
      const url = new URL(req.url());
      const path = url.pathname;
      const json = (body: unknown) => route.fulfill({ status: 200, json: body });
      const base = `/api/admin/connector-catalogs/${A3A_CONNECTOR_ID}`;
      if (path === '/api/admin/connector-catalogs') return json(page(CONNECTOR_CATALOGS));
      if (path === base) return json(CONNECTOR_DETAIL);
      if (path === `${base}/stubs`) return json({ ...page(CONNECTOR_STUBS), advisories: [] });
      if (path === `${base}/pairs`) {
        return url.searchParams.get('lane') === 'evidenced'
          ? json({ lane: 'evidenced', ...page(EVIDENCED), advisories: [] })
          : json({ lane: 'reachable', ...page(REACHABLE), advisories: [] });
      }
      if (path === `${base}/audit`) return json(CONNECTOR_AUDIT);
      if (path === '/api/admin/reindex') return json(REINDEX_QUEUE);
      if (path === '/api/admin/reindex/submissions') return json(REINDEX_SUBMISSIONS);
      if (path === '/api/admin/vendors') return json(page([]));
      return route.fulfill({
        status: 404,
        json: { error: { code: 'NOT_FOUND', message: 'stub' } },
      });
    },
  );
}

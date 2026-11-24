/**
 * AECI-2111: synthetic rows for `/admin/claims`, `/admin/claims/:id`, `/admin/requests`,
 * `/admin/threads` and `/admin/threads/:id`.
 *
 * The local seed carries no claims, corrections, product requests, early-unassign
 * requests or row threads. These pages fetch their lists in the browser, so a spec
 * answers those same-origin `GET`s with these rows (`stubAdminA1bApi`). The SSR gate
 * still needs a real minted admin session (`auth-session.ts`). Every write is
 * refused here, so nothing a spec clicks can reach the local D1.
 *
 * Every row is typed by its `@aeci/shared` contract, so a change to an admin API shape
 * fails this file's typecheck rather than leaving the spec green on stale rows.
 */
import type { Page } from '@playwright/test';

import type {
  AdminClaim,
  AdminClaimAuditResponse,
  AdminClaimDetail,
  AdminLicenseReleaseRequest,
  AdminProductRequest,
  AdminThreadDetailResponse,
  AdminThreadRow,
  AdminVendorRequest,
} from '@aeci/shared';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const CLAIM_OPEN_ID = uuid(9101);
export const CLAIM_CONFLICT_ID = uuid(9102);
export const THREAD_ID = uuid(9301);

/** The Procore product and the vendor that makes it, so a product claim's resolved
 *  vendor (`entitlement_vendor`) is the product's own maker. */
const PROCORE = { id: uuid(9002), name: 'Procore', slug: 'procore' };
const PROCORE_VENDOR = {
  id: uuid(9001),
  name: 'Procore Technologies',
  slug: 'procore-technologies',
};
const SUMMIT = { id: uuid(9003), name: 'Summit BIM', slug: 'summit-bim' };
const OTHER = { id: uuid(9004), name: 'Fieldline Software', slug: 'fieldline' };

function claim(over: Partial<AdminClaim> & Pick<AdminClaim, 'id'>): AdminClaim {
  return {
    kind: 'claim',
    status: 'open',
    target_type: 'product',
    target_id: PROCORE.id,
    target: PROCORE,
    pair_product: null,
    submitter_email: 'sam@procore.example',
    submitter_name: 'Sam Rivera',
    submitter_role: null,
    submitter_title: 'Head of Partnerships',
    company_legal_name: 'Procore Technologies, Inc.',
    submitter_linkedin_url: null,
    found_via: 'search',
    found_via_detail: null,
    domain_match: 'match',
    body: 'We build Procore and would like to manage the listing.\nOur partner team owns it.',
    source_url: 'https://www.procore.example/about',
    is_duplicate: false,
    has_auth_account: true,
    linear_issue_id: null,
    linear_issue_url: null,
    created_at: '2026-11-20T09:30:00.000Z',
    resolved_at: null,
    resolved_by: null,
    duplicate_of_request_id: null,
    existing_seats: [],
    seat_emails_available: true,
    related_requests: [],
    entitlement_vendor: PROCORE_VENDOR,
    product_roles: { application: 2, connector: 1, hybrid: 0, total: 3 },
    is_pure_connector_vendor: false,
    owned_integrations: { integrations: 4, connector_evidenced: 2, total: 6 },
    admin_notes: null,
    context_product: null,
    granted: false,
    routed_to_owners_at: null,
    owner_fallback_at: null,
    claimant_seat: { kind: 'none' },
    ...over,
  };
}

export const CLAIMS = [
  claim({
    id: CLAIM_OPEN_ID,
    is_duplicate: true,
    admin_notes: 'Spoke to Sam on the phone. Waiting on a reply from their legal team.',
    existing_seats: [
      {
        display_name: 'Jo Park',
        email: 'jo@procore.example',
        work_email_verified: true,
        created_at: '2026-09-01T00:00:00.000Z',
      },
    ],
    related_requests: [
      {
        id: uuid(9150),
        kind: 'correction',
        status: 'resolved',
        target_type: 'product',
        created_at: '2026-10-02T10:00:00.000Z',
      },
    ],
    routed_to_owners_at: '2026-11-21T09:30:00.000Z',
  }),
  claim({
    id: CLAIM_CONFLICT_ID,
    target_type: 'vendor',
    target_id: SUMMIT.id,
    target: SUMMIT,
    entitlement_vendor: SUMMIT,
    submitter_email: 'alex@gmail.example',
    submitter_name: 'Alex Moreau',
    submitter_title: null,
    company_legal_name: null,
    domain_match: 'no_match',
    has_auth_account: true,
    body: '',
    source_url: null,
    product_roles: { application: 0, connector: 2, hybrid: 0, total: 2 },
    is_pure_connector_vendor: true,
    owned_integrations: null,
    claimant_seat: { kind: 'other_vendor', vendor: OTHER },
    created_at: '2026-11-22T14:00:00.000Z',
  }),
  claim({
    id: uuid(9103),
    target: null,
    target_id: uuid(9099),
    submitter_email: 'kim@builder.example',
    submitter_name: null,
    domain_match: 'pending',
    has_auth_account: null,
    existing_seats: null,
    related_requests: null,
    product_roles: null,
    owned_integrations: null,
    entitlement_vendor: null,
    body: 'Please add me.',
    created_at: '2026-11-23T08:00:00.000Z',
  }),
] satisfies AdminClaim[];

export const CLAIM_DETAIL = {
  ...CLAIMS[0]!,
  duplicate_siblings: [
    {
      id: uuid(9110),
      submitter_email: 'lee@procore.example',
      submitter_name: 'Lee Chen',
      status: 'open',
      created_at: '2026-11-02T12:00:00.000Z',
      match_reason: 'target',
      has_notes: true,
    },
  ],
} satisfies AdminClaimDetail;

export const CLAIM_CONFLICT_DETAIL = {
  ...CLAIMS[1]!,
  duplicate_siblings: [],
} satisfies AdminClaimDetail;

export const CLAIM_AUDIT = {
  data: [
    {
      id: uuid(9120),
      action: 'vendor_request.created',
      actor: null,
      actor_type: 'system',
      entity_type: 'vendor_request',
      entity_id: CLAIM_OPEN_ID,
      created_at: '2026-11-20T09:30:00.000Z',
      before_state: null,
      after_state: { status: 'open' },
    },
  ],
  page: 1,
  perPage: 25,
  total: 1,
  actor_emails_available: true,
} satisfies AdminClaimAuditResponse;

export const CORRECTIONS = [
  {
    id: uuid(9201),
    kind: 'correction',
    status: 'open',
    target_type: 'product',
    target_id: PROCORE.id,
    target: PROCORE,
    pair_product: { id: uuid(9010), name: 'Bluebeam Revu', slug: 'bluebeam-revu' },
    submitter_email: 'pat@contractor.example',
    submitter_name: 'Pat Lowe',
    submitter_role: 'Project manager',
    submitter_linkedin_url: null,
    submitter_title: null,
    company_legal_name: null,
    domain_match: 'pending',
    body: 'The RFI sync only runs one way.\nIssues do not come back into Procore.',
    source_url: 'https://www.procore.example/integrations',
    is_duplicate: true,
    has_auth_account: null,
    linear_issue_id: 'lin-1',
    linear_issue_url: 'https://linear.app/example/issue/EX-1',
    created_at: '2026-11-21T11:00:00.000Z',
    resolved_at: null,
    resolved_by: null,
  },
  {
    id: uuid(9202),
    kind: 'correction',
    status: 'open',
    target_type: 'vendor',
    target_id: SUMMIT.id,
    target: SUMMIT,
    pair_product: null,
    submitter_email: 'dana@gc.example',
    submitter_name: null,
    submitter_role: null,
    submitter_linkedin_url: null,
    submitter_title: null,
    company_legal_name: null,
    domain_match: 'pending',
    body: 'Their headquarters moved to Denver.',
    source_url: null,
    is_duplicate: false,
    has_auth_account: null,
    linear_issue_id: 'lin-2',
    linear_issue_url: null,
    created_at: '2026-11-23T16:00:00.000Z',
    resolved_at: null,
    resolved_by: null,
  },
] satisfies AdminVendorRequest[];

const SUMMIT_MC = { id: uuid(9012), name: 'Summit Model Coordination', slug: 'summit-mc' };

export const PRODUCT_REQUESTS = [
  {
    id: uuid(9211),
    status: 'open',
    vendor_id: SUMMIT.id,
    vendor: SUMMIT,
    requested_by: uuid(1),
    context_product_id: SUMMIT_MC.id,
    context_product: SUMMIT_MC,
    name: 'Trimble Connect',
    maker: 'Trimble',
    website: 'https://connect.trimble.example',
    body: 'We sync issues both ways with it. Most of our customers use it on site.',
    created_at: '2026-11-18T09:00:00.000Z',
    resolved_at: null,
    resolved_by: null,
    decline_reason: null,
    resolved_product: null,
  },
] satisfies AdminProductRequest[];

export const LICENSE_RELEASES = [
  {
    id: uuid(9221),
    status: 'open',
    license_id: 'lic_1',
    vendor_id: SUMMIT.id,
    vendor: SUMMIT,
    billing_account_id: 'ba_1',
    product_id: SUMMIT_MC.id,
    product: SUMMIT_MC,
    requested_by: uuid(2),
    reason: 'We are retiring this product at the end of the month.',
    created_at: '2026-11-19T10:00:00.000Z',
    decided_by: null,
    decided_at: null,
    decision_note: null,
    license: {
      source: 'stripe',
      starts_at: '2026-06-01T00:00:00.000Z',
      ends_at: '2027-06-01T00:00:00.000Z',
      ended_at: null,
      assigned_product_id: SUMMIT_MC.id,
    },
  },
] satisfies AdminLicenseReleaseRequest[];

const THREAD_ROW = {
  id: THREAD_ID,
  claim_id: uuid(9310),
  data_object: { slug: 'rfi', name: 'RFI' },
  vendor_a: PROCORE_VENDOR,
  vendor_b: SUMMIT,
  message_count: 3,
  last_message_at: '2026-11-22T15:00:00.000Z',
  help_requested_at: '2026-11-22T15:05:00.000Z',
  closed_at: null,
  closed_reason: null,
  created_at: '2026-11-20T10:00:00.000Z',
} satisfies AdminThreadRow;

export const THREADS = [
  THREAD_ROW,
  {
    ...THREAD_ROW,
    id: uuid(9302),
    data_object: { slug: 'submittal', name: 'Submittal' },
    message_count: 1,
    last_message_at: '2026-11-10T09:00:00.000Z',
    help_requested_at: null,
    closed_at: '2026-11-12T09:00:00.000Z',
    closed_reason: 'retired',
    created_at: '2026-11-10T09:00:00.000Z',
  },
] satisfies AdminThreadRow[];

export const THREAD_DETAIL = {
  thread: {
    ...THREAD_ROW,
    messages: [
      {
        id: uuid(9321),
        author_vendor: THREAD_ROW.vendor_a,
        author_profile_id: uuid(3),
        body: 'Our RFIs flow to you.\nDo yours come back to us?',
        created_at: '2026-11-20T10:00:00.000Z',
        deleted_at: null,
      },
      {
        id: uuid(9322),
        author_vendor: THREAD_ROW.vendor_b,
        author_profile_id: null,
        body: 'Not yet. See https://summit.example/roadmap <b>soon</b>.',
        created_at: '2026-11-21T10:00:00.000Z',
        deleted_at: '2026-11-21T12:00:00.000Z',
      },
      {
        id: uuid(9323),
        author_vendor: THREAD_ROW.vendor_b,
        author_profile_id: uuid(4),
        body: 'We will ask AEC Integrations to look.',
        created_at: '2026-11-22T15:00:00.000Z',
        deleted_at: null,
      },
    ],
  },
} satisfies AdminThreadDetailResponse;

function page<T>(data: readonly T[], perPage = 100) {
  return { data, page: 1, perPage, total: data.length };
}

/**
 * Answer the five pages' browser-side reads with the rows above, and refuse every
 * write (`503`), so a click can never change the local D1. PostHog is answered
 * locally and any other outside host is aborted.
 */
export async function stubAdminA1bApi(target: Page): Promise<void> {
  await target.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return route.fallback();
    if (/posthog/.test(host)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
  await target.route(
    /\/api\/admin\/(claims|requests|product-requests|license-release-requests|threads)(\/|\?|$)/,
    (route) => {
      const req = route.request();
      if (req.method() !== 'GET') {
        return route.fulfill({
          status: 503,
          json: { error: { code: 'E2E_STUB', message: 'stub' } },
        });
      }
      const url = new URL(req.url());
      const path = url.pathname;
      const json = (body: unknown) => route.fulfill({ status: 200, json: body });
      if (path === '/api/admin/claims') return json(page(CLAIMS));
      if (path === `/api/admin/claims/${CLAIM_OPEN_ID}`) return json(CLAIM_DETAIL);
      if (path === `/api/admin/claims/${CLAIM_CONFLICT_ID}`) return json(CLAIM_CONFLICT_DETAIL);
      if (path.endsWith('/audit')) return json(CLAIM_AUDIT);
      if (path === '/api/admin/requests') return json(page(CORRECTIONS));
      if (path === '/api/admin/product-requests') return json(page(PRODUCT_REQUESTS));
      if (path === '/api/admin/license-release-requests') return json(page(LICENSE_RELEASES));
      if (path === '/api/admin/threads') {
        const help = url.searchParams.get('help');
        return json(page(help === 'requested' ? THREADS.slice(0, 1) : THREADS, 24));
      }
      if (path === `/api/admin/threads/${THREAD_ID}`) return json(THREAD_DETAIL);
      return route.fulfill({
        status: 404,
        json: { error: { code: 'NOT_FOUND', message: 'stub' } },
      });
    },
  );
}

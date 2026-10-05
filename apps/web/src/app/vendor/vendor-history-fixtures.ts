/**
 * Fixtures for the portal Changes page (AECI-1160, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.19), shared by the dev-only preview (`/preview/vendor-dashboard/history`) and
 * the component specs.
 *
 * Newest first, as the API orders them. Every `actor_kind` appears, one AECi row
 * carries a vendor-facing reason and one does not, one row has no plan snapshot,
 * and one action is unknown to this build so the humanize fallback shows.
 *
 * The search follow-up (`VENDOR_HISTORY_FOLLOW_UP_FIXTURE`) covers a Managed edit
 * with several URLs (submitted, requested, failed and retrying, queued), a second
 * Managed edit still queued on both channels with a final failure, and a Free
 * edit, which shows "No expedited search submission".
 */
import type {
  VendorHistoryActorKind,
  VendorHistoryFollowUp,
  VendorHistoryItem,
  VendorHistoryKind,
} from '@aeci/shared';

/**
 * The `actor_kind` each `kind` filter keeps, mirroring `KIND_FILTER` in
 * `apps/api/src/lib/vendor-history.ts` (AECI-1194). The filter selects by WHO
 * acted, never by the action: an AECi admin's `product.updated` is an AECi row.
 * `all` keeps every row; system rows show under `all` only.
 */
const KIND_KEEPS: Readonly<Record<Exclude<VendorHistoryKind, 'all'>, VendorHistoryActorKind>> = {
  vendor: 'your_team',
  aeci: 'aeci',
};

/** Whether the API's `kind` filter keeps this row. The preview fake's filter. */
export function historyKindKeeps(kind: VendorHistoryKind, item: VendorHistoryItem): boolean {
  return kind === 'all' || item.actor_kind === KIND_KEEPS[kind];
}

const MANAGED = { tier: 'verified', status: 'active' } as const;
const FREE = { tier: 'unclaimed', status: null } as const;

function row(
  n: number,
  at: string,
  partial: Omit<VendorHistoryItem, 'id' | 'at'>,
): VendorHistoryItem {
  return { id: `00000000-0000-4000-8000-0000000059${String(n).padStart(2, '0')}`, at, ...partial };
}

export const VENDOR_HISTORY_FIXTURE: readonly VendorHistoryItem[] = [
  row(1, '2026-10-03T15:42:00.000Z', {
    actor_kind: 'your_team',
    action: 'product.updated',
    entity_type: 'product',
    entity_id: '00000000-0000-4000-8000-000000005201',
    entity_name: 'Summit Model Coordination',
    fields: ['description', 'website_url', 'logo_url'],
    plan: MANAGED,
  }),
  row(8, '2026-10-02T16:25:00.000Z', {
    actor_kind: 'your_team',
    action: 'integration.link_set',
    entity_type: 'integration',
    entity_id: '00000000-0000-4000-8000-000000005303',
    entity_name: 'Summit Model Coordination and Bluebeam',
    fields: ['url'],
    plan: MANAGED,
  }),
  row(2, '2026-10-02T09:10:00.000Z', {
    actor_kind: 'aeci',
    action: 'integration.retired',
    entity_type: 'integration',
    entity_id: '00000000-0000-4000-8000-000000005301',
    entity_name: 'Summit Model Coordination and Procore',
    fields: ['retired_at'],
    plan: MANAGED,
    reason:
      'Procore confirmed this connection was withdrawn in August. We retired it so the listing matches what is on offer today.',
  }),
  row(3, '2026-09-30T18:05:00.000Z', {
    actor_kind: 'system',
    action: 'vendor_entitlement.expiry_warned',
    entity_type: 'vendor',
    entity_id: '00000000-0000-4000-8000-000000005200',
    entity_name: 'Summit Software',
    fields: [],
    plan: MANAGED,
  }),
  row(4, '2026-09-29T11:20:00.000Z', {
    actor_kind: 'aeci',
    action: 'vendor_entitlement.granted',
    entity_type: 'vendor',
    entity_id: '00000000-0000-4000-8000-000000005200',
    entity_name: 'Summit Software',
    fields: ['tier', 'status', 'period_end'],
    plan: FREE,
  }),
  row(5, '2026-09-28T08:00:00.000Z', {
    actor_kind: 'your_team',
    action: 'vendor_seat.invited',
    entity_type: 'vendor',
    entity_id: '00000000-0000-4000-8000-000000005200',
    entity_name: 'Summit Software',
    fields: [],
    plan: null,
  }),
  row(6, '2026-09-27T14:30:00.000Z', {
    actor_kind: 'your_team',
    action: 'integration.updated',
    entity_type: 'integration',
    entity_id: '00000000-0000-4000-8000-000000005302',
    entity_name: 'Summit Model Coordination and Autodesk Construction Cloud',
    fields: ['mechanism_kind', 'dataObjects'],
    plan: FREE,
  }),
  row(7, '2026-09-26T10:00:00.000Z', {
    actor_kind: 'system',
    action: 'listing.future_event',
    entity_type: null,
    entity_id: null,
    entity_name: null,
    fields: [],
    plan: FREE,
  }),
];

const SITE = 'https://www.aecintegrations.com';

/** The follow-up lines `GET /api/vendor/history/follow-up` would answer for the
 *  fixture's team rows, in the API's order (audit id, URL, channel). */
export const VENDOR_HISTORY_FOLLOW_UP_FIXTURE: readonly VendorHistoryFollowUp[] = [
  {
    audit_log_id: VENDOR_HISTORY_FIXTURE[0]!.id,
    url: `${SITE}/products/summit-model-coordination`,
    channel: 'indexnow',
    state: 'submitted',
    at: '2026-10-04T00:05:00.000Z',
    http_status: 200,
    retrying: false,
  },
  {
    audit_log_id: VENDOR_HISTORY_FIXTURE[0]!.id,
    url: `${SITE}/products/summit-model-coordination`,
    channel: 'google',
    state: 'requested',
    at: '2026-10-04T13:20:00.000Z',
    http_status: null,
    retrying: false,
  },
  {
    audit_log_id: VENDOR_HISTORY_FIXTURE[0]!.id,
    url: `${SITE}/vendors/summit-software`,
    channel: 'indexnow',
    state: 'failed',
    at: '2026-10-04T00:05:00.000Z',
    http_status: 429,
    retrying: true,
  },
  {
    audit_log_id: VENDOR_HISTORY_FIXTURE[1]!.id,
    url: `${SITE}/products/summit-model-coordination/integrations/bluebeam-revu`,
    channel: 'indexnow',
    state: 'queued',
    at: '2026-10-02T16:25:00.000Z',
    http_status: null,
    retrying: false,
  },
  {
    audit_log_id: VENDOR_HISTORY_FIXTURE[1]!.id,
    url: `${SITE}/products/summit-model-coordination/integrations/bluebeam-revu`,
    channel: 'google',
    state: 'queued',
    at: '2026-10-02T16:25:00.000Z',
    http_status: null,
    retrying: false,
  },
  {
    audit_log_id: VENDOR_HISTORY_FIXTURE[1]!.id,
    url: `${SITE}/products/bluebeam-revu`,
    channel: 'indexnow',
    state: 'failed',
    at: '2026-10-03T00:05:00.000Z',
    http_status: null,
    retrying: false,
  },
];

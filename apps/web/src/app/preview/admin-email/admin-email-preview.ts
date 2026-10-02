import { Component, Injectable } from '@angular/core';

import type {
  AdminEmailSearchResponse,
  AdminEmailSendRow,
  AdminEmailSendsResponse,
  AdminEmailSummaryResponse,
  AdminEmailWindowCounts,
} from '@aeci/shared';

import { AdminEmailApi, type AdminEmailFilters } from '../../admin/email/admin-email-api';
import { EmailActivity } from '../../admin/email/email-activity';

/**
 * AECI-1223 — `/admin/email` over a component-provided fake of {@link AdminEmailApi}, so
 * the screen can be reviewed, axe-scanned and `impeccable detect`-ed without an admin
 * session. The real route sits behind the SSR admin gate, which a dev server cannot pass
 * without minting a real session (a real magic-link email). Same arrangement as
 * `/preview/admin-contests` (AECI-1009).
 *
 * Dev-only, like every `/preview` route: blocked on the public tiers by the SSR Worker
 * (`isPreviewPath`). The fixture is the production shape (the sign-in panel shows). It
 * applies the outcome, delivery and template filters in memory so the no-match state is
 * reachable. No address is stored: a search returns the rows of one synthetic recipient.
 */
const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();

const counts = (
  sent: number,
  over: Partial<AdminEmailWindowCounts['outcomes']> = {},
  delivery: Partial<AdminEmailWindowCounts['delivery']> = {},
): AdminEmailWindowCounts => ({
  outcomes: { sent, failed: 0, unknown: 0, skipped: 0, suppressed: 0, duplicate: 0, ...over },
  delivery: { delivered: sent, bounced: 0, complained: 0, delivery_delayed: 0, ...delivery },
});

const SUMMARY: AdminEmailSummaryResponse = {
  generated_at: new Date().toISOString(),
  environment: 'production',
  templates: [
    {
      id: 'attestation-digest',
      summary: 'Daily digest of integration records a vendor seat should check.',
      audience: 'external',
    },
    {
      id: 'claim-approved',
      summary: 'Tells a claimant their claim is approved and what the account can do.',
      audience: 'external',
    },
    {
      id: 'claim-rejected',
      summary: 'Tells a claimant their claim was not approved.',
      audience: 'external',
    },
    {
      id: 'claim-submitted-alert',
      summary: 'Tells the claims inbox a vendor claim landed.',
      audience: 'operator',
    },
    {
      id: 'digest-analytics',
      summary: "Sends ANALYTICS_DIGEST_EMAIL_TO the prior day's traffic digest.",
      audience: 'operator',
    },
    {
      id: 'mailing-list-welcome',
      summary: 'Welcomes a new mailing-list subscriber.',
      audience: 'external',
    },
  ],
  rows: [
    {
      notification_id: 'attestation-digest',
      summary: 'Daily digest of integration records a vendor seat should check.',
      audience: 'external',
      registered: true,
      d7: counts(42, { suppressed: 3 }, { delivered: 40, bounced: 1, delivery_delayed: 1 }),
      d30: counts(
        171,
        { suppressed: 9, duplicate: 2 },
        { delivered: 165, bounced: 4, complained: 1, delivery_delayed: 3 },
      ),
    },
    {
      notification_id: 'claim-approved',
      summary: 'Tells a claimant their claim is approved and what the account can do.',
      audience: 'external',
      registered: true,
      d7: counts(3),
      d30: counts(11, {}, { delivered: 11 }),
    },
    {
      notification_id: 'claim-submitted-alert',
      summary: 'Tells the claims inbox a vendor claim landed.',
      audience: 'operator',
      registered: true,
      d7: counts(4, { failed: 1 }),
      d30: counts(15, { failed: 1, unknown: 1 }),
    },
    {
      notification_id: 'digest-analytics',
      summary: "Sends ANALYTICS_DIGEST_EMAIL_TO the prior day's traffic digest.",
      audience: 'operator',
      registered: true,
      d7: counts(7),
      d30: counts(30),
    },
  ],
  sign_in: {
    d7: { sent: 58, delivered: 56, delivery_delayed: 1, bounced: 1, complained: 0 },
    d30: { sent: 231, delivered: 224, delivery_delayed: 3, bounced: 4, complained: 0 },
  },
};

const ROWS: AdminEmailSendRow[] = [
  {
    id: 912,
    notification_id: 'claim-approved',
    summary: null,
    outcome: 'sent',
    created_at: ago(2),
    provider_message_id: '4ef9a417-02e9-4d39-ad75-9611e0fcc33c',
    recipient_hash_prefix: '9c1e44d0',
    entity: {
      type: 'vendor_request',
      id: '0b8f6a4e-1c2d-4e5f-8a9b-1234567890ab',
      admin_path: '/admin/claims/0b8f6a4e-1c2d-4e5f-8a9b-1234567890ab',
    },
    latest_delivery: {
      event_type: 'delivered',
      occurred_at: ago(1.99),
      bounce_type: null,
      bounce_subtype: null,
    },
  },
  {
    id: 911,
    notification_id: 'attestation-digest',
    summary: null,
    outcome: 'sent',
    created_at: ago(5),
    provider_message_id: 'a1b2c3d4-0000-4000-8000-000000000911',
    recipient_hash_prefix: '3f7a0b12',
    entity: {
      type: 'vendor',
      id: '7d1c9e00-5555-4444-8888-aaaaaaaaaaaa',
      admin_path: '/admin/vendors/7d1c9e00-5555-4444-8888-aaaaaaaaaaaa',
    },
    latest_delivery: {
      event_type: 'bounced',
      occurred_at: ago(4.98),
      bounce_type: 'Permanent',
      bounce_subtype: 'General',
    },
  },
  {
    id: 910,
    notification_id: 'claim-submitted-alert',
    summary: null,
    outcome: 'failed',
    created_at: ago(9),
    provider_message_id: null,
    recipient_hash_prefix: 'e05d7c9a',
    entity: {
      type: 'vendor_request',
      id: '0b8f6a4e-1c2d-4e5f-8a9b-1234567890ab',
      admin_path: '/admin/claims/0b8f6a4e-1c2d-4e5f-8a9b-1234567890ab',
    },
    latest_delivery: null,
  },
  {
    id: 909,
    notification_id: 'attestation-digest',
    summary: null,
    outcome: 'suppressed',
    created_at: ago(26),
    provider_message_id: null,
    recipient_hash_prefix: '6a90f3e1',
    entity: {
      type: 'vendor',
      id: '7d1c9e00-5555-4444-8888-bbbbbbbbbbbb',
      admin_path: '/admin/vendors/7d1c9e00-5555-4444-8888-bbbbbbbbbbbb',
    },
    latest_delivery: null,
  },
  {
    id: 908,
    notification_id: 'digest-analytics',
    summary: null,
    outcome: 'sent',
    created_at: ago(31),
    provider_message_id: 'a1b2c3d4-0000-4000-8000-000000000908',
    recipient_hash_prefix: 'e05d7c9a',
    entity: null,
    latest_delivery: {
      event_type: 'sent',
      occurred_at: ago(30.99),
      bounce_type: null,
      bounce_subtype: null,
    },
  },
  {
    id: 907,
    notification_id: 'mailing-list-welcome',
    summary: null,
    outcome: 'sent',
    created_at: ago(50),
    provider_message_id: 'a1b2c3d4-0000-4000-8000-000000000907',
    recipient_hash_prefix: '41bb02cd',
    entity: { type: 'mailing_list', id: '88', admin_path: '/admin/subscribers' },
    latest_delivery: {
      event_type: 'complained',
      occurred_at: ago(20),
      bounce_type: null,
      bounce_subtype: null,
    },
  },
];

function filtered(f: AdminEmailFilters, rows: AdminEmailSendRow[]): AdminEmailSendsResponse {
  const data = rows.filter(
    (r) =>
      (!f.template || r.notification_id === f.template) &&
      (!f.outcome || r.outcome === f.outcome) &&
      (!f.delivery ||
        (f.delivery === 'none'
          ? r.latest_delivery === null
          : r.latest_delivery?.event_type === f.delivery)),
  );
  return {
    data,
    page: 1,
    perPage: f.perPage,
    total: data.length,
    generated_at: new Date().toISOString(),
  };
}

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewAdminEmailApi extends AdminEmailApi {
  override async summary(): Promise<AdminEmailSummaryResponse> {
    return SUMMARY;
  }

  override async listSends(filters: AdminEmailFilters): Promise<AdminEmailSendsResponse> {
    return filtered(filters, ROWS);
  }

  override async searchSends(
    _address: string,
    filters: AdminEmailFilters,
  ): Promise<AdminEmailSearchResponse> {
    const mine = ROWS.filter((r) => r.recipient_hash_prefix === 'e05d7c9a');
    return {
      ...filtered(filters, mine),
      unmatched_events: [
        {
          id: 51,
          notification_id: 'supabase-sign-in',
          tier: 'auth',
          event_type: 'delivered',
          occurred_at: ago(3),
          provider_message_id: 'a1b2c3d4-0000-4000-8000-000000000051',
          bounce_type: null,
          bounce_subtype: null,
        },
      ],
    };
  }
}

@Component({
  selector: 'app-admin-email-preview',
  imports: [EmailActivity],
  providers: [{ provide: AdminEmailApi, useClass: PreviewAdminEmailApi }],
  template: `
    <div class="mx-auto max-w-7xl px-6 py-10">
      <h1 class="mb-6 text-2xl font-bold text-(--text-primary)" i18n="@@preview.adminEmail.heading">
        Admin: email (preview)
      </h1>
      <aec-email-activity />
    </div>
  `,
})
export class AdminEmailPreview {}

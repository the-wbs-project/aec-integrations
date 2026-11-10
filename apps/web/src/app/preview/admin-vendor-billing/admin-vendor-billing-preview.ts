import { Component, Injectable, signal } from '@angular/core';

import type {
  AdminLicenseGrant,
  AdminVendorBillingResponse,
  GrantLicensesInput,
  GrantLicensesResponse,
  WithdrawLicenseGrantResponse,
} from '@aeci/shared';

import { AdminLicensesApi } from '../../admin/vendors/admin-licenses-api';
import { BillingLicensesTable } from '../../admin/vendors/billing-licenses-table';
import { GrantLicensesControl } from '../../admin/vendors/grant-licenses-control';
import { LicenseGrantActions } from '../../admin/vendors/license-grant-actions';

/**
 * AECI-1615: the Billing tab of `/admin/vendors/:id` with its Grants section, the
 * Withdraw action and the grant control's "Recorded signed deal" section, fed
 * synthetic rows through a component-provided fake of {@link AdminLicensesApi}. So the
 * grant flow can be reviewed, axe-scanned and `impeccable detect`-ed without an admin
 * session (the real route is behind the SSR admin gate).
 *
 * Dev-only, like every `/preview` route: blocked on the public tiers by the SSR Worker
 * (`isPreviewPath`). Writes resolve locally and change nothing.
 */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TS = '2026-11-09T15:00:00.000Z';

function grant(n: number, over: Partial<AdminLicenseGrant>): AdminLicenseGrant {
  return {
    id: uuid(n),
    kind: 'grant',
    status: 'pending_acceptance',
    source: 'complimentary',
    quantity: 2,
    starts_at: null,
    ends_at: '2027-11-30T00:00:00.000Z',
    reference: null,
    notes: null,
    terms_version: '1.1',
    items: [],
    granted_by: uuid(900),
    acceptance_id: null,
    acceptance_method: null,
    decided_at: null,
    decided_by: null,
    withdraw_reason: null,
    created_at: TS,
    updated_at: TS,
    ...over,
  };
}

function billing(grants: AdminLicenseGrant[]): AdminVendorBillingResponse {
  return {
    vendor_id: uuid(10),
    legal_name: 'Summit BIM Software, Inc.',
    billing_account: {
      id: uuid(20),
      name: 'Summit BIM',
      billing_email: 'accounts@summitbim.example.com',
      stripe_customer_id: null,
      created_at: '2026-06-04T14:00:00.000Z',
      owner_seats: [
        {
          user_id: uuid(30),
          display_name: 'Dana Ruiz',
          email: 'dana@summitbim.example.com',
          banned: false,
        },
      ],
      seat_emails_available: true,
    },
    licenses: [],
    licenses_truncated: false,
    acceptances: [
      {
        id: uuid(40),
        document: 'managed_plan',
        version: '1.1',
        source: 'grant',
        email: 'dana@summitbim.example.com',
        profile_id: uuid(30),
        billing_account_id: uuid(20),
        vendor_request_id: null,
        stripe_checkout_session_id: null,
        accepted_at: '2026-11-08T10:00:00.000Z',
        signer_name: 'Dana Ruiz',
        signer_title: 'Head of Partnerships',
        company_legal_name: 'Summit BIM Software, Inc.',
        method: 'signed_deal',
        license_grant_id: uuid(102),
        grant_ends_at: '2027-10-31T00:00:00.000Z',
        text_sha256: null,
        seat_role: null,
        deal_reference: 'DocuSign 4F2A',
        deal_signed_at: '2026-11-07T00:00:00.000Z',
        // A signed deal has no box (ruling 16).
        checkbox_label_sha256: null,
        checkbox_default_unticked: null,
        vendor_id: uuid(10),
        ip: null,
        user_agent: null,
        evidence_removed_at: null,
        created_at: '2026-11-08T10:00:00.000Z',
      },
      {
        // AECI-1636: a claim acceptance past 90 days. The sweep removed its IP and browser.
        id: uuid(41),
        document: 'vendor_terms',
        version: '1.0',
        source: 'claim',
        email: 'dana@summitbim.example.com',
        profile_id: uuid(30),
        billing_account_id: uuid(20),
        vendor_request_id: uuid(50),
        stripe_checkout_session_id: null,
        accepted_at: '2026-06-04T13:55:00.000Z',
        signer_name: null,
        signer_title: null,
        company_legal_name: null,
        method: null,
        license_grant_id: null,
        grant_ends_at: null,
        text_sha256: null,
        seat_role: null,
        deal_reference: null,
        deal_signed_at: null,
        checkbox_label_sha256: null,
        checkbox_default_unticked: null,
        vendor_id: uuid(10),
        ip: null,
        user_agent: null,
        evidence_removed_at: '2026-09-02T17:00:00.000Z',
        created_at: '2026-06-04T13:55:00.000Z',
      },
    ],
    acceptances_truncated: false,
    release_requests: [],
    grants,
    grants_truncated: false,
  };
}

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewAdminLicensesApi extends AdminLicensesApi {
  override async grantLicenses(
    vendorId: string,
    input: GrantLicensesInput,
  ): Promise<GrantLicensesResponse> {
    const status = input.signed_deal ? 'accepted' : 'pending_acceptance';
    return {
      vendor_id: vendorId,
      billing_account_id: uuid(20),
      grant_id: input.grant_id,
      replayed: false,
      status,
      grant: grant(199, { id: input.grant_id, quantity: input.quantity, status }),
      licenses: [],
      warnings: [],
    };
  }

  override async withdrawLicenseGrant(
    grantId: string,
    reason: string,
  ): Promise<WithdrawLicenseGrantResponse> {
    return {
      vendor_id: uuid(10),
      grant: grant(101, { id: grantId, status: 'withdrawn', withdraw_reason: reason }),
    };
  }
}

@Component({
  selector: 'aec-admin-vendor-billing-preview',
  imports: [BillingLicensesTable, GrantLicensesControl, LicenseGrantActions],
  providers: [{ provide: AdminLicensesApi, useClass: PreviewAdminLicensesApi }],
  template: `
    <main class="mx-auto max-w-6xl px-6 py-10">
      <h1 class="font-display text-2xl font-semibold text-(--text-primary)">Summit BIM</h1>
      <h2 class="mt-4 font-display text-xl font-semibold text-(--text-primary)">Billing</h2>
      <p class="sr-only" role="status" aria-live="polite">{{ announced() }}</p>
      <ng-template #grantActions let-row>
        <aec-license-grant-actions
          [grant]="row.grant"
          [idPrefix]="'grant-' + row.grant.id"
          (changed)="onWithdrawn($event.grant)"
          (announce)="announced.set($event)"
        />
      </ng-template>
      <aec-billing-licenses-table
        [billing]="data()"
        [loading]="false"
        [failed]="false"
        [grantActions]="grantActions"
      >
        <div billingGrant>
          <aec-grant-licenses-control
            vendorId="00000000-0000-4000-8000-000000000010"
            vendorName="Summit BIM"
            [isPureConnectorVendor]="false"
            idPrefix="preview"
            labelledBy="admin-vendor-billing-licenses"
            (announce)="announced.set($event)"
          />
        </div>
      </aec-billing-licenses-table>
    </main>
  `,
})
export class AdminVendorBillingPreview {
  protected readonly announced = signal('');
  protected readonly data = signal(
    billing([
      grant(101, {}),
      grant(102, {
        status: 'accepted',
        quantity: 1,
        source: 'invoice',
        reference: 'PO-2026-0412',
        ends_at: '2027-10-31T00:00:00.000Z',
        acceptance_id: uuid(40),
        acceptance_method: 'signed_deal',
        decided_at: '2026-11-08T10:00:00.000Z',
      }),
      grant(103, {
        status: 'withdrawn',
        decided_at: '2026-11-05T10:00:00.000Z',
        withdraw_reason: 'Granted twice by mistake.',
      }),
    ]),
  );

  protected onWithdrawn(updated: AdminLicenseGrant): void {
    this.data.update((b) => ({
      ...b,
      grants: b.grants.map((g) => (g.id === updated.id ? { ...g, ...updated, decided_at: TS } : g)),
    }));
  }
}

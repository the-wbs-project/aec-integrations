import { Component, Injectable, signal } from '@angular/core';

import type {
  AdminCorrectFlowInput,
  AdminFlowCorrection,
  AdminFlowCorrectionResponse,
  AdminFlowCorrectionsResponse,
  AdminFlowsResponse,
  AdminVendorIntegrationsResponse,
} from '@aeci/shared';

import { AdminFlowCorrections } from '../../admin/vendors/admin-flow-corrections';
import { AdminVendorsApi } from '../../admin/vendors/admin-vendors-api';

/**
 * AECI-2139 — the "Data flow corrections" section of `/admin/vendors/:id`, fed synthetic
 * corrections, rows and flows through a component-provided fake of
 * {@link AdminVendorsApi}, so the list, the "Correct a data flow" form and the Lift form
 * can be reviewed and axe-scanned without an admin session (the real route is behind
 * the SSR admin gate).
 *
 * Dev-only, like every `/preview` route: blocked on the public tiers by the SSR Worker
 * (`isPreviewPath`). Writes resolve locally and change nothing.
 */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PAIR = uuid(30);
const TS = '2026-11-26T09:00:00.000Z';

const CORRECTIONS: readonly AdminFlowCorrection[] = [
  {
    id: uuid(700),
    claim_id: uuid(60),
    replacement_claim_id: null,
    anchor_id: PAIR,
    anchor: 'evidenced_pair',
    integration_name: 'Procore and Acumatica',
    data_object_slug: 'rfis',
    data_object_name: 'RFIs',
    direction: 'a_to_b',
    replacement_direction: null,
    source_url: 'https://www.example.com/rivets/procore-acumatica',
    reason: 'The Sync Service page lists no RFI sync between these two products.',
    internal_note: 'Checked the public integration page on 2026-11-26.',
    created_by: uuid(90),
    created_at: TS,
    retracted_at: null,
    retracted_by: null,
    retracted_reason: null,
  },
  {
    id: uuid(701),
    claim_id: uuid(61),
    replacement_claim_id: uuid(62),
    anchor_id: PAIR,
    anchor: 'evidenced_pair',
    integration_name: 'Procore and Acumatica',
    data_object_slug: 'invoices',
    data_object_name: 'Invoices',
    direction: 'a_to_b',
    replacement_direction: 'b_to_a',
    source_url: 'https://www.example.com/rivets/invoices',
    reason: 'Invoices move from Acumatica to Procore, as the setup guide shows.',
    internal_note: null,
    created_by: uuid(90),
    created_at: TS,
    retracted_at: null,
    retracted_by: null,
    retracted_reason: null,
  },
];

const FLOWS: AdminFlowsResponse = {
  anchor_id: PAIR,
  anchor: 'evidenced_pair',
  name: 'Procore and Acumatica',
  product_a: { id: uuid(20), name: 'Procore' },
  product_b: { id: uuid(21), name: 'Acumatica' },
  blocked: null,
  flows: [
    {
      claim_id: uuid(63),
      data_object_slug: 'commitments',
      data_object_name: 'Commitments',
      direction: 'both',
      origin: 'aeci',
      public: true,
      agreement: 'owner_confirmed',
      owner_answer: 'yes',
      correction: null,
    },
    {
      claim_id: uuid(64),
      data_object_slug: 'vendors',
      data_object_name: 'Vendors',
      direction: 'a_to_b',
      origin: 'aeci',
      public: true,
      agreement: 'unverified',
      owner_answer: null,
      correction: null,
    },
  ],
};

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewAdminVendorsApi extends AdminVendorsApi {
  private corrections: AdminFlowCorrection[] = [...CORRECTIONS];

  override async listFlowCorrections(): Promise<AdminFlowCorrectionsResponse> {
    return { corrections: this.corrections };
  }
  override async listIntegrations(): Promise<AdminVendorIntegrationsResponse> {
    return {
      data: [
        {
          id: PAIR,
          anchor: 'evidenced_pair',
          name: 'Procore and Acumatica',
          source: { id: uuid(20), slug: 'procore', name: 'Procore' },
          target: { id: uuid(21), slug: 'acumatica', name: 'Acumatica' },
          connector: { id: uuid(22), slug: 'rivets-sync', name: 'Rivets Sync' },
          connector_powered: true,
          origin: 'aeci',
          claimed_at: TS,
          retired_at: null,
          retired_by: null,
          pair_path: '/products/acumatica/integrations/procore',
          updated_at: TS,
        },
      ],
      page: 1,
      perPage: 100,
      total: 1,
    };
  }
  override async listFlows(): Promise<AdminFlowsResponse> {
    return FLOWS;
  }
  override async correctFlow(
    claimId: string,
    input: AdminCorrectFlowInput,
  ): Promise<AdminFlowCorrectionResponse> {
    const flow = FLOWS.flows.find((f) => f.claim_id === claimId)!;
    const correction: AdminFlowCorrection = {
      ...CORRECTIONS[0]!,
      id: crypto.randomUUID(),
      claim_id: claimId,
      data_object_slug: flow.data_object_slug,
      data_object_name: flow.data_object_name,
      direction: flow.direction,
      replacement_claim_id: input.direction ? crypto.randomUUID() : null,
      replacement_direction: input.direction ?? null,
      source_url: input.sourceUrl,
      reason: input.reason,
      internal_note: input.internalNote ?? null,
      created_at: new Date().toISOString(),
    };
    this.corrections = [correction, ...this.corrections];
    return { correction };
  }
  override async liftFlowCorrection(
    id: string,
    reason: string,
  ): Promise<AdminFlowCorrectionResponse> {
    const correction = this.corrections.find((c) => c.id === id)!;
    this.corrections = this.corrections.filter((c) => c.id !== id);
    return {
      correction: {
        ...correction,
        retracted_at: TS,
        retracted_by: uuid(90),
        retracted_reason: reason,
      },
    };
  }
}

@Component({
  selector: 'aec-admin-flow-corrections-preview',
  imports: [AdminFlowCorrections],
  providers: [{ provide: AdminVendorsApi, useClass: PreviewAdminVendorsApi }],
  template: `
    <main class="mx-auto max-w-5xl px-6 py-10">
      <h1 class="font-display text-2xl font-semibold text-(--text-primary)">Rivets</h1>
      <h2 class="mt-6 text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)">
        Data flow corrections
      </h2>
      <p class="sr-only" aria-live="polite">{{ announced() }}</p>
      <div class="mt-2">
        <aec-admin-flow-corrections
          vendorId="00000000-0000-4000-8000-000000000010"
          (announce)="announced.set($event)"
        />
      </div>
    </main>
  `,
})
export class AdminFlowCorrectionsPreview {
  protected readonly announced = signal('');
}

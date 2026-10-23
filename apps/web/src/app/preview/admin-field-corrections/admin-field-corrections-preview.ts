import { Component, Injectable, signal } from '@angular/core';

import type {
  AdminFieldOverride,
  AdminFieldOverrideResponse,
  AdminFieldOverridesResponse,
  AdminSetFieldOverrideInput,
  AdminVendorIntegrationsResponse,
  AdminVendorProductsResponse,
  TaxonomyResponse,
  TaxonomyTermWithCount,
} from '@aeci/shared';

import { AdminFieldCorrections } from '../../admin/vendors/admin-field-corrections';
import { AdminVendorsApi } from '../../admin/vendors/admin-vendors-api';

/**
 * AECI-1237 — the "Field corrections" section of `/admin/vendors/:id`, fed synthetic
 * locks, products and integrations through a component-provided fake of
 * {@link AdminVendorsApi}, so the lock list, the "Correct a field" form and the Lift
 * form can be reviewed and axe-scanned without an admin session (the real route is
 * behind the SSR admin gate).
 *
 * Dev-only, like every `/preview` route: blocked on the public tiers by the SSR Worker
 * (`isPreviewPath`). Writes resolve locally and change nothing.
 */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR_ID = uuid(10);
const TS = '2026-10-04T00:00:00.000Z';

const LOCKS: readonly AdminFieldOverride[] = [
  {
    id: uuid(601),
    entity_type: 'vendor',
    entity_id: VENDOR_ID,
    entity_name: 'Agave',
    field: 'phone_number',
    value: '+1 555 0100',
    reason: 'The number on file reaches a different company. We checked the company register.',
    internal_note: 'Register extract filed on AECI-1237.',
    vendor_id: VENDOR_ID,
    set_by: uuid(90),
    set_at: TS,
    lifted_by: null,
    lifted_at: null,
    lift_reason: null,
  },
  {
    id: uuid(602),
    entity_type: 'integration',
    entity_id: uuid(501),
    entity_name: 'Agave Sync for Procore',
    field: 'direction',
    value: 'both',
    reason: 'Both vendors document a two-way sync.',
    internal_note: null,
    vendor_id: VENDOR_ID,
    set_by: uuid(90),
    set_at: TS,
    lifted_by: null,
    lifted_at: null,
    lift_reason: null,
  },
  // AECI-1382: a facet lock. The value is the whole term set, named in the list.
  {
    id: uuid(603),
    entity_type: 'product',
    entity_id: uuid(20),
    entity_name: 'Agave ERP Sync',
    field: 'category_slugs',
    value: ['erp-accounting', 'project-management'],
    reason: 'Agave connects other tools. The categories on file described the tools it connects.',
    internal_note: null,
    vendor_id: VENDOR_ID,
    set_by: uuid(90),
    set_at: TS,
    lifted_by: null,
    lifted_at: null,
    lift_reason: null,
  },
];

const term = (slug: string, name: string, order: number): TaxonomyTermWithCount => ({
  id: uuid(700 + order),
  slug,
  name,
  description: null,
  display_order: order,
  product_count: 0,
});

/** A short slice of each facet vocabulary: enough to review the terms control. */
const TAXONOMY: TaxonomyResponse = {
  categories: [
    term('bim-authoring', 'BIM Authoring', 1),
    term('erp-accounting', 'ERP & Accounting', 2),
    term('estimating', 'Estimating', 3),
    term('field-management', 'Field Management', 4),
    term('project-management', 'Project Management', 5),
  ],
  audiences: [term('general-contractors', 'General Contractors', 11), term('owners', 'Owners', 12)],
  phases: [term('construction', 'Construction', 21), term('closeout', 'Closeout', 22)],
  trades: [term('electrical', 'Electrical', 31), term('mechanical', 'Mechanical', 32)],
};

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewAdminVendorsApi extends AdminVendorsApi {
  private locks: AdminFieldOverride[] = LOCKS.map((lock) => ({ ...lock }));

  override async listFieldOverrides(): Promise<AdminFieldOverridesResponse> {
    return { overrides: this.locks };
  }

  override async listProducts(): Promise<AdminVendorProductsResponse> {
    return {
      data: [
        {
          logo_url: null,
          id: uuid(20),
          slug: 'agave-erp-sync',
          name: 'Agave ERP Sync',
          product_role: 'connector',
          is_primary: true,
          promotion_status: 'promoted',
          integration_count: 3,
          review_count: 0,
          rating_overall_avg: null,
          updated_at: TS,
          category_slugs: ['erp-accounting', 'project-management'],
          audience_slugs: ['general-contractors'],
          phase_slugs: [],
          trade_slugs: [],
        },
      ],
      page: 1,
      perPage: 100,
      total: 1,
    };
  }

  override async getTaxonomy(): Promise<TaxonomyResponse> {
    return TAXONOMY;
  }

  override async listIntegrations(): Promise<AdminVendorIntegrationsResponse> {
    return {
      data: [
        {
          id: uuid(501),
          anchor: 'integration',
          name: 'Agave Sync for Procore',
          source: { id: uuid(20), slug: 'agave-erp-sync', name: 'Agave ERP Sync' },
          target: { id: uuid(21), slug: 'procore', name: 'Procore' },
          connector: null,
          connector_powered: false,
          origin: 'aeci',
          claimed_at: TS,
          retired_at: null,
          retired_by: null,
          pair_path: '/products/agave-erp-sync/integrations/procore',
          updated_at: TS,
        },
      ],
      page: 1,
      perPage: 100,
      total: 1,
    };
  }

  override async setFieldOverride(
    input: AdminSetFieldOverrideInput,
  ): Promise<AdminFieldOverrideResponse> {
    const override: AdminFieldOverride = {
      id: crypto.randomUUID(),
      entity_type: input.entityType,
      entity_id: input.entityId,
      entity_name: null,
      field: input.field,
      value: input.value,
      reason: input.reason,
      internal_note: input.internalNote ?? null,
      vendor_id: VENDOR_ID,
      set_by: uuid(90),
      set_at: new Date().toISOString(),
      lifted_by: null,
      lifted_at: null,
      lift_reason: null,
    };
    this.locks = [override, ...this.locks];
    return { override };
  }

  override async liftFieldOverride(
    overrideId: string,
    reason: string,
  ): Promise<AdminFieldOverrideResponse> {
    const lock = this.locks.find((l) => l.id === overrideId)!;
    this.locks = this.locks.filter((l) => l.id !== overrideId);
    return { override: { ...lock, lifted_at: TS, lifted_by: uuid(90), lift_reason: reason } };
  }
}

@Component({
  selector: 'aec-admin-field-corrections-preview',
  imports: [AdminFieldCorrections],
  providers: [{ provide: AdminVendorsApi, useClass: PreviewAdminVendorsApi }],
  template: `
    <main class="mx-auto max-w-5xl px-6 py-10">
      <h1 class="font-display text-2xl font-semibold text-(--text-primary)">Agave</h1>
      <h2 class="mt-6 text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)">
        Field corrections
      </h2>
      <p class="sr-only" aria-live="polite">{{ announced() }}</p>
      <div class="mt-2">
        <aec-admin-field-corrections
          vendorId="00000000-0000-4000-8000-000000000010"
          vendorName="Agave"
          (announce)="announced.set($event)"
        />
      </div>
    </main>
  `,
})
export class AdminFieldCorrectionsPreview {
  protected readonly announced = signal('');
}

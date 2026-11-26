import { Component, Injectable, signal } from '@angular/core';

import type {
  AdminDeliveredPairsResponse,
  AdminSetConnectorKindResponse,
  AdminSetSyncFactsInput,
  AdminSetSyncFactsResponse,
  AdminVendorProductRow,
  ConnectorKind,
} from '@aeci/shared';

import { AdminVendorsApi } from '../../admin/vendors/admin-vendors-api';
import { VendorProductsTable } from '../../admin/vendors/vendor-products-table';

/**
 * AECI-2202 — the Products tab of `/admin/vendors/:id`, fed synthetic rows through a
 * component-provided fake of {@link AdminVendorsApi}, so the row Actions menu and
 * every dialog it opens can be reviewed, axe-scanned and `impeccable detect`-ed
 * without an admin session (the real route is behind the SSR admin gate).
 *
 * The rows cover an application, a Sync Service, an unclassified connector, a
 * product hidden on its own and one hidden with its company.
 *
 * Dev-only, like every `/preview` route: blocked on the public tiers by the SSR Worker
 * (`isPreviewPath`). Writes resolve locally and change nothing on a server.
 */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TS = '2026-11-24T00:00:00.000Z';
const AGAVE = { id: uuid(10), name: 'Agave' };

function row(n: number, name: string, over: Partial<AdminVendorProductRow> = {}) {
  return {
    logo_url: null,
    id: uuid(n),
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    product_role: 'application',
    connector_kind: null,
    is_primary: true,
    promotion_status: 'promoted',
    integration_count: 13,
    review_count: 0,
    rating_overall_avg: null,
    updated_at: TS,
    category_slugs: [],
    audience_slugs: [],
    phase_slugs: [],
    trade_slugs: [],
    listing_hide: null,
    ...over,
  } satisfies AdminVendorProductRow;
}

function hide(n: number, parentId: string | null): AdminVendorProductRow['listing_hide'] {
  return {
    id: uuid(700 + n),
    entity_type: 'product',
    entity_id: uuid(n),
    parent_id: parentId,
    kind: 'lawful_order',
    reason: 'A court order.',
    internal_note: null,
    received_at: '2026-11-20',
    source_url: null,
    set_by: null,
    set_at: TS,
    restored_by: null,
    restored_at: null,
    restore_reason: null,
  };
}

const ROWS: AdminVendorProductRow[] = [
  row(1, 'Agave AI Analytics'),
  row(2, 'Agave AP Invoice Automation', { listing_hide: hide(2, null) }),
  row(3, 'Agave ERP Sync', {
    product_role: 'connector',
    connector_kind: 'sync_service',
    integration_count: 0,
    sync_facts: {
      sync_frequency: 'Every 15 minutes',
      sync_support: 'Agave support team',
      sync_setup: 'Guided setup by Agave',
      source_url: 'https://www.agaveapi.com/sync',
      recorded_at: TS,
    },
  }),
  row(4, 'Agave Expense Management', { listing_hide: hide(4, uuid(799)) }),
  row(5, 'Agave Link', { product_role: 'connector', integration_count: 0 }),
];

const link = (n: number, name: string) => ({
  id: uuid(n),
  name,
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  logo_url: null,
});

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewAdminVendorsApi extends AdminVendorsApi {
  override async getDeliveredPairs(productId: string): Promise<AdminDeliveredPairsResponse> {
    return {
      connector: {
        id: productId,
        name: 'Agave ERP Sync',
        slug: 'agave-erp-sync',
        connector_kind: 'sync_service',
      },
      connector_vendors: [AGAVE],
      pairs: [
        {
          id: uuid(501),
          anchor: 'evidenced_pair',
          name: null,
          product_a: link(11, 'Procore'),
          product_b: link(12, 'Sage Intacct'),
          owner: AGAVE,
          claimed_at: TS,
          retired_at: null,
          retired_by: null,
          endpoint_vendors: [],
        },
        {
          id: uuid(502),
          anchor: 'integration',
          name: 'Autodesk Build and Acumatica',
          product_a: link(13, 'Autodesk Build'),
          product_b: link(14, 'Acumatica'),
          owner: null,
          claimed_at: null,
          retired_at: null,
          retired_by: null,
          endpoint_vendors: [],
        },
      ],
    };
  }

  override async setConnectorKind(
    productId: string,
    kind: ConnectorKind | null,
  ): Promise<AdminSetConnectorKindResponse> {
    return { id: productId, connector_kind: kind, changed: true };
  }

  override async setSyncFacts(
    productId: string,
    facts: AdminSetSyncFactsInput,
  ): Promise<AdminSetSyncFactsResponse> {
    return { ...facts, recorded_at: TS, id: productId, changed: true };
  }
}

@Component({
  selector: 'aec-admin-vendor-products-preview',
  imports: [VendorProductsTable],
  providers: [{ provide: AdminVendorsApi, useClass: PreviewAdminVendorsApi }],
  template: `
    <main class="mx-auto max-w-6xl px-6 py-10">
      <h1 class="font-display text-2xl font-semibold text-(--text-primary)">Agave</h1>
      <p class="sr-only" aria-live="polite">{{ announced() }}</p>
      <aec-vendor-products-table
        [rows]="rows"
        [page]="1"
        [perPage]="25"
        [total]="rows.length"
        [loading]="false"
        [failed]="false"
        (announce)="announced.set($event)"
      />
    </main>
  `,
})
export class AdminVendorProductsPreview {
  protected readonly rows = ROWS;
  protected readonly announced = signal('');
}

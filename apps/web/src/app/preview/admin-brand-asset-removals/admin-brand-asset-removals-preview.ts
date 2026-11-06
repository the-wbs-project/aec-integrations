import { Component, Injectable, signal } from '@angular/core';

import type {
  AdminBrandAssetHoldResponse,
  BrandAssetRemoval,
  ListBrandAssetRemovalsResponse,
} from '@aeci/shared';

import { AdminVendorsApi } from '../../admin/vendors/admin-vendors-api';
import { BrandAssetRemovals } from '../../admin/vendors/brand-asset-removals';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString();

const ROWS: readonly BrandAssetRemoval[] = [
  {
    vendor_id: uuid(10),
    vendor_slug: 'agave',
    company_name: 'Agave',
    claim_ended_at: day(0),
    cause: 'last-seat-revoked',
    hold_at: null,
    limit_at: day(14),
    next_run_at: day(1),
    affected_rows: [
      {
        entity_type: 'vendor',
        id: uuid(11),
        slug: 'agave',
        name: 'Agave',
        logo_url: 'https://example.com/agave.png',
        sourced_logo_url: 'https://example.com/agave-sourced.png',
      },
      {
        entity_type: 'product',
        id: uuid(12),
        slug: 'agave-sync',
        name: 'Agave Sync',
        logo_url: 'https://example.com/sync.png',
        sourced_logo_url: null,
      },
    ],
    skipped_product_ids: [uuid(13)],
  },
  {
    vendor_id: uuid(20),
    vendor_slug: 'summit-bim',
    company_name: 'Summit BIM',
    claim_ended_at: day(-6),
    cause: 'vendor-terminated',
    hold_at: day(-5),
    limit_at: day(8),
    next_run_at: day(7),
    affected_rows: [
      {
        entity_type: 'vendor',
        id: uuid(21),
        slug: 'summit-bim',
        name: 'Summit BIM',
        logo_url: 'https://example.com/summit.png',
        sourced_logo_url: null,
      },
    ],
    skipped_product_ids: [],
  },
];

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewApi extends AdminVendorsApi {
  private rows = [...ROWS];

  override async listBrandAssetRemovals(): Promise<ListBrandAssetRemovalsResponse> {
    return { data: this.rows };
  }

  override async holdBrandAssets(vendorId: string): Promise<AdminBrandAssetHoldResponse> {
    return this.setHold(vendorId, new Date().toISOString());
  }

  override async liftBrandAssetHold(vendorId: string): Promise<AdminBrandAssetHoldResponse> {
    return this.setHold(vendorId, null);
  }

  private setHold(vendorId: string, holdAt: string | null): AdminBrandAssetHoldResponse {
    this.rows = this.rows.map((r) => (r.vendor_id === vendorId ? { ...r, hold_at: holdAt } : r));
    return { vendor_id: vendorId, hold_at: holdAt };
  }
}

/**
 * AECI-1618: the pending brand-asset removals section of `/admin/vendors` over a fake of
 * {@link AdminVendorsApi}, so it can be reviewed and axe-scanned without an admin session
 * (the real route is behind the SSR admin gate). Dev-only, like every `/preview` route.
 */
@Component({
  selector: 'app-admin-brand-asset-removals-preview',
  imports: [BrandAssetRemovals],
  providers: [{ provide: AdminVendorsApi, useClass: PreviewApi }],
  template: `
    <main class="mx-auto max-w-7xl px-6 py-8">
      <h1 class="sr-only">Admin brand-asset removals preview</h1>
      <h2 class="sr-only">Vendors</h2>
      <p class="sr-only" role="status" aria-live="polite">{{ message() }}</p>
      <aec-brand-asset-removals (announce)="message.set($event)" />
    </main>
  `,
})
export class AdminBrandAssetRemovalsPreview {
  protected readonly message = signal('');
}

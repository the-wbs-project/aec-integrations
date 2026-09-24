import { Component, Injectable, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import type {
  AdminVendorIntegrationRow,
  AdminVendorIntegrationsResponse,
  RetireIntegrationResponse,
} from '@aeci/shared';

import { AdminVendorsApi } from '../../admin/vendors/admin-vendors-api';
import {
  ADMIN_RETIRE_FORM_START_OPEN,
  VendorIntegrationsPanel,
} from '../../admin/vendors/vendor-integrations-panel';

/**
 * AECI-1091 — the Integrations tab of `/admin/vendors/:id`, fed synthetic rows
 * through a component-provided fake of {@link AdminVendorsApi}, so the pair rows and
 * the retire form can be reviewed, axe-scanned and `impeccable detect`-ed without an
 * admin session (the real route is behind the SSR admin gate).
 *
 * `?retire=<row id>` opens that row's form once the list loads. The live evidenced
 * pair is `00000000-0000-4000-8000-000000000502`.
 *
 * Dev-only, like every `/preview` route: blocked on the public tiers by the SSR Worker
 * (`isPreviewPath`). Writes resolve locally and change nothing.
 */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROCORE = { id: uuid(11), slug: 'procore', name: 'Procore' };
const SAGE = { id: uuid(12), slug: 'sage-intacct', name: 'Sage Intacct' };
const AUTODESK = { id: uuid(13), slug: 'autodesk-build', name: 'Autodesk Build' };
const AGAVE = { id: uuid(14), slug: 'agave-erp-sync', name: 'Agave ERP Sync' };
const TS = '2026-09-20T00:00:00.000Z';

const ROWS: readonly AdminVendorIntegrationRow[] = [
  {
    id: uuid(501),
    anchor: 'integration',
    name: 'Agave Sync for Procore',
    source: AGAVE,
    target: PROCORE,
    connector: null,
    origin: 'aeci',
    claimed_at: TS,
    retired_at: null,
    retired_by: null,
    pair_path: '/products/agave-erp-sync/integrations/procore',
    updated_at: TS,
  },
  {
    id: uuid(502),
    anchor: 'evidenced_pair',
    name: 'Procore and Sage Intacct via Agave',
    source: PROCORE,
    target: SAGE,
    connector: AGAVE,
    origin: 'aeci',
    claimed_at: TS,
    retired_at: null,
    retired_by: null,
    pair_path: '/products/procore/integrations/sage-intacct',
    updated_at: TS,
  },
  {
    id: uuid(503),
    anchor: 'evidenced_pair',
    name: 'Autodesk Build and Sage Intacct via Agave',
    source: AUTODESK,
    target: SAGE,
    connector: AGAVE,
    origin: 'aeci',
    claimed_at: TS,
    retired_at: TS,
    retired_by: 'aeci',
    pair_path: '/products/autodesk-build/integrations/sage-intacct',
    updated_at: TS,
  },
];

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewAdminVendorsApi extends AdminVendorsApi {
  private rows: AdminVendorIntegrationRow[] = ROWS.map((row) => ({ ...row }));

  override async listIntegrations(): Promise<AdminVendorIntegrationsResponse> {
    return { data: this.rows, page: 1, perPage: 100, total: this.rows.length };
  }

  override async setIntegrationRetired(
    integrationId: string,
    mode: 'retire' | 'restore',
  ): Promise<RetireIntegrationResponse> {
    const retiredAt = mode === 'retire' ? '2026-09-23T12:00:00.000Z' : null;
    const retiredBy = mode === 'retire' ? ('aeci' as const) : null;
    this.rows = this.rows.map((row) =>
      row.id === integrationId ? { ...row, retired_at: retiredAt, retired_by: retiredBy } : row,
    );
    return {
      integration: {
        id: integrationId,
        retired_at: retiredAt,
        retired_by: retiredBy,
        updated_at: '2026-09-23T12:00:00.000Z',
      },
      withdrawn_contest_ids: [],
    };
  }
}

@Component({
  selector: 'aec-admin-vendor-integrations-preview',
  imports: [VendorIntegrationsPanel],
  providers: [
    { provide: AdminVendorsApi, useClass: PreviewAdminVendorsApi },
    {
      provide: ADMIN_RETIRE_FORM_START_OPEN,
      useFactory: () => inject(ActivatedRoute).snapshot.queryParamMap.get('retire'),
    },
  ],
  template: `
    <main class="mx-auto max-w-5xl px-6 py-10">
      <h1 class="font-display text-2xl font-semibold text-(--text-primary)">Agave</h1>
      <p class="sr-only" aria-live="polite">{{ announced() }}</p>
      <aec-vendor-integrations-panel
        vendorId="00000000-0000-4000-8000-000000000010"
        (announce)="announced.set($event)"
      />
    </main>
  `,
})
export class AdminVendorIntegrationsPreview {
  protected readonly announced = signal('');
}

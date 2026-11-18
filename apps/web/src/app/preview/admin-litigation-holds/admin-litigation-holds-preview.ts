import { Component, Injectable } from '@angular/core';

import type {
  CreateLitigationHoldRequest,
  LitigationHold,
  LitigationHoldsResponse,
  LitigationHoldWriteResponse,
} from '@aeci/shared';

import { AdminLegalApi } from '../../admin/legal/admin-legal-api';
import { AdminLitigationHolds } from '../../admin/legal/litigation-holds';

/**
 * AECI-1638: the "Litigation holds" section of `/admin/legal`, fed synthetic holds through
 * a component-provided fake of {@link AdminLegalApi}, so the open card, the release form,
 * the place form and the released list can be reviewed and axe-scanned without an admin
 * session (the real route is behind the SSR admin gate).
 *
 * Dev-only, like every `/preview` route: blocked on the public tiers by the SSR Worker
 * (`isPreviewPath`). Writes resolve locally and change nothing.
 */
const hold = (over: Partial<LitigationHold> & { id: string }): LitigationHold => ({
  scope: 'vendor',
  vendor_id: '00000000-0000-4000-8000-000000000501',
  vendor_name: 'Acme Software',
  reason: 'Demand letter received about the listing claims.',
  matter_reference: 'AECI-9999',
  placed_by: '00000000-0000-4000-8000-000000000001',
  placed_at: '2026-11-10T09:30:00.000Z',
  released_at: null,
  released_by: null,
  release_reason: null,
  ...over,
});

const DATA: LitigationHoldsResponse = {
  generated_at: '2026-11-17T12:00:00.000Z',
  open: [hold({ id: 'h-open' })],
  released: [
    hold({
      id: 'h-released',
      vendor_id: null,
      vendor_name: null,
      scope: 'global',
      placed_at: '2026-09-01T10:00:00.000Z',
      released_at: '2026-10-15T16:00:00.000Z',
      release_reason: 'The subpoena was withdrawn.',
    }),
  ],
};

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewAdminLegalApi extends AdminLegalApi {
  override async litigationHolds(): Promise<LitigationHoldsResponse> {
    return structuredClone(DATA);
  }
  override async placeHold(
    body: CreateLitigationHoldRequest,
  ): Promise<LitigationHoldWriteResponse> {
    return { hold: hold({ id: 'h-new', scope: body.scope, vendor_id: body.vendor_id ?? null }) };
  }
  override async releaseHold(id: string, reason: string): Promise<LitigationHoldWriteResponse> {
    return { hold: hold({ id, released_at: DATA.generated_at, release_reason: reason }) };
  }
}

@Component({
  selector: 'app-admin-litigation-holds-preview',
  imports: [AdminLitigationHolds],
  providers: [{ provide: AdminLegalApi, useClass: PreviewAdminLegalApi }],
  template: `
    <div class="mx-auto max-w-5xl px-6 py-10">
      <h1
        class="mb-6 text-2xl font-bold text-(--text-primary)"
        i18n="@@preview.adminLitigationHolds.heading"
      >
        Admin: litigation holds (preview)
      </h1>
      <aec-admin-litigation-holds />
    </div>
  `,
})
export class AdminLitigationHoldsPreview {}

import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import type { VendorMeResponse } from '@aeci/shared';

import { NotFound } from '../not-found/not-found';
import { VendorDashboardTabbed } from './vendor-dashboard-tabbed';

/**
 * AECI-522 — the `/vendor` vendor-portal page: the gate + the dashboard. Data
 * comes from `vendorMeResolver` via `route.data['me']`:
 *
 *   - `me === null` → the caller is NOT a vendor admin (the resolver got a
 *     401/403 from `GET /api/vendor/me` and set `RESPONSE_INIT.status = 404` + the
 *     noindex 404 meta). Render the global `<aec-not-found/>` so the surface is
 *     never revealed. URL stays at `/vendor`. (`requireVendor()` rejects anon,
 *     reviewers, banned seats, null-`vendor_id` seats, AND site admins.)
 *   - `me` set → render the tabbed dashboard (the PO-chosen IA, AECI-522).
 *
 * `/vendor` is a private, never-edge-cached surface (cookie-forwarded
 * non-cacheable SSR branch, no `Cache-Tag`), so on the success path we set a
 * `robots: noindex` head + a title — mirroring `/admin`. On the not-found path the
 * resolver already set the noindex 404 head, so we leave it.
 */
@Component({
  selector: 'aec-vendor-page',
  imports: [NotFound, VendorDashboardTabbed],
  template: `
    @let m = me();
    @if (m === null) {
      <aec-not-found />
    } @else {
      <aec-vendor-dashboard-tabbed [me]="m" />
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorPage {
  private readonly route = inject(ActivatedRoute);
  private readonly titleSvc = inject(Title);
  private readonly metaSvc = inject(Meta);

  /** Resolved data. `vendorMeResolver` runs server-side and on hydration reads
   *  from `TransferState`; the snapshot value is the SSR-resolved payload (or
   *  null for a non-vendor / not-found). */
  protected readonly me = toSignal<VendorMeResponse | null, VendorMeResponse | null>(
    this.route.data.pipe(map((d) => (d['me'] ?? null) as VendorMeResponse | null)),
    { initialValue: (this.route.snapshot.data['me'] ?? null) as VendorMeResponse | null },
  );

  constructor() {
    // Success path only: private surface → noindex + a real title. The not-found
    // path's head is owned by the resolver (`setNotFoundMeta`), so leave it.
    if (this.me()) {
      this.titleSvc.setTitle($localize`:@@vendor.metaTitle:Vendor dashboard · AEC Integrations`);
      this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });
    }
  }
}

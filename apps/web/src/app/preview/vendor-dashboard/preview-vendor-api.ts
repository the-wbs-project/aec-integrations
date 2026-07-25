import { Injectable } from '@angular/core';

import type {
  ListVendorSeatsResponse,
  TaxonomyResponse,
  UpdateVendorProductInput,
  UpdateVendorProductResponse,
  UpdateVendorProfileInput,
  UpdateVendorProfileResponse,
  VendorMeResponse,
  VendorSeat,
} from '@aeci/shared';

import { VendorApi } from '../../vendor/vendor-api';
import { VENDOR_SEATS_FIXTURE, VENDOR_TAXONOMY_FIXTURE } from '../../vendor/vendor-fixtures';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Fixture-backed {@link VendorApi} for the dev-only vendor-dashboard preview
 * (AECI-522). It shadows the real client via DI so the exact same components
 * exercise realistic reads + writes without a vendor session or the API Worker:
 * mutations merge the diff into an in-memory copy and echo it back, so the
 * optimistic-save UX (and the form settling to a clean state) is fully
 * reviewable. No network is ever touched.
 */
// Intentionally component-scoped, not `providedIn: 'root'`: this fake is provided
// only in the vendor-dashboard preview's `providers` (shadowing the real
// `VendorApi`), so it must never leak into the app-wide injector.
// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
export class PreviewVendorApi extends VendorApi {
  private me: VendorMeResponse | null = null;
  private seats: VendorSeat[] = clone([...VENDOR_SEATS_FIXTURE]);

  /** Point the fake at the fixture the preview is currently showing, so writes
   *  merge onto the matching vendor/products. Clones so the shared fixture
   *  constants are never mutated across preview sessions. */
  setFixture(me: VendorMeResponse, seats: readonly VendorSeat[]): void {
    this.me = clone(me);
    this.seats = clone([...seats]);
  }

  override async getMe(): Promise<VendorMeResponse> {
    // `setFixture` always runs (in the preview's effect) before any read.
    return clone(this.me!);
  }

  override async getSeats(): Promise<ListVendorSeatsResponse> {
    return { seats: clone(this.seats) };
  }

  override async updateProfile(
    input: UpdateVendorProfileInput,
  ): Promise<UpdateVendorProfileResponse> {
    if (this.me) Object.assign(this.me.vendor, input);
    return { vendor: clone(this.me!.vendor) };
  }

  override async updateProduct(
    id: string,
    input: UpdateVendorProductInput,
  ): Promise<UpdateVendorProductResponse> {
    const product = this.me?.products.find((p) => p.id === id);
    if (product) Object.assign(product, input);
    return { product: clone(product!) };
  }

  override async getTaxonomy(): Promise<TaxonomyResponse> {
    return clone(VENDOR_TAXONOMY_FIXTURE);
  }
}

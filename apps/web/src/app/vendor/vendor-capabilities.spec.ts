import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';

import { capabilitiesFor, type Capability } from '@aeci/shared/entitlements';
import type { VendorMeResponse } from '@aeci/shared';

import {
  integrationCanAuthor,
  isCatalogueProduct,
  isCatalogueSeat,
  productCan,
  vendorCan,
} from './vendor-capabilities';
import type { VendorPortalStore } from './vendor-portal-store';

/** An Integration platform AECi holds a catalogue for: the §8.9 seat's product. */
const connector = {
  product_role: 'connector',
  connector_kind: 'integration_platform',
  has_connector_catalog: true,
};
const application = { product_role: 'application', has_connector_catalog: false };

/**
 * The §8.9 catalogue-seat rule (`STAGE_2_SPEC.md` §8.9, AECI-724 / AECI-1082, narrowed
 * by AECI-2044). The plan panel, the overview links and the read-only notices all read
 * it, so it is pinned once here.
 */
describe('isCatalogueSeat', () => {
  it('is true for a pure platform vendor with no license and a catalogue', () => {
    expect(isCatalogueSeat(null, [connector])).toBe(true);
    // A connector with no kind and a catalogue is still the seat's product.
    expect(isCatalogueSeat(null, [{ ...connector, connector_kind: null }])).toBe(true);
  });

  it('is false for a pure platform vendor whose connector has no catalogue', () => {
    expect(isCatalogueSeat(null, [{ ...connector, has_connector_catalog: false }])).toBe(false);
    // A payload from before AECI-2044, with no catalogue field, reads closed.
    expect(isCatalogueSeat(null, [{ product_role: 'connector' }])).toBe(false);
  });

  it('is false for a Sync Service, which may buy Managed (ruling 6)', () => {
    const sync = { product_role: 'connector', connector_kind: 'sync_service' };
    expect(isCatalogueSeat(null, [sync])).toBe(false);
    // Even if a catalogue row exists for it, a Sync Service is not the seat's product.
    expect(isCatalogueSeat(null, [{ ...sync, has_connector_catalog: true }])).toBe(false);
  });

  it('is false for a mixed Free vendor such as Rivets: applications and a Sync Service', () => {
    const sync = { product_role: 'connector', connector_kind: 'sync_service' };
    expect(isCatalogueSeat(null, [application, application, sync])).toBe(false);
  });

  it('is true for a mixed Free vendor that also has a catalogued platform', () => {
    expect(isCatalogueSeat(null, [application, connector])).toBe(true);
    expect(isCatalogueProduct(application)).toBe(false);
    expect(isCatalogueProduct(connector)).toBe(true);
  });

  it('is false for a never-arranged vendor with no connector product', () => {
    expect(isCatalogueSeat(null, [application])).toBe(false);
    expect(isCatalogueSeat(null, [])).toBe(false);
  });

  it('is false once any entitlement row exists, lapsed or not', () => {
    for (const status of ['active', 'pending', 'expired', 'revoked']) {
      expect(isCatalogueSeat(status, [connector])).toBe(false);
    }
  });

  it('is false before the store is seeded', () => {
    expect(isCatalogueSeat(undefined, [connector])).toBe(false);
  });
});

/** A product carrying only what `productCan` reads. */
const withPlan = (capabilities: readonly Capability[]) => ({ plan: { capabilities } });

describe('productCan (AECI-1214, §13.7)', () => {
  it('reads the product plan, Free and Managed', () => {
    const free = withPlan(capabilitiesFor('unclaimed'));
    expect(productCan(free, 'product.listing.edit')).toBe(true);
    expect(productCan(free, 'product.categories.edit')).toBe(true);
    expect(productCan(free, 'product.edit')).toBe(false);
    expect(productCan(free, 'product.taxonomy.edit')).toBe(false);
    expect(productCan(free, 'product.usefulness.edit')).toBe(false);

    const managed = withPlan(capabilitiesFor('verified'));
    expect(productCan(managed, 'product.edit')).toBe(true);
    expect(productCan(managed, 'product.taxonomy.edit')).toBe(true);
  });

  it('is closed with no product', () => {
    expect(productCan(null, 'product.listing.edit')).toBe(false);
    expect(productCan(undefined, 'product.listing.edit')).toBe(false);
  });

  it('reads the product, not the vendor', () => {
    // Two products on different plans answer differently. The server cannot
    // produce this yet, which is the point: no screen changes when it can.
    expect(productCan(withPlan([]), 'product.listing.edit')).toBe(false);
    expect(productCan(withPlan(['product.listing.edit']), 'product.listing.edit')).toBe(true);
  });
});

describe('vendorCan', () => {
  const storeWith = (capabilities: readonly Capability[] | null) =>
    ({
      me: signal(
        capabilities === null
          ? null
          : ({ entitlement: { capabilities } } as unknown as VendorMeResponse),
      ),
    }) as unknown as VendorPortalStore;

  it('lets a seat with no plan edit company details (§13.3)', () => {
    expect(vendorCan(storeWith(capabilitiesFor('unclaimed')), 'profile.edit')()).toBe(true);
    // AECI-2038: confirming data flows is on every plan; product versions stay Managed.
    expect(vendorCan(storeWith(capabilitiesFor('unclaimed')), 'attestation.author')()).toBe(true);
    expect(vendorCan(storeWith(capabilitiesFor('unclaimed')), 'product.versions.edit')()).toBe(
      false,
    );
  });

  it('is false before the store is seeded', () => {
    expect(vendorCan(storeWith(null), 'profile.edit')()).toBe(false);
  });
});

/** Ruled 2026-10-14: attestations are per product (`integrationCanAuthor`). */
describe('integrationCanAuthor', () => {
  const managed = capabilitiesFor('verified');
  const free = capabilitiesFor('unclaimed');
  const products = (a: readonly Capability[], b: readonly Capability[]) => [
    { id: 'p-a', plan: { capabilities: a } },
    { id: 'p-b', plan: { capabilities: b } },
  ];
  const row = (slots: readonly string[]) => ({
    context_product: { id: 'p-a' },
    other_product: { id: 'p-b' },
    slots,
  });

  /** A plan block with no capabilities: a tier the build does not know. */
  const none: readonly Capability[] = [];

  it('passes a Free endpoint product (AECI-2038)', () => {
    expect(integrationCanAuthor(row(['vendor_a']), products(free, free))).toBe(true);
    expect(integrationCanAuthor(row(['vendor_a', 'vendor_b']), products(free, free))).toBe(true);
  });

  it('reads the context product’s plan for a one-slot integration', () => {
    expect(integrationCanAuthor(row(['vendor_a']), products(managed, none))).toBe(true);
    expect(integrationCanAuthor(row(['vendor_a']), products(none, managed))).toBe(false);
  });

  it('passes an owns-both integration when either endpoint holds the capability', () => {
    expect(integrationCanAuthor(row(['vendor_a', 'vendor_b']), products(none, managed))).toBe(true);
    expect(integrationCanAuthor(row(['vendor_a', 'vendor_b']), products(none, none))).toBe(false);
  });

  it('is closed with no integration or an unknown product', () => {
    expect(integrationCanAuthor(null, products(managed, managed))).toBe(false);
    expect(integrationCanAuthor(row(['vendor_a']), [])).toBe(false);
  });
});

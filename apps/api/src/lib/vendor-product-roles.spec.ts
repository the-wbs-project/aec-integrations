import { describe, expect, it } from 'vitest';

import {
  EMPTY_PRODUCT_ROLES,
  foldProductRoleGroups,
  isPureConnectorVendor,
} from './vendor-product-roles';

/**
 * The §5.2 payer test in isolation (AECI-738). The route specs cover the SQL and
 * the wiring; this covers the decision itself, because the decision is the part
 * that is one-way: `STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2 says Grant and Reject are
 * BOTH wrong on a pure-connector claim, and a false positive here parks a real
 * customer's claim while a false negative sends them a decline email.
 */
describe('isPureConnectorVendor', () => {
  const roles = (o: Partial<typeof EMPTY_PRODUCT_ROLES>) => ({ ...EMPTY_PRODUCT_ROLES, ...o });

  it('is true only when the vendor owns products and all of them are connectors', () => {
    expect(isPureConnectorVendor(roles({ connector: 2, total: 2 }))).toBe(true);
  });

  it('is false when any product is an application', () => {
    // The Autodesk / Trimble / Deltek / Sage case (`STAGE_2_SPEC.md` §8.8(1)):
    // each owns connector-role products AND is a major endpoint account.
    expect(isPureConnectorVendor(roles({ application: 1, connector: 9, total: 10 }))).toBe(false);
  });

  it('is false when any product is a hybrid — hybrid counts as an endpoint', () => {
    // §8.8(1)'s hybrid rule: a hybrid IS an endpoint as well as a connector, so
    // it is chargeable on its endpoint side and confers no exemption.
    expect(isPureConnectorVendor(roles({ hybrid: 1, connector: 9, total: 10 }))).toBe(false);
  });

  it('is false for a vendor with no products at all', () => {
    // Owning nothing is UNKNOWN, not exempt. Written as `connector === total`
    // rather than "no application and no hybrid" precisely so the empty case
    // does not pass by vacuous truth.
    expect(isPureConnectorVendor(EMPTY_PRODUCT_ROLES)).toBe(false);
  });
});

describe('foldProductRoleGroups', () => {
  it('folds grouped rows per vendor', () => {
    const byVendor = foldProductRoleGroups([
      { vendorId: 'v1', role: 'application', value: 2 },
      { vendorId: 'v1', role: 'connector', value: 1 },
      { vendorId: 'v2', role: 'connector', value: 3 },
    ]);
    expect(byVendor.get('v1')).toEqual({ application: 2, connector: 1, hybrid: 0, total: 3 });
    expect(byVendor.get('v2')).toEqual({ application: 0, connector: 3, hybrid: 0, total: 3 });
    // Absent, not zeroed — the caller decides what "no rows" means in its context.
    expect(byVendor.get('v3')).toBeUndefined();
  });

  it('counts an unrecognised role toward the total but into no bucket, failing the carve-out CLOSED', () => {
    // `products_product_role_check` makes this unreachable today, but a future
    // migration could land ahead of this file. The vendor must then read as
    // "owns something that is not a connector" — the safe direction. Counting it
    // as a connector would park a claim wrongly; throwing would 500 the queue.
    const roles = foldProductRoleGroups([
      { vendorId: 'v1', role: 'connector', value: 1 },
      { vendorId: 'v1', role: 'marketplace', value: 1 },
    ]).get('v1')!;
    expect(roles).toEqual({ application: 0, connector: 1, hybrid: 0, total: 2 });
    expect(isPureConnectorVendor(roles)).toBe(false);
  });
});

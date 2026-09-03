import { describe, expect, it } from 'vitest';

import {
  AdminAuditRowSchema,
  AdminVendorAuditQuerySchema,
  AdminVendorDetailSchema,
  AdminVendorProductRowSchema,
  AdminVendorRowSchema,
  AdminVendorSortSchema,
  AdminVendorsListQuerySchema,
  VendorProductRolesSchema,
} from './admin-vendors';

/**
 * The AECI-652 wire contracts. Two of these cases guard decisions that are easy
 * to "simplify" back into defects:
 *
 *  - `verified` is an ENUM-plus-transform, not `z.coerce.boolean()`.
 *  - `before_state` is `z.unknown().nullable()`, which in Zod 4 still REJECTS a
 *    missing key while accepting any present value. `z.record(...)` would reject
 *    a historical scalar snapshot; a plain `.optional()` would let a missed
 *    construction site ship as `undefined` (R10).
 */

const VENDOR_ID = '00000000-0000-4000-8000-000000000010';

describe('AdminVendorsListQuerySchema', () => {
  it('applies the shared page defaults', () => {
    const parsed = AdminVendorsListQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.perPage).toBe(24);
    // `name`, not the public list's `created`: this is a lookup surface, and
    // `created_at` is not even on `AdminVendorRowSchema` to sort by.
    expect(parsed.sort).toBe('name');
  });

  it('accepts a sort key for every column the operator table renders', () => {
    for (const key of ['name', 'slug', 'verified', 'entitlement', 'products', 'term', 'updated']) {
      expect(AdminVendorSortSchema.safeParse(key).success, key).toBe(true);
    }
  });

  it('rejects the public sort keys it does not implement', () => {
    // The admin enum is deliberately not `VendorSortSchema`. `created` has no
    // column on the row, so a header could not state its direction honestly.
    expect(AdminVendorSortSchema.safeParse('created').success).toBe(false);
    expect(AdminVendorsListQuerySchema.safeParse({ sort: 'created' }).success).toBe(false);
  });

  it('rejects perPage above the shared cap', () => {
    expect(AdminVendorsListQuerySchema.safeParse({ perPage: '101' }).success).toBe(false);
  });

  it("parses verified='true' as true", () => {
    expect(AdminVendorsListQuerySchema.parse({ verified: 'true' }).verified).toBe(true);
  });

  it("parses verified='false' as FALSE, not true", () => {
    // `z.coerce.boolean()` — which the public `VendorsListQuerySchema` still uses
    // — yields `true` here, because `Boolean("false") === true`. That is the
    // AECI-691 defect, and copying the public schema would have reproduced it on
    // a surface that genuinely needs the negative filter.
    expect(AdminVendorsListQuerySchema.parse({ verified: 'false' }).verified).toBe(false);
  });

  it('rejects any other verified value rather than guessing', () => {
    expect(AdminVendorsListQuerySchema.safeParse({ verified: '1' }).success).toBe(false);
    expect(AdminVendorsListQuerySchema.safeParse({ verified: 'yes' }).success).toBe(false);
  });

  it('omits verified entirely when absent — that is the "any" state', () => {
    expect(AdminVendorsListQuerySchema.parse({}).verified).toBeUndefined();
  });
});

describe('AdminVendorRowSchema', () => {
  const base = {
    id: VENDOR_ID,
    slug: 'acme-corp',
    company_name: 'Acme Corp',
    verified: true,
    tier: 'verified',
    status: 'active',
    period_end: '2027-01-01',
    product_count: 3,
    updated_at: '2026-08-20T00:00:00.000Z',
  };

  it('accepts a fully populated row', () => {
    expect(AdminVendorRowSchema.parse(base).slug).toBe('acme-corp');
  });

  it('accepts null tier/status/period_end for a vendor with no entitlement row', () => {
    const parsed = AdminVendorRowSchema.parse({
      ...base,
      tier: null,
      status: null,
      period_end: null,
    });
    expect(parsed.tier).toBeNull();
  });

  it('rejects a MISSING tier — nullable, never optional (R10)', () => {
    const { tier: _tier, ...withoutTier } = base;
    expect(AdminVendorRowSchema.safeParse(withoutTier).success).toBe(false);
  });
});

describe('AdminVendorDetailSchema', () => {
  const base = {
    id: VENDOR_ID,
    slug: 'acme-corp',
    company_name: 'Acme Corp',
    description: null,
    website: null,
    headquarters: null,
    logo_url: null,
    verified: false,
    promotion_status: 'promoted',
    maintained_by: 'aeci',
    last_reviewed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-08-20T00:00:00.000Z',
    entitlement: null,
    seats: [],
    seat_emails_available: true,
    pending_invites: [],
    product_count: 0,
    product_roles: { application: 0, connector: 0, hybrid: 0, total: 0 },
    is_pure_connector_vendor: false,
    integration_count: 0,
    claim_counts: { open: 0, in_review: 0, resolved: 0, rejected: 0 },
  };

  it('accepts a vendor with no entitlement and no seats', () => {
    expect(AdminVendorDetailSchema.parse(base).seats).toEqual([]);
  });

  it('distinguishes seats: null (unavailable) from [] (none)', () => {
    // The whole tri-state discipline in one assertion: both parse, and they mean
    // different things. An `[]` when the roster query failed would tell an
    // operator the vendor has no seats, which is a wrong answer, not a degraded
    // one.
    expect(AdminVendorDetailSchema.parse({ ...base, seats: null }).seats).toBeNull();
    expect(AdminVendorDetailSchema.parse(base).seats).toEqual([]);
  });

  it('accepts a seat row with role and work_email_verified', () => {
    const parsed = AdminVendorDetailSchema.parse({
      ...base,
      seats: [
        {
          user_id: '00000000-0000-4000-8000-000000000020',
          display_name: 'Ada',
          email: null,
          banned: false,
          owner: true,
          role: 'vendor_admin',
          work_email_verified: true,
          created_at: '2026-02-01T00:00:00.000Z',
        },
      ],
    });
    expect(parsed.seats?.[0].role).toBe('vendor_admin');
  });

  it('rejects a seat that still carries the portal-only is_self flag', () => {
    // Omitted deliberately: an admin holds no seat, so `is_self` would always be
    // `false` and would invite the reader to wonder whose page this is.
    const parsed = AdminVendorDetailSchema.parse({
      ...base,
      seats: [
        {
          user_id: '00000000-0000-4000-8000-000000000020',
          display_name: null,
          email: null,
          banned: false,
          owner: false,
          role: 'vendor_admin',
          work_email_verified: false,
          created_at: '2026-02-01T00:00:00.000Z',
          is_self: true,
        },
      ],
    });
    expect(parsed.seats?.[0]).not.toHaveProperty('is_self');
  });

  it('requires all four claim-count buckets', () => {
    expect(
      AdminVendorDetailSchema.safeParse({
        ...base,
        claim_counts: { open: 0, resolved: 0, rejected: 0 },
      }).success,
    ).toBe(false);
  });
});

describe('AdminVendorAuditQuerySchema', () => {
  it('defaults scope to `all`', () => {
    expect(AdminVendorAuditQuerySchema.parse({}).scope).toBe('all');
  });

  it('accepts the two narrowed scopes', () => {
    expect(AdminVendorAuditQuerySchema.parse({ scope: 'entity' }).scope).toBe('entity');
    expect(AdminVendorAuditQuerySchema.parse({ scope: 'actor' }).scope).toBe('actor');
  });

  it('rejects an unknown scope', () => {
    expect(AdminVendorAuditQuerySchema.safeParse({ scope: 'everything' }).success).toBe(false);
  });
});

describe('AdminAuditRowSchema', () => {
  const base = {
    id: '00000000-0000-4000-8000-000000000100',
    action: 'vendor_entitlement.set',
    actor: null,
    actor_type: 'admin',
    entity_type: 'vendor_entitlement',
    entity_id: VENDOR_ID,
    created_at: '2026-08-20T00:00:00.000Z',
    before_state: null,
    after_state: { status: 'active' },
  };

  it('accepts an object snapshot', () => {
    expect(AdminAuditRowSchema.parse(base).after_state).toEqual({ status: 'active' });
  });

  it('accepts a SCALAR snapshot without throwing', () => {
    // Written by code that may no longer exist, in a table nothing prunes. A
    // `z.record(...)` here would make `validateResponseInDev` throw on a row the
    // viewer should simply render.
    expect(AdminAuditRowSchema.parse({ ...base, before_state: 'a bare string' }).before_state).toBe(
      'a bare string',
    );
    expect(AdminAuditRowSchema.parse({ ...base, before_state: 42 }).before_state).toBe(42);
    expect(AdminAuditRowSchema.safeParse({ ...base, before_state: [1, 2] }).success).toBe(true);
  });

  it('REJECTS a missing before_state key', () => {
    // The non-obvious half of `z.unknown().nullable()`: Zod 4 made `unknown`
    // non-optional, so a construction site that forgets the field still fails
    // `validateResponseInDev` rather than shipping `undefined` (R10).
    const { before_state: _before, ...withoutBefore } = base;
    expect(AdminAuditRowSchema.safeParse(withoutBefore).success).toBe(false);
  });

  it('accepts a null entity_type — it carries no CHECK and old rows omit it', () => {
    expect(
      AdminAuditRowSchema.parse({ ...base, entity_type: null, entity_id: null }).entity_type,
    ).toBeNull();
  });

  it('accepts an unrecognised action and entity_type as plain strings', () => {
    // An enum here would turn a NEW writer elsewhere in the codebase into a 500
    // on this screen.
    expect(
      AdminAuditRowSchema.safeParse({
        ...base,
        action: 'something.invented_next_year',
        entity_type: 'brand_new_thing',
      }).success,
    ).toBe(true);
  });

  it('accepts an actor with a null display name and email', () => {
    const parsed = AdminAuditRowSchema.parse({
      ...base,
      actor: {
        id: '00000000-0000-4000-8000-000000000020',
        display_name: null,
        email: null,
      },
    });
    expect(parsed.actor?.display_name).toBeNull();
  });
});

// ─── VendorProductRoles (AECI-738 / §5.2) ────────────────────────────────────

describe('VendorProductRolesSchema', () => {
  it('requires every bucket AND the total — total is not derived by the reader', () => {
    // `total` is on the wire rather than summed client-side because `total === 0`
    // is a distinct state ("owns nothing" = unknown, not exempt) that a caller
    // must be able to test without knowing the bucket list is exhaustive.
    expect(
      VendorProductRolesSchema.safeParse({ application: 1, connector: 0, hybrid: 0 }).success,
    ).toBe(false);
    expect(
      VendorProductRolesSchema.safeParse({
        application: 1,
        connector: 0,
        hybrid: 0,
        total: 1,
      }).success,
    ).toBe(true);
  });

  it('rejects negative and fractional counts', () => {
    const base = { application: 0, connector: 0, hybrid: 0, total: 0 };
    expect(VendorProductRolesSchema.safeParse({ ...base, connector: -1 }).success).toBe(false);
    expect(VendorProductRolesSchema.safeParse({ ...base, connector: 1.5 }).success).toBe(false);
  });
});

describe('AdminVendorDetailSchema — the payer-test fields', () => {
  const detail = {
    id: '00000000-0000-4000-8000-000000000001',
    slug: 'acme',
    company_name: 'Acme',
    description: null,
    website: null,
    headquarters: null,
    logo_url: null,
    verified: false,
    promotion_status: 'promoted',
    maintained_by: 'aeci',
    last_reviewed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    entitlement: null,
    seats: [],
    seat_emails_available: true,
    pending_invites: [],
    product_count: 0,
    product_roles: { application: 0, connector: 0, hybrid: 0, total: 0 },
    is_pure_connector_vendor: false,
    integration_count: 0,
    claim_counts: { open: 0, in_review: 0, resolved: 0, rejected: 0 },
  };

  it('parses with the breakdown present', () => {
    expect(AdminVendorDetailSchema.parse(detail).is_pure_connector_vendor).toBe(false);
  });

  it('rejects a NULL breakdown — unlike the claim queue, this read cannot degrade', () => {
    // The vendor-detail breakdown comes out of the request's own `db.batch`, so
    // there is no "unavailable" state to represent; the claim-queue copy is
    // nullable precisely because its enrichment is fail-soft.
    expect(AdminVendorDetailSchema.safeParse({ ...detail, product_roles: null }).success).toBe(
      false,
    );
    expect(
      AdminVendorDetailSchema.safeParse({ ...detail, is_pure_connector_vendor: null }).success,
    ).toBe(false);
  });

  it('rejects an OMITTED breakdown (R10 — required, not optional)', () => {
    const { product_roles: _p, ...without } = detail;
    expect(AdminVendorDetailSchema.safeParse(without).success).toBe(false);
  });
});

describe('AdminVendorProductRowSchema', () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000030',
    slug: 'revit',
    name: 'Revit',
    product_role: 'application',
    is_primary: true,
    promotion_status: 'promoted',
    integration_count: 12,
    review_count: 7,
    rating_overall_avg: 4.2,
    updated_at: '2026-08-20T00:00:00.000Z',
  };

  it('accepts a row and keeps a withheld average as null', () => {
    expect(AdminVendorProductRowSchema.parse(row).rating_overall_avg).toBe(4.2);
    expect(
      AdminVendorProductRowSchema.parse({ ...row, rating_overall_avg: null }).rating_overall_avg,
    ).toBeNull();
  });

  it('rejects an OMITTED average (R10 — required-nullable, never optional)', () => {
    // A missed construction site must fail `validateResponseInDev` rather than
    // ship as `undefined` and render as "no rating".
    const { rating_overall_avg: _r, ...without } = row;
    expect(AdminVendorProductRowSchema.safeParse(without).success).toBe(false);
  });

  it('rejects a role outside the closed enum', () => {
    // Unlike a seat's `role`, `products_product_role_check` is a closed list and
    // the payer test reads it — an unrecognised value must not render as if it
    // were understood.
    expect(AdminVendorProductRowSchema.safeParse({ ...row, product_role: 'iPaaS' }).success).toBe(
      false,
    );
  });

  it('accepts an unrecognised promotion_status — the column carries no CHECK', () => {
    expect(
      AdminVendorProductRowSchema.safeParse({ ...row, promotion_status: 'something_new' }).success,
    ).toBe(true);
  });
});

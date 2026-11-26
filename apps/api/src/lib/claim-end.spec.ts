/**
 * The claim-end seam and the public logo rule (AECI-1618, ADR 0042), against the
 * real-SQLite harness. The route specs cover the callers; this covers the rules.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BatchTuple } from './audit';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, products, productVendors, profiles, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { stampOwnershipStatements } from './claimed-vendors';
import {
  integrationListConfig,
  productDetailConfig,
  productListConfig,
  productLinkColumns,
  publicProductLinkConfig,
  toIntegrationListItem,
  toProductDetail,
  isProductClaimed,
  pickPrimaryVendor,
  toOwnedProductLink,
  toProductLink,
  toProductListItem,
  toVendorDetail,
  toVendorListItem,
  vendorDetailConfig,
  wheelLogoOf,
  vendorListConfig,
} from './drizzle-helpers';
import { integrations } from '../db/schema';
import { toAlgoliaVendor } from './algolia-transforms';
import { computeMostIntegratedProduct } from './home-stats';
import {
  CLAIM_END_CAUSES,
  isSeatsChangedError,
  planOwnerSeatLapse,
  planOwnerSeatReturn,
  planSeatGrantReturn,
  planVendorHandback,
  type HandbackParams,
} from './vendor-handback';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = u(1);
const PRODUCT = u(11);
const PARTNER = u(12);
const SEAT = u(100);
const NOW = '2026-11-05T09:00:00.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const LOGO = 'https://cdn.example/widget.png';

let t: TestDb;
const params: HandbackParams = {
  vendorId: VENDOR,
  actorId: null,
  actorType: 'system',
  now: NOW,
  source: 'spec',
  vendorPlan: { tier: 'unclaimed', status: null } as never,
};

const vendorRow = async () => (await t.db.select().from(vendors).where(eq(vendors.id, VENDOR)))[0]!;
const productRow = async () =>
  (await t.db.select().from(products).where(eq(products.id, PRODUCT)))[0]!;
const rows = (action: string) => t.db.select().from(auditLog).where(eq(auditLog.action, action));

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values({
    id: VENDOR,
    slug: 'acme',
    companyName: 'Acme',
    ownedAt: OLD,
    logoUrl: 'https://cdn.example/acme.png',
    updatedAt: OLD,
  });
  await t.db.insert(products).values([
    { id: PRODUCT, slug: 'widget', name: 'Widget', logoUrl: LOGO, updatedAt: OLD },
    { id: PARTNER, slug: 'partner', name: 'Partner', logoUrl: 'https://cdn.example/p.png' },
  ]);
  await t.db
    .insert(productVendors)
    .values({ productId: PRODUCT, vendorId: VENDOR, isPrimary: true });
});

afterEach(() => t.dispose());

describe('planOwnerSeatLapse', () => {
  it('sets the date, stamps updated_at, audits the cause and names the purges', async () => {
    const plan = await planOwnerSeatLapse(t.db, {
      ...params,
      claimEndCause: CLAIM_END_CAUSES.accountErased,
    });
    expect(plan.purgeTags).toEqual(['vendor:acme', 'product:widget', 'index:products']);
    await t.db.batch(plan.stmts as BatchTuple);
    expect(await vendorRow()).toMatchObject({ claimEndedAt: NOW, updatedAt: NOW, ownedAt: OLD });
    expect((await productRow()).updatedAt).toBe(NOW);
    const [row] = await rows('vendor.claim_ended');
    expect(row).toMatchObject({ vendorId: VENDOR, entityId: VENDOR });
    expect(row!.metadata).toMatchObject({ cause: 'last-seat-account-erased' });
  });

  it('keeps an earlier date, with no second row and no purge', async () => {
    await t.db.update(vendors).set({ claimEndedAt: OLD }).where(eq(vendors.id, VENDOR));
    const plan = await planOwnerSeatLapse(t.db, params);
    expect(plan.stmts).toEqual([]);
    expect(plan.purgeTags).toEqual([]);
  });

  it('ends nothing for a vendor that never owned its record', async () => {
    await t.db.update(vendors).set({ ownedAt: null }).where(eq(vendors.id, VENDOR));
    expect((await planOwnerSeatLapse(t.db, params)).stmts).toEqual([]);
  });
});

describe('planVendorHandback', () => {
  it('sets the date although the caller clears owned_at first in its batch', async () => {
    const plan = await planVendorHandback(t.db, { ...params, claimEndCause: 'vendor-terminated' });
    await t.db.batch([
      t.db.update(vendors).set({ ownedAt: null }).where(eq(vendors.id, VENDOR)),
      ...plan.stmts,
    ] as BatchTuple);
    expect(await vendorRow()).toMatchObject({ claimEndedAt: NOW, ownedAt: null });
    expect((await rows('vendor.claim_ended'))[0]!.metadata).toMatchObject({
      cause: 'vendor-terminated',
    });
    expect(plan.purgeTags).toEqual(
      expect.arrayContaining(['vendor:acme', 'product:widget', 'index:products']),
    );
  });

  it('keeps the seat loss date, so the 14 days do not restart', async () => {
    await t.db.update(vendors).set({ claimEndedAt: OLD }).where(eq(vendors.id, VENDOR));
    const plan = await planVendorHandback(t.db, params);
    await t.db.batch(plan.stmts as BatchTuple);
    expect((await vendorRow()).claimEndedAt).toBe(OLD);
    expect(await rows('vendor.claim_ended')).toEqual([]);
  });
});

describe('the seat return', () => {
  beforeEach(async () => {
    await t.db
      .update(vendors)
      .set({
        claimEndedAt: OLD,
        brandAssetsHoldAt: OLD,
        brandAssetsRemovedAt: OLD,
      })
      .where(eq(vendors.id, VENDOR));
    await t.db.insert(profiles).values({ id: SEAT, role: 'vendor_admin', vendorId: VENDOR });
  });

  it('clears the date and both stamps with a restored row, and purges', async () => {
    const plan = await planOwnerSeatReturn(t.db, params);
    expect(plan.purgeTags).toEqual(['vendor:acme', 'product:widget', 'index:products']);
    await t.db.batch(plan.stmts as BatchTuple);
    expect(await vendorRow()).toMatchObject({
      claimEndedAt: null,
      brandAssetsHoldAt: null,
      brandAssetsRemovedAt: null,
      updatedAt: NOW,
    });
    expect((await productRow()).updatedAt).toBe(NOW);
    const [row] = await rows('vendor.claim_restored');
    expect(row!.beforeState).toMatchObject({ claim_ended_at: OLD });
  });

  it('planSeatGrantReturn does not return null when only the clear is due', async () => {
    const plan = await planSeatGrantReturn(t.db, params, SEAT);
    expect(plan?.audits.map((a) => a.action)).toEqual(['vendor.claim_restored']);
  });

  it('refuses to restore with no live seat, and aborts rather than audit a false return', async () => {
    await t.db.update(profiles).set({ bannedAt: NOW }).where(eq(profiles.id, SEAT));
    const plan = await planOwnerSeatReturn(t.db, params);
    await expect(t.db.batch(plan.stmts as BatchTuple)).rejects.toSatisfy(isSeatsChangedError);
    expect((await vendorRow()).claimEndedAt).toBe(OLD);
  });

  it('a claim that ends after the read aborts the grant', async () => {
    await t.db.update(vendors).set({ claimEndedAt: null }).where(eq(vendors.id, VENDOR));
    const plan = await planOwnerSeatReturn(t.db, params);
    await t.db.update(vendors).set({ claimEndedAt: NOW }).where(eq(vendors.id, VENDOR));
    await expect(t.db.batch(plan.stmts as BatchTuple)).rejects.toSatisfy(isSeatsChangedError);
  });

  it('a banned new seat on a never-owned company leaves it Unclaimed', async () => {
    await t.db
      .update(vendors)
      .set({ ownedAt: null, claimEndedAt: null })
      .where(eq(vendors.id, VENDOR));
    await t.db.update(profiles).set({ bannedAt: NOW }).where(eq(profiles.id, SEAT));
    const plan = await planSeatGrantReturn(t.db, params, SEAT);
    await t.db.batch([
      ...stampOwnershipStatements(t.db, VENDOR, NOW),
      ...plan!.stmts,
    ] as BatchTuple);
    expect(await vendorRow()).toMatchObject({ ownedAt: NOW, claimEndedAt: NOW });
  });
});

describe('stampOwnershipStatements', () => {
  it('moves updated_at on the vendor and its products when it lands', async () => {
    await t.db.update(vendors).set({ ownedAt: null }).where(eq(vendors.id, VENDOR));
    await t.db.batch(stampOwnershipStatements(t.db, VENDOR, NOW) as BatchTuple);
    expect(await vendorRow()).toMatchObject({ ownedAt: NOW, updatedAt: NOW });
    expect((await productRow()).updatedAt).toBe(NOW);
  });

  it('moves nothing on an owned vendor', async () => {
    await t.db.batch(stampOwnershipStatements(t.db, VENDOR, NOW) as BatchTuple);
    expect((await vendorRow()).updatedAt).toBe(OLD);
    expect((await productRow()).updatedAt).toBe(OLD);
  });
});

describe('the public mappers', () => {
  const listProduct = async () =>
    toProductListItem(
      (await t.db.query.products.findFirst({
        ...productListConfig,
        where: eq(products.id, PRODUCT),
      }))!,
    );
  const endClaim = () =>
    t.db.update(vendors).set({ claimEndedAt: NOW }).where(eq(vendors.id, VENDOR));

  it('a list card keeps its logo while claimed, and hides it when not', async () => {
    expect((await listProduct()).logo_url).toBe(LOGO);
    expect((await listProduct()).vendor?.logo_url).toBe('https://cdn.example/acme.png');
    await endClaim();
    expect((await listProduct()).logo_url).toBeNull();
    expect((await listProduct()).vendor?.logo_url).toBeNull();
  });

  it('a co-owned product stays claimed while any joined vendor is', async () => {
    await t.db.insert(vendors).values({ id: u(2), slug: 'co', companyName: 'Co', ownedAt: OLD });
    await t.db
      .insert(productVendors)
      .values({ productId: PRODUCT, vendorId: u(2), isPrimary: false });
    await endClaim();
    expect((await listProduct()).logo_url).toBe(LOGO);
  });

  it('a product detail keeps the subject logo and reports the status', async () => {
    await endClaim();
    const raw = await t.db.query.products.findFirst({
      ...productDetailConfig,
      where: eq(products.id, PRODUCT),
    });
    const detail = toProductDetail(raw!, []);
    expect(detail.logo_url).toBe(LOGO);
    expect(detail.claim_status).toBe('unclaimed');
    expect(detail.vendor?.logo_url).toBeNull();
  });

  it('a vendor detail keeps the subject logo, and its product cards hide theirs', async () => {
    await endClaim();
    const raw = await t.db.query.vendors.findFirst({
      ...vendorDetailConfig,
      where: eq(vendors.id, VENDOR),
    });
    const detail = toVendorDetail(raw!);
    expect(detail.logo_url).toBe('https://cdn.example/acme.png');
    expect(detail.claim_status).toBe('unclaimed');
    expect(detail.products[0]!.logo_url).toBeNull();
  });

  it('a vendor list row hides its logo', async () => {
    await endClaim();
    const raw = await t.db.query.vendors.findFirst({
      ...vendorListConfig,
      where: eq(vendors.id, VENDOR),
    });
    expect(toVendorListItem(raw!).logo_url).toBeNull();
  });

  it('a nested product link hides by product at any depth, and not by the wrong row', async () => {
    await t.db.insert(integrations).values({
      id: u(30),
      sourceProductId: PRODUCT,
      targetProductId: PARTNER,
      name: 'Edge',
    } as never);
    const read = async () =>
      toIntegrationListItem(
        (await t.db.query.integrations.findFirst({
          ...integrationListConfig,
          where: eq(integrations.id, u(30)),
        }))!,
      );
    // Claimed source, unclaimed target with no vendor.
    let item = await read();
    expect(item.source.logo_url).toBe(LOGO);
    expect(item.target.logo_url).toBeNull();
    await endClaim();
    item = await read();
    expect(item.source.logo_url).toBeNull();
  });

  it('a portal read of bare columns keeps the logo; a public read of the same row does not', async () => {
    await endClaim();
    const portal = await t.db.query.products.findFirst({
      columns: productLinkColumns,
      where: eq(products.id, PRODUCT),
    });
    expect(toOwnedProductLink(portal!).logo_url).toBe(LOGO);
    const open = await t.db.query.products.findFirst({
      ...publicProductLinkConfig,
      where: eq(products.id, PRODUCT),
    });
    expect(toProductLink(open!).logo_url).toBeNull();
  });

  // AECI-1851: the public mapper fails closed. A read that forgot `claimed` hides the
  // logo even of a CLAIMED listing, so a new public read cannot leak by omission.
  it('a public read that forgot the claimed column hides the logo, claimed or not', async () => {
    const bare = async () =>
      (await t.db.query.products.findFirst({
        columns: productLinkColumns,
        where: eq(products.id, PRODUCT),
      }))!;
    expect(toProductLink(await bare()).logo_url).toBeNull();
    expect(toOwnedProductLink(await bare()).logo_url).toBe(LOGO);
    await endClaim();
    expect(toProductLink(await bare()).logo_url).toBeNull();
    expect(toOwnedProductLink(await bare()).logo_url).toBe(LOGO);
  });

  // AECI-1851: the change moves no existing read. The mapper before this change is
  // copied here verbatim. Public reads select `claimed` and go through `toProductLink`;
  // portal and admin reads select bare columns and go through `toOwnedProductLink`.
  // Both must equal what the old mapper returned, for a claimed and an unclaimed row.
  it('every existing read returns the same link as before, claimed and unclaimed', async () => {
    const before = (raw: {
      id: string;
      name: string;
      slug: string;
      logoUrl: string | null;
      claimed?: number | boolean;
    }) => {
      const hidden = raw.claimed !== undefined && !raw.claimed;
      return { id: raw.id, name: raw.name, slug: raw.slug, logo_url: hidden ? null : raw.logoUrl };
    };
    const read = async () => ({
      open: (await t.db.query.products.findMany({
        ...publicProductLinkConfig,
        orderBy: (p, { asc }) => [asc(p.id)],
      }))!,
      portal: (await t.db.query.products.findMany({
        columns: productLinkColumns,
        orderBy: (p, { asc }) => [asc(p.id)],
      }))!,
    });
    // PRODUCT claimed, PARTNER unclaimed (no vendor); then both unclaimed.
    for (const step of ['claimed', 'ended'] as const) {
      if (step === 'ended') await endClaim();
      const { open, portal } = await read();
      expect(open).toHaveLength(2);
      expect(open.map(toProductLink)).toEqual(open.map(before));
      expect(portal.map(toOwnedProductLink)).toEqual(portal.map(before));
    }
    const { open } = await read();
    expect(open.map((r) => toProductLink(r).logo_url)).toEqual([null, null]);
  });

  // AECI-1851: every other public mapper already reads the claim fact off the row and
  // treats an absent one as unclaimed. These pin that, so a later edit cannot flip it.
  it('the vendor, list and search mappers hide the logo when the claim fact is absent', () => {
    const vendor = { id: VENDOR, companyName: 'Acme', slug: 'acme', logoUrl: LOGO, verified: true };
    // No `ownedAt` / `claimEndedAt` on the row: the read forgot them.
    expect(pickPrimaryVendor([{ isPrimary: true, vendor }])!.logo_url).toBeNull();
    expect(isProductClaimed({ productVendors: [{ isPrimary: true, vendor }] } as never)).toBe(
      false,
    );
    expect(
      toAlgoliaVendor({ ...vendor, productCount: 0, integrationCount: 0 } as never).logo_url,
    ).toBeNull();
    // And with the facts present, a claimed vendor keeps it.
    expect(
      pickPrimaryVendor([
        { isPrimary: true, vendor: { ...vendor, ownedAt: OLD, claimEndedAt: null } },
      ])!.logo_url,
    ).toBe(LOGO);
  });

  it('the home page headline hides an unclaimed logo', async () => {
    await t.db.update(products).set({ integrationCount: 9 }).where(eq(products.id, PRODUCT));
    expect((await computeMostIntegratedProduct(t.db))?.product.logo_url).toBe(LOGO);
    await endClaim();
    expect((await computeMostIntegratedProduct(t.db))?.product.logo_url).toBeNull();
  });
});

// AECI-2018, ruling 64 (2026-11-24): a wheel tile shows a product's logo whenever we hold
// one, claimed or not. It widens the logo rule for the wheel ONLY, so these pin both
// halves: the wheel's own field carries the logo, and every other read is unchanged.
describe("the integrations wheel's marks (ruling 64)", () => {
  const PARTNER_LOGO = 'https://cdn.example/p.png';
  const UPLOAD = 'https://cdn.example/vendor-upload.png';
  const SOURCED = 'https://cdn.example/aeci-sourced.png';
  const detail = async () =>
    toProductDetail(
      (await t.db.query.products.findFirst({
        ...productDetailConfig,
        where: eq(products.id, PRODUCT),
      }))!,
      [],
    );
  const mark = async (id: string) => (await detail()).wheel_marks!.find((m) => m.product_id === id);
  const listPartner = async () =>
    toProductListItem(
      (await t.db.query.products.findFirst({
        ...productListConfig,
        where: eq(products.id, PARTNER),
      }))!,
    );
  const setPartner = (values: Partial<typeof products.$inferInsert>) =>
    t.db.update(products).set(values).where(eq(products.id, PARTNER));
  /** PARTNER joins Acme, so it is claimed while Acme's claim runs. */
  const claimPartner = () =>
    t.db.insert(productVendors).values({ productId: PARTNER, vendorId: VENDOR, isPrimary: true });
  const endClaim = () =>
    t.db.update(vendors).set({ claimEndedAt: NOW }).where(eq(vendors.id, VENDOR));

  beforeEach(async () => {
    // PRODUCT (claimed through Acme) integrates with PARTNER, which has no vendor, so is
    // unclaimed, and holds promote's logo (`logo_source` NULL).
    await t.db.insert(integrations).values({
      id: u(40),
      sourceProductId: PRODUCT,
      targetProductId: PARTNER,
      name: 'Edge',
    } as never);
  });

  it("carries an unclaimed partner's sourced logo, and says it is unclaimed", async () => {
    expect(await mark(PARTNER)).toEqual({
      product_id: PARTNER,
      logo_url: PARTNER_LOGO,
      claim_status: 'unclaimed',
    });
  });

  it("leaves the row's own link, the list card and the integration list as they were", async () => {
    const page = await detail();
    expect(page.integrations_as_source[0]!.target).toMatchObject({
      id: PARTNER,
      logo_url: null,
    });
    expect((await listPartner()).logo_url).toBeNull();
    const item = toIntegrationListItem(
      (await t.db.query.integrations.findFirst({
        ...integrationListConfig,
        where: eq(integrations.id, u(40)),
      }))!,
    );
    expect(item.target.logo_url).toBeNull();
  });

  it("shows a claimed partner's own upload", async () => {
    await claimPartner();
    await setPartner({ logoUrl: UPLOAD, logoSource: 'vendor', sourcedLogoUrl: SOURCED });
    expect(await mark(PARTNER)).toEqual({
      product_id: PARTNER,
      logo_url: UPLOAD,
      claim_status: 'claimed',
    });
  });

  // Vendor Terms 1.3: permission to show an uploaded logo ends with the claim. The daily
  // removal job restores the sourced logo later, and a hold can delay it, so for that
  // window the stored column still holds the upload. The wheel never shows it.
  it('after the claim ends and before the removal job runs: the sourced logo, never the upload', async () => {
    await claimPartner();
    await setPartner({ logoUrl: UPLOAD, logoSource: 'vendor', sourcedLogoUrl: SOURCED });
    await endClaim();
    expect(await mark(PARTNER)).toEqual({
      product_id: PARTNER,
      logo_url: SOURCED,
      claim_status: 'unclaimed',
    });
    // Under a removal hold, the same.
    await t.db.update(vendors).set({ brandAssetsHoldAt: NOW }).where(eq(vendors.id, VENDOR));
    expect((await mark(PARTNER))!.logo_url).toBe(SOURCED);
    // With no sourced logo on record, no logo at all.
    await setPartner({ sourcedLogoUrl: null });
    expect((await mark(PARTNER))!.logo_url).toBeNull();
  });

  it("shows an AECi correction's logo on an unclaimed partner", async () => {
    await setPartner({ logoUrl: SOURCED, logoSource: 'admin' });
    expect((await mark(PARTNER))!.logo_url).toBe(SOURCED);
  });

  it('fails closed: an unclaimed product read without logo_source shows no logo', () => {
    const bare = { id: PARTNER, name: 'Partner', slug: 'partner', logoUrl: UPLOAD };
    expect(wheelLogoOf(bare, false)).toBeNull();
    expect(wheelLogoOf(bare, true)).toBe(UPLOAD);
  });

  it("carries the page product's own mark for the centre, by the same rule", async () => {
    expect(await mark(PRODUCT)).toEqual({
      product_id: PRODUCT,
      logo_url: LOGO,
      claim_status: 'claimed',
    });
    await t.db
      .update(products)
      .set({ logoSource: 'vendor', sourcedLogoUrl: SOURCED })
      .where(eq(products.id, PRODUCT));
    await endClaim();
    expect(await mark(PRODUCT)).toEqual({
      product_id: PRODUCT,
      logo_url: SOURCED,
      claim_status: 'unclaimed',
    });
  });

  it('lists a product once, whichever side and however many rows', async () => {
    await t.db.insert(integrations).values([
      { id: u(41), sourceProductId: PARTNER, targetProductId: PRODUCT, name: 'Back' },
      { id: u(42), sourceProductId: PRODUCT, targetProductId: PARTNER, name: 'Again' },
    ] as never);
    expect((await detail()).wheel_marks!.map((m) => m.product_id)).toEqual([PRODUCT, PARTNER]);
  });

  // A removal on objection clears `logo_url` and `sourced_logo_url` (routes/logos.ts), so
  // the wheel holds nothing to show. Its purge is `product:{partner}`, which every product
  // page carries for each partner (the web resolver spec pins that half).
  it('shows no logo once the logo is removed', async () => {
    await setPartner({ logoUrl: null, sourcedLogoUrl: null });
    expect((await mark(PARTNER))!.logo_url).toBeNull();
  });
});

describe('the ops backfills (AECI-1618)', () => {
  const ops = join(process.cwd(), '..', '..', 'scripts', 'ops', '2026-11-brand-asset-backfill');
  const file = (name: string) => readFileSync(join(ops, name), 'utf8');

  it('claim-ended: the dry run lists what the apply changes, and a re-run is a no-op', async () => {
    const dry = () => t.raw.prepare(file('claim-ended-dry-run.sql')).all() as { id: string }[];
    expect(dry().map((r) => r.id)).toEqual([VENDOR]);
    t.raw.exec(file('claim-ended-apply.sql'));
    expect((await vendorRow()).claimEndedAt).not.toBeNull();
    expect(await rows('vendor.claim_ended')).toHaveLength(1);
    expect(dry()).toEqual([]);
    t.raw.exec(file('claim-ended-apply.sql'));
    expect(await rows('vendor.claim_ended')).toHaveLength(1);
  });

  it('claim-ended: leaves a vendor with an unbanned seat', async () => {
    await t.db.insert(profiles).values({ id: SEAT, role: 'vendor_admin', vendorId: VENDOR });
    t.raw.exec(file('claim-ended-apply.sql'));
    expect((await vendorRow()).claimEndedAt).toBeNull();
  });

  it('sourced-logo: takes the earliest before state, only when promote owned it', async () => {
    await t.db.update(products).set({ logoSource: 'vendor' }).where(eq(products.id, PRODUCT));
    await t.db.update(products).set({ logoSource: 'vendor' }).where(eq(products.id, PARTNER));
    await t.db.insert(auditLog).values([
      {
        id: u(200),
        actorType: 'user',
        action: 'product.updated',
        entityType: 'product',
        entityId: PRODUCT,
        beforeState: { logoUrl: 'https://aeci.example/first.png', logoSource: null },
        afterState: { logoUrl: LOGO, logoSource: 'vendor' },
        createdAt: '2026-02-01T00:00:00.000Z',
      },
      {
        id: u(201),
        actorType: 'user',
        action: 'product.updated',
        entityType: 'product',
        entityId: PRODUCT,
        beforeState: { logoUrl: LOGO, logoSource: 'vendor' },
        afterState: { logoUrl: LOGO, logoSource: 'vendor' },
        createdAt: '2026-03-01T00:00:00.000Z',
      },
      {
        id: u(202),
        actorType: 'user',
        action: 'product.updated',
        entityType: 'product',
        entityId: PARTNER,
        beforeState: { logoUrl: 'https://vendor.example/old.png', logoSource: 'vendor' },
        afterState: { logoUrl: 'https://cdn.example/p.png', logoSource: 'vendor' },
        createdAt: '2026-02-01T00:00:00.000Z',
      },
    ]);
    const dry = t.raw.prepare(file('sourced-logo-dry-run.sql')).all() as {
      id: string;
      proposed_sourced_logo: string;
    }[];
    expect(dry).toEqual([
      expect.objectContaining({
        id: PRODUCT,
        proposed_sourced_logo: 'https://aeci.example/first.png',
      }),
    ]);
    t.raw.exec(file('sourced-logo-apply.sql'));
    expect((await productRow()).sourcedLogoUrl).toBe('https://aeci.example/first.png');
    const partner = (await t.db.select().from(products).where(eq(products.id, PARTNER)))[0]!;
    expect(partner.sourcedLogoUrl).toBeNull();
    const audited = await t.db.select().from(auditLog).where(eq(auditLog.entityId, PRODUCT));
    expect(audited).toHaveLength(3);
  });
});

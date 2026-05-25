/**
 * AECI-53 / Phase 2 §6.4 — integration test for the slug-normalization script.
 *
 * Seeds 4 deterministic rows (one canonical vendor, one non-canonical vendor,
 * a pair of products that collide on `slugify(name)` so the vendor-suffix
 * disambiguation path is exercised), runs `backfillSlugs` once, asserts the
 * resulting DB state, then runs it again and asserts the second pass is a
 * no-op (the AECI-53 idempotency acceptance criterion).
 *
 * Gated on `TEST_DATABASE_URL` (a direct postgresql:// URL pointing at a
 * Postgres with the schema migrations applied — typically the local Supabase
 * dev container). `describe.skipIf` keeps the CI unit lane silent when unset.
 *
 * The script under test uses the Accelerate-flavoured `DATABASE_URL` in
 * production; this test bypasses Accelerate for speed and to keep the test
 * self-contained.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backfillSlugs, type BackfillPrisma } from '../../scripts/backfill-slugs';

const TEST_RUN_TAG = `AECI53Test${Date.now()}`;

const testDbUrl = process.env.TEST_DATABASE_URL;

const silentLogger = { log: () => {}, warn: () => {} };

describe.skipIf(!testDbUrl)('backfillSlugs — integration (AECI-53)', () => {
  let prisma: PrismaClient;
  // Captured during seed so we can re-fetch by id without depending on slug
  // values (which the script will rewrite).
  const seeded: {
    vendorA?: { id: string };
    vendorB?: { id: string };
    productP1?: { id: string };
    productP2?: { id: string };
  } = {};

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: testDbUrl });

    // Vendor A — non-canonical slug, should be rewritten.
    const vendorA = await prisma.vendor.create({
      data: {
        slug: `placeholder-vendor-a-${TEST_RUN_TAG}`.toLowerCase(),
        companyName: `Procore ${TEST_RUN_TAG}`,
      },
      select: { id: true },
    });
    seeded.vendorA = vendorA;

    // Vendor B — already at canonical slug, should be SKIPPED.
    const vendorB = await prisma.vendor.create({
      data: {
        slug: `autodesk-${TEST_RUN_TAG}`.toLowerCase(),
        companyName: `Autodesk ${TEST_RUN_TAG}`,
      },
      select: { id: true },
    });
    seeded.vendorB = vendorB;

    // Product P1 — non-canonical slug, primary vendor A. After normalization,
    // canonical = `build-${tag}`. No collision yet at write time.
    const productP1 = await prisma.product.create({
      data: {
        slug: `placeholder-product-1-${TEST_RUN_TAG}`.toLowerCase(),
        name: `Build ${TEST_RUN_TAG}`,
        productVendors: {
          create: { vendorId: vendorA.id, isPrimary: true },
        },
      },
      select: { id: true },
    });
    seeded.productP1 = productP1;

    // Product P2 — non-canonical slug, primary vendor B, SAME name as P1.
    // After P1 writes, P2 sees the canonical slug taken and falls through to
    // the vendor-suffix path: `build-${tag}-autodesk-${tag}`.
    const productP2 = await prisma.product.create({
      data: {
        slug: `placeholder-product-2-${TEST_RUN_TAG}`.toLowerCase(),
        name: `Build ${TEST_RUN_TAG}`,
        productVendors: {
          create: { vendorId: vendorB.id, isPrimary: true },
        },
      },
      select: { id: true },
    });
    seeded.productP2 = productP2;
  });

  afterAll(async () => {
    if (!prisma) return;
    // Wipe in dependency order: join rows → products → vendors.
    if (seeded.productP1 || seeded.productP2) {
      await prisma.productVendor.deleteMany({
        where: {
          productId: {
            in: [seeded.productP1?.id, seeded.productP2?.id].filter(Boolean) as string[],
          },
        },
      });
      await prisma.product.deleteMany({
        where: {
          id: { in: [seeded.productP1?.id, seeded.productP2?.id].filter(Boolean) as string[] },
        },
      });
    }
    if (seeded.vendorA || seeded.vendorB) {
      await prisma.vendor.deleteMany({
        where: { id: { in: [seeded.vendorA?.id, seeded.vendorB?.id].filter(Boolean) as string[] } },
      });
    }
    await prisma.$disconnect();
  });

  const expectedVendorASlug = `procore-${TEST_RUN_TAG}`.toLowerCase();
  const expectedVendorBSlug = `autodesk-${TEST_RUN_TAG}`.toLowerCase();
  const expectedProductP1Slug = `build-${TEST_RUN_TAG}`.toLowerCase();
  const expectedProductP2Slug = `build-${TEST_RUN_TAG}-autodesk-${TEST_RUN_TAG}`.toLowerCase();

  it('first run normalizes non-canonical rows and disambiguates collisions', async () => {
    const result = await backfillSlugs(prisma as unknown as BackfillPrisma, {
      dryRun: false,
      log: silentLogger,
    });

    // Per-table counters scoped to ALL rows in the DB. Other rows may exist in
    // the dev DB, so we assert lower bounds on `scanned` and exact deltas via
    // direct row reads below.
    expect(result.vendors.scanned).toBeGreaterThanOrEqual(2);
    expect(result.products.scanned).toBeGreaterThanOrEqual(2);
    // The seeded rows account for 1 vendor update + 2 product updates +
    // 1 product collision. We can't assert exact totals because pre-existing
    // dev-DB rows might also need normalization; but at minimum the seeded
    // changes must have happened.
    expect(result.vendors.updated).toBeGreaterThanOrEqual(1);
    expect(result.products.updated).toBeGreaterThanOrEqual(2);
    expect(result.products.collisions).toBeGreaterThanOrEqual(1);

    const vendorA = await prisma.vendor.findUniqueOrThrow({
      where: { id: seeded.vendorA!.id },
    });
    const vendorB = await prisma.vendor.findUniqueOrThrow({
      where: { id: seeded.vendorB!.id },
    });
    const productP1 = await prisma.product.findUniqueOrThrow({
      where: { id: seeded.productP1!.id },
    });
    const productP2 = await prisma.product.findUniqueOrThrow({
      where: { id: seeded.productP2!.id },
    });

    expect(vendorA.slug).toBe(expectedVendorASlug);
    expect(vendorB.slug).toBe(expectedVendorBSlug);
    expect(productP1.slug).toBe(expectedProductP1Slug);
    expect(productP2.slug).toBe(expectedProductP2Slug);
  });

  it('second run is a no-op (idempotency)', async () => {
    const result = await backfillSlugs(prisma as unknown as BackfillPrisma, {
      dryRun: false,
      log: silentLogger,
    });

    // The 4 seeded rows are now canonical → must contribute 0 updates and
    // 4 skips. Other pre-existing dev-DB rows that were canonical at the start
    // would still be skipped (canonical stays canonical), so updated/collisions
    // for the seeded set is 0; for the whole DB also 0 since this is run #2.
    expect(result.vendors.updated).toBe(0);
    expect(result.products.updated).toBe(0);
    expect(result.vendors.collisions).toBe(0);
    expect(result.products.collisions).toBe(0);

    // The 4 seeded rows must appear in `skipped`.
    expect(result.vendors.skipped).toBeGreaterThanOrEqual(2);
    expect(result.products.skipped).toBeGreaterThanOrEqual(2);

    // DB state unchanged.
    const vendorA = await prisma.vendor.findUniqueOrThrow({ where: { id: seeded.vendorA!.id } });
    expect(vendorA.slug).toBe(expectedVendorASlug);
    const productP2 = await prisma.product.findUniqueOrThrow({
      where: { id: seeded.productP2!.id },
    });
    expect(productP2.slug).toBe(expectedProductP2Slug);
  });

  it('dry-run plans the same writes without mutating the DB', async () => {
    // Rotate the seeded vendor A's slug back to a placeholder so dry-run has
    // something to plan against. Use a unique placeholder so we don't collide
    // with anything else in the DB.
    const tempPlaceholder = `dryrun-placeholder-${TEST_RUN_TAG}`.toLowerCase();
    await prisma.vendor.update({
      where: { id: seeded.vendorA!.id },
      data: { slug: tempPlaceholder },
    });

    const result = await backfillSlugs(prisma as unknown as BackfillPrisma, {
      dryRun: true,
      log: silentLogger,
    });

    expect(result.vendors.updated).toBeGreaterThanOrEqual(1);
    // DB should NOT have changed despite the planned write.
    const vendorA = await prisma.vendor.findUniqueOrThrow({ where: { id: seeded.vendorA!.id } });
    expect(vendorA.slug).toBe(tempPlaceholder);

    // Restore to canonical so the test class leaves the DB in a clean state.
    await prisma.vendor.update({
      where: { id: seeded.vendorA!.id },
      data: { slug: expectedVendorASlug },
    });
  });
});

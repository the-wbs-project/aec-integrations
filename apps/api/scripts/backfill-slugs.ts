/**
 * AECI-53 / Phase 2 §6.4 — slug normalization for products and vendors.
 *
 * Reads every vendor and product, recomputes `slugify(displayName)` from
 * `packages/shared/src/slug.ts`, and writes the result back when the stored
 * slug differs from the canonical form. Idempotent: rows already at canonical
 * slugs are SKIPPED.
 *
 * Why "normalization" and not "backfill from NULL":
 * AECI-39 baselined `products.slug` and `vendors.slug` as `NOT NULL` with a
 * UNIQUE index, so there is no `slug IS NULL` population case. The §6.4 intent
 * — guarantee every row has a canonical, unique slug before Wave 3 ships the
 * public `/products/:slug` and `/vendors/:slug` routes — survives unchanged.
 *
 * Vendors are processed before products so a vendor's post-normalization slug
 * is available when its product needs the vendor-suffix disambiguation path.
 *
 * Runs through the privileged Postgres role (Prisma Accelerate is configured
 * with the service-role connection string), bypassing RLS by design.
 *
 * Usage:
 *   pnpm --filter @aeci/api db:backfill-slugs              # apply
 *   pnpm --filter @aeci/api db:backfill-slugs -- --dry-run # plan only
 */

import { PrismaClient } from '@prisma/client/edge';
import { withAccelerate } from '@prisma/extension-accelerate';

import { disambiguateSlug, SlugReservedError, slugify } from '@aeci/shared/slug';

export type Counters = {
  scanned: number;
  updated: number;
  skipped: number;
  collisions: number;
  errored: number;
};

export type BackfillResult = {
  vendors: Counters;
  products: Counters;
};

/**
 * Minimal Prisma surface this script uses. Accepts either an accelerated
 * client (production path) or a vanilla `PrismaClient` (test path) since the
 * normalization algorithm is agnostic to the transport.
 */
export type BackfillPrisma = {
  vendor: {
    findMany: (args: {
      select: { id: true; slug: true; companyName: true };
    }) => Promise<{ id: string; slug: string; companyName: string }[]>;
    update: (args: { where: { id: string }; data: { slug: string } }) => Promise<unknown>;
  };
  product: {
    findMany: (args: {
      select: {
        id: true;
        slug: true;
        name: true;
        productVendors: { select: { vendorId: true; isPrimary: true } };
      };
    }) => Promise<
      {
        id: string;
        slug: string;
        name: string;
        productVendors: { vendorId: string; isPrimary: boolean }[];
      }[]
    >;
    update: (args: { where: { id: string }; data: { slug: string } }) => Promise<unknown>;
  };
};

export type BackfillOpts = {
  dryRun: boolean;
  /** Defaults to `console`. Tests inject a recorder. */
  log?: Pick<Console, 'log' | 'warn'>;
};

function emptyCounters(): Counters {
  return { scanned: 0, updated: 0, skipped: 0, collisions: 0, errored: 0 };
}

function computeCanonical(
  displayName: string,
): { ok: true; slug: string } | { ok: false; reason: 'reserved' | 'empty'; error: Error } {
  try {
    return { ok: true, slug: slugify(displayName) };
  } catch (err) {
    if (err instanceof SlugReservedError) {
      return { ok: false, reason: 'reserved', error: err };
    }
    if (err instanceof TypeError) {
      return { ok: false, reason: 'empty', error: err };
    }
    throw err;
  }
}

export async function backfillSlugs(
  prisma: BackfillPrisma,
  opts: BackfillOpts,
): Promise<BackfillResult> {
  const log = opts.log ?? console;
  const result: BackfillResult = {
    vendors: emptyCounters(),
    products: emptyCounters(),
  };

  // ─── Pass 1: vendors ───────────────────────────────────────────────────────
  const vendors = await prisma.vendor.findMany({
    select: { id: true, slug: true, companyName: true },
  });
  const vendorSlugs = new Set(vendors.map((v) => v.slug));
  /** Post-normalization slug per vendor id — fed into product disambiguation. */
  const vendorSlugById = new Map<string, string>();

  for (const v of vendors) {
    result.vendors.scanned += 1;

    const canonical = computeCanonical(v.companyName);
    if (!canonical.ok) {
      log.warn(
        `[vendor] ${v.id} ${JSON.stringify(v.companyName)} → ERRORED (${canonical.reason}: ${canonical.error.message})`,
      );
      result.vendors.errored += 1;
      // Keep the existing slug in the lookup so downstream products don't
      // accidentally reuse it.
      vendorSlugById.set(v.id, v.slug);
      continue;
    }

    if (v.slug === canonical.slug) {
      log.log(`[vendor] ${v.id} ${v.companyName} → SKIPPED (already ${v.slug})`);
      result.vendors.skipped += 1;
      vendorSlugById.set(v.id, v.slug);
      continue;
    }

    const existingMinusSelf = new Set(vendorSlugs);
    existingMinusSelf.delete(v.slug);
    const final = disambiguateSlug(canonical.slug, [...existingMinusSelf]);

    // Idempotency: a row already at its RESOLVED slug needs no write. The
    // `v.slug === canonical.slug` check above only catches rows at the naive
    // canonical; a previously-disambiguated row (whose canonical collides) is
    // already at `final` here, so re-writing it would be a redundant update and
    // break the "second run is a no-op" contract.
    if (final === v.slug) {
      log.log(`[vendor] ${v.id} ${v.companyName} → SKIPPED (already ${v.slug})`);
      result.vendors.skipped += 1;
      vendorSlugById.set(v.id, v.slug);
      continue;
    }

    if (final !== canonical.slug) {
      result.vendors.collisions += 1;
    }

    const action = opts.dryRun ? 'WOULD WRITE' : 'UPDATED';
    log.log(`[vendor] ${v.id} ${v.companyName} → ${final} (${action})`);

    if (!opts.dryRun) {
      await prisma.vendor.update({ where: { id: v.id }, data: { slug: final } });
      vendorSlugs.delete(v.slug);
      vendorSlugs.add(final);
    }
    vendorSlugById.set(v.id, final);
    result.vendors.updated += 1;
  }

  // ─── Pass 2: products ──────────────────────────────────────────────────────
  const products = await prisma.product.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
      productVendors: { select: { vendorId: true, isPrimary: true } },
    },
  });
  const productSlugs = new Set(products.map((p) => p.slug));

  for (const p of products) {
    result.products.scanned += 1;

    const canonical = computeCanonical(p.name);
    if (!canonical.ok) {
      log.warn(
        `[product] ${p.id} ${JSON.stringify(p.name)} → ERRORED (${canonical.reason}: ${canonical.error.message})`,
      );
      result.products.errored += 1;
      continue;
    }

    if (p.slug === canonical.slug) {
      log.log(`[product] ${p.id} ${p.name} → SKIPPED (already ${p.slug})`);
      result.products.skipped += 1;
      continue;
    }

    const primaryVendor = p.productVendors.find((pv) => pv.isPrimary);
    const vendorSlug = primaryVendor ? vendorSlugById.get(primaryVendor.vendorId) : undefined;

    const existingMinusSelf = new Set(productSlugs);
    existingMinusSelf.delete(p.slug);
    const final = disambiguateSlug(canonical.slug, [...existingMinusSelf], vendorSlug);

    // Idempotency (see the vendor pass): a previously-disambiguated product —
    // canonical collides, so it carries a vendor suffix — lands here on every
    // subsequent run because its slug never equals the naive canonical. Without
    // this guard it would be re-written and counted as `updated` forever.
    if (final === p.slug) {
      log.log(`[product] ${p.id} ${p.name} → SKIPPED (already ${p.slug})`);
      result.products.skipped += 1;
      continue;
    }

    if (final !== canonical.slug) {
      result.products.collisions += 1;
    }

    const action = opts.dryRun ? 'WOULD WRITE' : 'UPDATED';
    log.log(`[product] ${p.id} ${p.name} → ${final} (${action})`);

    if (!opts.dryRun) {
      await prisma.product.update({ where: { id: p.id }, data: { slug: final } });
      productSlugs.delete(p.slug);
      productSlugs.add(final);
    }
    result.products.updated += 1;
  }

  return result;
}

function formatSummary(label: string, c: Counters): string {
  return (
    `${label}: scanned=${c.scanned} updated=${c.updated} skipped=${c.skipped} ` +
    `collisions=${c.collisions} errored=${c.errored}`
  );
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required (set in apps/api/.dev.vars).');
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl }).$extends(withAccelerate());
  console.log(`Slug backfill starting (dryRun=${dryRun}).`);

  try {
    const result = await backfillSlugs(prisma as unknown as BackfillPrisma, { dryRun });
    console.log('─── Summary ─────────────────────────────────────────');
    console.log(formatSummary('vendors', result.vendors));
    console.log(formatSummary('products', result.products));
    const totalErrored = result.vendors.errored + result.products.errored;
    if (totalErrored > 0) {
      console.warn(`Completed with ${totalErrored} ERRORED row(s) — review the log above.`);
      process.exitCode = 2;
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Run main() only when invoked directly (not when imported by tests).
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('backfill-slugs.ts') || process.argv[1].endsWith('backfill-slugs.js'));
if (invokedDirectly) {
  void main();
}

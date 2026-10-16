/**
 * Test seeds for `billing_accounts` and `licenses` (AECI-1355). Since plan resolution
 * reads licenses, a spec that needs a vendor on Managed seeds a live license here,
 * where it used to seed an active `vendor_entitlements` row.
 *
 * Raw inserts, not the `lib/license.ts` builders, so a spec states the exact row it
 * means and no audit row lands beside it.
 */

import { eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { billingAccounts, licenses } from '../db/schema';

let licenseSeq = 0;

/** The vendor's billing account, created on first use (one per vendor, as in prod). */
export async function seedBillingAccount(db: Db, vendorId: string): Promise<string> {
  const [existing] = await db
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(eq(billingAccounts.vendorId, vendorId));
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await db.insert(billingAccounts).values({ id, vendorId, name: `Account ${vendorId}` });
  return id;
}

export interface LicenseSeed {
  /** A fixed id, for a spec that names the license in a static table. */
  id?: string;
  /** The product the license is assigned to. Omit or `null` for an unassigned slot. */
  productId?: string | null;
  source?: string;
  endsAt?: string | null;
  /** Set to end the license. `null` (the default) is live. */
  endedAt?: string | null;
  endReason?: string | null;
  /** Stamps `updated_at`, for the cursor specs. */
  updatedAt?: string;
  cancelAtTermEnd?: boolean;
  cancelReason?: string | null;
}

/** One license on the vendor's billing account. Live and perpetual by default. */
export async function seedLicense(
  db: Db,
  vendorId: string,
  seed: LicenseSeed = {},
): Promise<string> {
  const billingAccountId = await seedBillingAccount(db, vendorId);
  const id = seed.id ?? `66666666-6666-4666-8666-${String(++licenseSeq).padStart(12, '0')}`;
  await db.insert(licenses).values({
    id,
    billingAccountId,
    source: seed.source ?? 'complimentary',
    startsAt: '2026-01-01T00:00:00.000Z',
    endsAt: seed.endsAt ?? null,
    endedAt: seed.endedAt ?? null,
    endReason: seed.endReason ?? null,
    assignedProductId: seed.productId ?? null,
    assignedAt: seed.productId ? '2026-01-01T00:00:00.000Z' : null,
    ...(seed.updatedAt ? { updatedAt: seed.updatedAt } : {}),
    ...(seed.cancelAtTermEnd !== undefined ? { cancelAtTermEnd: seed.cancelAtTermEnd } : {}),
    ...(seed.cancelReason !== undefined ? { cancelReason: seed.cancelReason } : {}),
  });
  return id;
}

/** The three license rows a seat-return spec reads after the grant (ruled 2026-10-15). */
export interface CancelFlagSeeds {
  /** Live, flagged `vendor-banned`: the seat grant clears it. */
  banned: string;
  /** Live, flagged by someone else (reason NULL): the grant leaves it. */
  other: string;
  /** Ended, still carrying `vendor-banned`: history, the grant leaves it. */
  ended: string;
}

/** Seed a banned vendor's license flags: one to clear, two to leave alone. */
export async function seedCancelFlags(db: Db, vendorId: string): Promise<CancelFlagSeeds> {
  return {
    banned: await seedLicense(db, vendorId, {
      cancelAtTermEnd: true,
      cancelReason: 'vendor-banned',
    }),
    other: await seedLicense(db, vendorId, {
      source: 'invoice',
      cancelAtTermEnd: true,
      cancelReason: null,
    }),
    ended: await seedLicense(db, vendorId, {
      endedAt: '2026-06-01T00:00:00.000Z',
      endReason: 'lapsed',
      cancelAtTermEnd: true,
      cancelReason: 'vendor-banned',
    }),
  };
}

/** The cancel flags on the three seeded rows, keyed as seeded. */
export async function readCancelFlags(
  db: Db,
  seeds: CancelFlagSeeds,
): Promise<
  Record<keyof CancelFlagSeeds, { cancelAtTermEnd: boolean; cancelReason: string | null }>
> {
  const rows = await db
    .select({
      id: licenses.id,
      cancelAtTermEnd: licenses.cancelAtTermEnd,
      cancelReason: licenses.cancelReason,
    })
    .from(licenses);
  const of = (id: string) => {
    const row = rows.find((r) => r.id === id)!;
    return { cancelAtTermEnd: row.cancelAtTermEnd, cancelReason: row.cancelReason };
  };
  return { banned: of(seeds.banned), other: of(seeds.other), ended: of(seeds.ended) };
}

/** What {@link readCancelFlags} returns once a seat grant has run. */
export const FLAGS_AFTER_GRANT = {
  banned: { cancelAtTermEnd: false, cancelReason: null },
  other: { cancelAtTermEnd: true, cancelReason: null },
  ended: { cancelAtTermEnd: true, cancelReason: 'vendor-banned' },
} as const;

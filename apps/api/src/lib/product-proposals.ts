/**
 * Product proposals (AECI-1416, E6b.4; ADR 0042, `DATABASE_SCHEMA.md` §8.6f).
 *
 * The shared predicates and batch sentinels for `product_proposals`. Promote writes a
 * proposal (`routes/promote.ts`), and the admin "Return records to AECi" action deletes
 * the vendor's open ones (`routes/admin-vendors.ts`). An owner seat accepts or declines one
 * (`routes/vendor-proposals.ts`, AECI-1417), and the accept batch reuses
 * {@link proposalVendorOwnedSentinel}.
 */

import { and, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { productProposals, vendors } from '../db/schema';
import type { BatchStmt } from './audit';
import { ONE_ROW } from './integration-claims';

/**
 * The only product ref a proposal accepts (ruled 2026-10-19): the review app's
 * `p:` prefix and a record id, `rec` plus alphanumerics. The review app builds it
 * with `productRefFor` and parses it with the same `REC_ID_RE`. A proposal is keyed on
 * its ref once and forever (Q5), so a throwaway label such as `p1` would make a second,
 * different product look like a re-send of the first. A product for an unowned vendor
 * is not checked: its ref is never stored.
 */
export const PROPOSAL_REF_RE = /^p:rec[A-Za-z0-9]+$/;

/** A vendor's open proposals: `decision IS NULL`. */
export function openProposalsFor(vendorId: string): SQL {
  return and(eq(productProposals.vendorId, vendorId), isNull(productProposals.decision)) as SQL;
}

const raise = (db: Db, condition: SQL): BatchStmt =>
  db
    .select({ guard: sql`CASE WHEN ${condition} THEN json('product-proposal-race') END` })
    .from(ONE_ROW);

/**
 * The commit-time half of a promote proposal (ruled 2026-10-19). The plan stores a
 * proposal because the addressed vendor owned its record at read time. A "Return
 * records to AECi" that commits before the batch makes the vendor AECi's again, and the
 * product should then be created, not proposed. This aborts the batch when the vendor
 * is no longer owned. The inverse of the AECI-1415 ownership sentinels, same mechanism:
 * the batch raises "malformed JSON", and the caller re-reads ownership to name it
 * (`VENDOR_RETURNED_DURING_PROMOTE`).
 */
export function proposalVendorOwnedSentinel(db: Db, vendorId: string): BatchStmt {
  return raise(
    db,
    sql`NOT EXISTS (SELECT 1 FROM ${vendors} WHERE ${and(eq(vendors.id, vendorId), isNotNull(vendors.ownedAt))})`,
  );
}

/**
 * The return's guard on its own delete. The return reads the open proposal ids, records
 * them in its audit row and deletes them. A proposal a promote stores between that read
 * and the batch would be deleted without being recorded, so this aborts the batch when
 * the vendor's open count differs from `expected` at commit. A count, not an id list:
 * D1 caps a statement at 100 bound parameters, and a vendor may hold more proposals than
 * that. The caller re-reads and answers `409 VENDOR_PROPOSALS_CHANGED`.
 */
export function openProposalsUnchangedSentinel(
  db: Db,
  vendorId: string,
  expected: number,
): BatchStmt {
  return raise(
    db,
    sql`(SELECT count(*) FROM ${productProposals} WHERE ${openProposalsFor(vendorId)}) <> ${expected}`,
  );
}

/** The ids of a vendor's open proposals, oldest first. */
export async function loadOpenProposalIds(db: Db, vendorId: string): Promise<string[]> {
  const rows = await db
    .select({ id: productProposals.id })
    .from(productProposals)
    .where(openProposalsFor(vendorId))
    .orderBy(productProposals.proposedAt, productProposals.id);
  return rows.map((r) => r.id);
}

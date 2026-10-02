/**
 * The checklist step rules (AECI-1217 / `STAGE_2_PAID_TIERS_SPEC.md` §13.10), as
 * pure functions over facts the route has already read.
 *
 * The route (`routes/vendor-checklist.ts`) owns the queries. This module owns what
 * the facts mean, so each rule is tested without a database, and both reads apply
 * the same rule.
 *
 * Three rules every step follows:
 *
 *  1. **A step with nothing to do is done.** No unclaimed rows means the claim
 *     step is done. No claims means the data-flows step is done.
 *  2. **"Ever checked" is enough.** A set `last_reviewed_at` or
 *     `integrations_reviewed_at` completes its step however old it is.
 *  3. **The plan decides only whether "Confirm data flows" counts.** It counts
 *     when the product's plan holds `attestation.author`, which is Managed today.
 *     It is optional otherwise. It reads the product's own plan block (§13.7),
 *     never the vendor-wide one, so nothing changes here when per-product plans
 *     land.
 */

import type {
  ChecklistStepStatus,
  ProductChecklistStep,
  VendorChecklistStep,
  VendorEntitlementBlock,
} from '@aeci/shared';

/** The capability that makes "Confirm data flows" count (§13.1 decision 6). */
export const DATA_FLOWS_CAPABILITY = 'attestation.author';

/** The product columns the product steps read. */
export interface ChecklistProductFacts {
  maintainedBy: string;
  lastReviewedAt: string | null;
  integrationsReviewedAt: string | null;
}

/** What the route counted for one product. */
export interface ChecklistProductCounts {
  /** Seeded rows naming the vendor as builder, still unclaimed, with no open
   *  owner contest, that the vendor can claim on this product's plan. */
  unclaimedRows: number;
  /** Claims on this product's attestable integrations with no live attestation
   *  by the vendor. */
  unattestedClaims: number;
}

/** The vendor columns and counts the vendor steps read. */
export interface ChecklistVendorFacts {
  maintainedBy: string;
  lastReviewedAt: string | null;
  seatCount: number;
  inviteCount: number;
}

/** A score: counted steps done, counted steps in total, and whether they match. */
export interface ChecklistScore {
  done: number;
  total: number;
  complete: boolean;
}

/** `done` beats everything. An unfinished step is `todo` when it counts and
 *  `optional` when it does not. */
function statusOf(isDone: boolean, counts: boolean): ChecklistStepStatus {
  if (isDone) return 'done';
  return counts ? 'todo' : 'optional';
}

/** "Checked" for a vendor or product row: maintained by the vendor and reviewed.
 *  Exported for the daily vendor snapshot's `products_confirmed` (AECI-1210), so
 *  the trend and the checklist can never disagree about what "confirmed" means. */
export function isChecked(row: { maintainedBy: string; lastReviewedAt: string | null }): boolean {
  return row.maintainedBy === 'vendor' && row.lastReviewedAt !== null;
}

/** Whether "Confirm data flows" counts on a product with this plan. */
export function dataFlowsCount(plan: VendorEntitlementBlock): boolean {
  return plan.capabilities.includes(DATA_FLOWS_CAPABILITY);
}

/** The four product steps, in display order. */
export function productChecklistSteps(
  product: ChecklistProductFacts,
  counts: ChecklistProductCounts,
  plan: VendorEntitlementBlock,
): ProductChecklistStep[] {
  const flowsCount = dataFlowsCount(plan);
  return [
    { key: 'product_details', status: statusOf(isChecked(product), true), counts: true },
    {
      key: 'integration_list',
      status: statusOf(product.integrationsReviewedAt !== null, true),
      counts: true,
    },
    {
      key: 'claim_integrations',
      status: statusOf(counts.unclaimedRows === 0, true),
      counts: true,
    },
    {
      key: 'confirm_data_flows',
      status: statusOf(counts.unattestedClaims === 0, flowsCount),
      counts: flowsCount,
    },
  ];
}

/** The score over the counted steps. */
export function checklistScore(
  steps: readonly { status: ChecklistStepStatus; counts: boolean }[],
): ChecklistScore {
  const counted = steps.filter((step) => step.counts);
  const done = counted.filter((step) => step.status === 'done').length;
  return { done, total: counted.length, complete: done === counted.length };
}

/**
 * The three vendor steps, in display order.
 *
 * "Finish each product checklist" is done when every owned product is complete.
 * With no products it is done, by rule 1. "Invite a colleague" never counts. It is
 * done when a second seat exists or any invite row exists, sent, accepted or
 * revoked, because §13.10 says "any `vendor_seat_invites` row".
 */
export function vendorChecklistSteps(
  vendor: ChecklistVendorFacts,
  productsComplete: readonly boolean[],
): VendorChecklistStep[] {
  return [
    { key: 'company_details', status: statusOf(isChecked(vendor), true), counts: true },
    {
      key: 'finish_products',
      status: statusOf(
        productsComplete.every((complete) => complete),
        true,
      ),
      counts: true,
    },
    {
      key: 'invite_colleague',
      status: statusOf(vendor.seatCount >= 2 || vendor.inviteCount > 0, false),
      counts: false,
    },
  ];
}

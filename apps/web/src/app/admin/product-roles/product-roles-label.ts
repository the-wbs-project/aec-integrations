import type { VendorProductRoles } from '@aeci/shared';

/**
 * How a vendor's product-role breakdown reads, everywhere it reads (AECI-738):
 * the §5.2 payer-test signal on `/admin/claims` and the Basics row on
 * `/admin/vendors/:id`.
 *
 * One implementation, on the `entitlement-term.ts` precedent — the two surfaces
 * show the same value about the same vendor, and an operator who saw
 * "3 application" on one screen and something else on the other would have no
 * way to tell which one to trust before making a one-way decision.
 *
 * ── WHY `application` IS SPELLED OUT ─────────────────────────────────────────
 * `RoleBadge` (`app/products/role-badge.ts`) renders NOTHING for `application`,
 * and that is correct on a public per-product surface: a product row with no chip
 * is an endpoint, read one row at a time. It is wrong for an aggregate. The §5.2
 * test asks whether the vendor owns *any* endpoint product, so "all 3 are
 * application" is the affirmative answer — and the entire point of AECI-738 is
 * that the operator was previously inferring that answer from the ABSENCE of a
 * chip on a public page. A label that also renders nothing would reproduce the
 * defect inside the console.
 *
 * Roles are listed endpoint-first (`application`, `hybrid`, then `connector`)
 * because that is the order the payer test asks about them; empty buckets are
 * omitted rather than rendered as `0`, so the line stays scannable.
 */
export function productRolesLabel(roles: VendorProductRoles): string {
  const parts: string[] = [];
  if (roles.application > 0) {
    parts.push(
      $localize`:@@admin.productRoles.application:${roles.application}:COUNT: application`,
    );
  }
  if (roles.hybrid > 0) {
    parts.push($localize`:@@admin.productRoles.hybrid:${roles.hybrid}:COUNT: hybrid`);
  }
  if (roles.connector > 0) {
    parts.push($localize`:@@admin.productRoles.connector:${roles.connector}:COUNT: connector`);
  }
  return parts.join(' · ');
}

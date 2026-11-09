import type { ListingHideEntityType, ListingHideKind } from '@aeci/shared';

/**
 * Why AECi hid a listing, in words (AECI-1238, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11d.6). One place for the three labels, because the admin form, the admin state
 * block and the vendor's portal message all name the kind, and they must agree.
 *
 * `defunct` reads by record: a company is defunct, a product is discontinued.
 */
export function listingHideKindLabel(
  kind: ListingHideKind,
  entityType: ListingHideEntityType = 'vendor',
): string {
  switch (kind) {
    case 'complaint_under_review':
      return $localize`:@@listingHide.kind.complaint:Complaint under review`;
    case 'lawful_order':
      return $localize`:@@listingHide.kind.lawfulOrder:Lawful order`;
    case 'defunct':
      return entityType === 'product'
        ? $localize`:@@listingHide.kind.discontinued:Product is discontinued`
        : $localize`:@@listingHide.kind.defunct:Company is defunct`;
  }
}

import type {
  ConnectorMappingStatus,
  VendorConnectorDecider,
  VendorConnectorMapping,
} from '@aeci/shared';

/**
 * The connector catalogue seat's vocabulary (AECI-1083), shared by the Catalogue
 * tab's rows, its filter and the edit form, so a status reads the same in the row
 * and in the control that changes it.
 *
 * These are the VENDOR's words, not the operator console's
 * (`admin/connectors/connector-labels.ts`). The admin labels are shorthand for people
 * who triage thousands of listings ("Parked", "No record"). A connector vendor meets
 * each status once, on its own listings, and needs the label to say what it asserts.
 */
export function catalogueStatusLabel(status: ConnectorMappingStatus | string): string {
  switch (status) {
    case 'mapped':
      return $localize`:@@vendor.catalogue.status.mapped:Matched`;
    case 'ruled_out':
      return $localize`:@@vendor.catalogue.status.ruledOut:Not this product`;
    case 'out_of_scope':
      return $localize`:@@vendor.catalogue.status.outOfScope:Outside AECi's scope`;
    case 'no_record':
      return $localize`:@@vendor.catalogue.status.noRecord:Not listed on AECi`;
    case 'ambiguous_parked':
      return $localize`:@@vendor.catalogue.status.parked:Unclear, set aside`;
    default:
      return status;
  }
}

/** One sentence per status, under the status picker, so the choice is informed. */
export function catalogueStatusHelp(status: ConnectorMappingStatus | string): string {
  switch (status) {
    case 'mapped':
      return $localize`:@@vendor.catalogue.statusHelp.mapped:This listing is the product you choose.`;
    case 'ruled_out':
      return $localize`:@@vendor.catalogue.statusHelp.ruledOut:This listing is not the product you choose. AECi stops suggesting it.`;
    case 'out_of_scope':
      return $localize`:@@vendor.catalogue.statusHelp.outOfScope:This listing is not software AECi covers, so it matches no product.`;
    case 'no_record':
      return $localize`:@@vendor.catalogue.statusHelp.noRecord:The product this listing connects to is not on AECi yet.`;
    case 'ambiguous_parked':
      return $localize`:@@vendor.catalogue.statusHelp.parked:It is not clear which product this listing is. It is set aside for now.`;
    default:
      return '';
  }
}

export function catalogueConfidenceLabel(confidence: string | null): string {
  switch (confidence) {
    case 'low':
      return $localize`:@@vendor.catalogue.confidence.low:Low`;
    case 'medium':
      return $localize`:@@vendor.catalogue.confidence.medium:Medium`;
    case 'high':
      return $localize`:@@vendor.catalogue.confidence.high:High`;
    default:
      return $localize`:@@vendor.catalogue.confidence.none:Not set`;
  }
}

/** Who stands behind a row, or `null` when nobody is recorded. */
export function catalogueDeciderLabel(decider: VendorConnectorDecider | null): string | null {
  switch (decider) {
    case 'vendor':
      return $localize`:@@vendor.catalogue.decider.vendor:Confirmed by your company`;
    case 'aeci':
      return $localize`:@@vendor.catalogue.decider.aeci:Decided by AECi`;
    case 'automatic':
      return $localize`:@@vendor.catalogue.decider.automatic:Suggested by name, not confirmed`;
    default:
      return null;
  }
}

/**
 * The row's headline: what the mapping says, in one phrase. A product-bearing status
 * names the product; a decision status stands alone. A `mapped` row whose product
 * was deleted says so rather than rendering an empty name (§9a.4 keeps it visible).
 */
export function catalogueMappingSummary(m: VendorConnectorMapping): string {
  const status = catalogueStatusLabel(m.status);
  if (m.status !== 'mapped' && m.status !== 'ruled_out') return status;
  if (m.product === null) {
    return $localize`:@@vendor.catalogue.summary.productGone:${status}:STATUS: to a product no longer on AECi`;
  }
  const name = m.product.name;
  return m.status === 'mapped'
    ? $localize`:@@vendor.catalogue.summary.mapped:Matched to ${name}:PRODUCT:`
    : $localize`:@@vendor.catalogue.summary.ruledOut:Not ${name}:PRODUCT:`;
}

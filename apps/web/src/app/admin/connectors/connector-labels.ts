/**
 * `connector_stub_mappings.status` and `.confidence` in words, shared by the
 * triage table and the AECI-724 edit control so a status reads the same in the
 * row and in the form that changes it.
 */
export function mappingStatusLabel(status: string): string {
  switch (status) {
    case 'mapped':
      return $localize`:@@admin.connectors.status.mapped:Matched`;
    case 'ruled_out':
      return $localize`:@@admin.connectors.status.ruledOut:Ruled out`;
    case 'out_of_scope':
      return $localize`:@@admin.connectors.status.outOfScope:Out of scope`;
    case 'no_record':
      return $localize`:@@admin.connectors.status.noRecord:No record`;
    case 'ambiguous_parked':
      return $localize`:@@admin.connectors.status.parked:Parked`;
    default:
      return status;
  }
}

export function mappingConfidenceLabel(confidence: string | null): string {
  switch (confidence) {
    case 'low':
      return $localize`:@@admin.connectors.confidence.low:Low`;
    case 'medium':
      return $localize`:@@admin.connectors.confidence.medium:Medium`;
    case 'high':
      return $localize`:@@admin.connectors.confidence.high:High`;
    default:
      return $localize`:@@admin.connectors.confidence.none:Not set`;
  }
}

import type { ConnectorMappingStatus } from '@aeci/shared';

import type { ConsoleChipTone } from '../../shared/chip/chip';
import { adminStatusTone } from '../console/status-tones';

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

/**
 * The console chip tone for a mapping status (AECI-2125). Exhaustive, so a new
 * status is a compile error here rather than a silent default.
 */
export function mappingStatusTone(status: ConnectorMappingStatus): ConsoleChipTone {
  switch (status) {
    case 'mapped':
      return adminStatusTone('matched');
    case 'ruled_out':
      return adminStatusTone('ruledOut');
    case 'out_of_scope':
      return adminStatusTone('outOfScope');
    case 'no_record':
      return adminStatusTone('noRecord');
    case 'ambiguous_parked':
      return adminStatusTone('parkedAsAmbiguous');
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

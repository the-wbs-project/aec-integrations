import type { VendorOwnedIntegrations } from '@aeci/shared';

/**
 * How a vendor's owned-integration count reads, everywhere it reads (AECI-1041):
 * the §5.2 step 1a owner signal on `/admin/claims`, `/admin/claims/:id` and
 * `/admin/vendors/:id`. One implementation for the reason `productRolesLabel`
 * gives: two screens describing one vendor differently would leave the operator
 * unsure which to trust before a one-way decision.
 *
 * The total leads, because it is the number the owner test reads. The split
 * follows only when both tables hold rows, so a vendor whose rows all sit in one
 * table reads as one plain number. "Direct" is the `integrations` table and "via
 * a connector" is `connector_evidenced_pairs`, which is where a third-party
 * owner's rows mostly live.
 */
export function ownedIntegrationsLabel(owned: VendorOwnedIntegrations): string {
  if (owned.total === 0) {
    return $localize`:@@admin.ownedIntegrations.none:None`;
  }
  if (owned.integrations > 0 && owned.connector_evidenced > 0) {
    return $localize`:@@admin.ownedIntegrations.split:${owned.total}:TOTAL: (${owned.integrations}:DIRECT: direct, ${owned.connector_evidenced}:EVIDENCED: via a connector)`;
  }
  if (owned.connector_evidenced > 0) {
    return $localize`:@@admin.ownedIntegrations.evidencedOnly:${owned.total}:TOTAL: (via a connector)`;
  }
  return $localize`:@@admin.ownedIntegrations.directOnly:${owned.total}:TOTAL: (direct)`;
}

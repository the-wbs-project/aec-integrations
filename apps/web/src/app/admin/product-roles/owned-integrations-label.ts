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

/**
 * Where a vendor lands on the §5.2 payer test once the owner clause is known
 * (`STAGE_2_SPEC.md` §8.10(1)).
 *
 * - `not-connector`: not a pure connector vendor, or the role signal is
 *   unavailable. The connector carve-out does not apply.
 * - `third-party-owner`: a pure connector vendor that owns live integrations. It
 *   pays if it wants to manage them, and takes the ordinary Grant.
 * - `catalogue-only`: a pure connector vendor that owns none. §8.9 applies: park
 *   the claim and use the catalogue-maintenance seat.
 * - `owner-unknown`: a pure connector vendor whose owned count could not be read.
 *   The operator must check step 1a before parking.
 *
 * The console only answers "is it an owner". Whether it wants to manage those
 * integrations is the claimant's answer, so every surface warns and none gates.
 */
export type ConnectorPayerState =
  | 'not-connector'
  | 'third-party-owner'
  | 'catalogue-only'
  | 'owner-unknown';

export function connectorPayerState(
  isPureConnectorVendor: boolean | null,
  owned: VendorOwnedIntegrations | null,
): ConnectorPayerState {
  if (isPureConnectorVendor !== true) return 'not-connector';
  if (owned === null) return 'owner-unknown';
  return owned.total > 0 ? 'third-party-owner' : 'catalogue-only';
}

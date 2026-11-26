import type { ContextDirection, OwnedIntegration } from '@aeci/shared';

/**
 * What the flow controls read of a row. An owned card passes its `OwnedIntegration`.
 * The integration detail page builds one from `VendorIntegration.owner_flows` for a
 * row whose owner also makes an endpoint (AECI-2039). Directions are framed against
 * `product_a` in both.
 *
 * Its own file (AECI-2213) so the history dialog and the table share it without an
 * import cycle. `vendor-owned-flows.ts` re-exports both names.
 */
export type OwnedFlowsRow = Pick<
  OwnedIntegration,
  'id' | 'flows' | 'flows_editable' | 'retired_at' | 'claimed_at' | 'product_a' | 'product_b'
>;

/**
 * One direction against the row's endpoint A: "From {A} to {B}", "From {B} to {A}" or
 * "Both ways". Shared with the owned row's detail page (AECI-2045), so the flows and the
 * Overview's Direction row read alike.
 */
export function ownedDirectionText(
  row: Pick<OwnedIntegration, 'product_a' | 'product_b'>,
  direction: ContextDirection,
): string {
  const a = row.product_a.name;
  const b = row.product_b.name;
  switch (direction) {
    case 'outbound':
      return $localize`:@@vendor.ownedFlows.direction.aToB:From ${a}:a: to ${b}:b:`;
    case 'inbound':
      return $localize`:@@vendor.ownedFlows.direction.bToA:From ${b}:b: to ${a}:a:`;
    case 'both':
      return $localize`:@@vendor.im.direction.both:Both ways`;
  }
}

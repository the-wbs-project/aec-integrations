import type { ProductDetail } from '@aeci/shared';

import { correctionInSlot, isUnderReview } from '../shared/field-caption/field-caption-facts';

import { splitIntegrationLanes } from './connector-lane-grouping';
import { groupPoweredIntegrations } from './powered-hub-grouping';

/**
 * Whether the product page has no integrations on record at all (AECI-1786).
 *
 * The same test as the facts card's zero (`ProductFactsCard.count`): the stored
 * `integration_count` is zero, and the page lists no row under Integrations or
 * "Integrations it powers". A stored zero over listed rows is a lagging column, not a
 * zero, and a connector that only powers edges has integrations on record. So the
 * section never says "We have no integrations for X on record" while the card prints a
 * number, or the reverse.
 *
 * The section adds one condition of its own: no §13.7 reach line. A product with
 * reachable pairs and nothing on record keeps the plain empty state and the reach line
 * (`ProductIntegrationsSection.zero`).
 */
export function hasNoIntegrationsOnRecord(p: ProductDetail): boolean {
  if (p.integration_count !== 0) return false;
  const rows =
    splitIntegrationLanes(p.integrations_as_source, p.integrations_as_target).rowCount +
    groupPoweredIntegrations(p.integrations_as_connector, p.slug).pairCount;
  return rows === 0;
}

/**
 * Whether the "No directory" line may show (PLAN.md §5.2): the product has a vendor and
 * no integrations page link on record. The facts card's Resources group shows the link
 * on the same condition (`p.tool_integrations_url`).
 *
 * It also stays off while AECi has the link hidden for checking (the API nulls the URL,
 * §11d.7) and when AECi removed the link (AECI-1628). In both cases the card already says
 * what happened to the link, and "we have not found one" would contradict it.
 */
export function showsNoIntegrationsDirectory(p: ProductDetail): boolean {
  if (!p.vendor || p.tool_integrations_url) return false;
  if (isUnderReview(p.under_review, 'tool_integrations_url')) return false;
  return !correctionInSlot(p.captions?.corrections, 'tool_integrations_url', false);
}

import type { ConnectorKind } from '@aeci/shared';

/**
 * The public words for a connector's kind (AECI-2037, `docs/STAGE_1_5_SPEC.md` §13.13).
 *
 * One `connector` role covers two kinds (AECI-2035 ruling 1). Every surface that names
 * a product's role, or varies a sentence by it, takes its words from this file, so the
 * three labels live in one place:
 *
 * | Kind | Label |
 * |---|---|
 * | `integration_platform` | Integration platform |
 * | `sync_service` | Sync Service |
 * | NULL (unclassified, or no kind on the record) | Connector |
 *
 * A card built from an Algolia hit has no kind until AECI-1662, so it reads NULL and
 * keeps "Connector". The data role, the Vendor Terms term "connector vendor" and
 * promote routing do not change.
 *
 * Sentences that use the generic noun for both kinds ("delivered through a connector",
 * "reachable via connectors") are not varied here: they stay true for every kind.
 *
 * Callers resolve the kind with `connectorKindFor(role, kind)` from `@aeci/shared/api/connector-kind`,
 * which reads NULL for an `application` and for a value outside the vocabulary.
 *
 * Each variant is a whole message with its own id, never a noun spliced into a
 * sentence, so a translator sees complete sentences.
 */

/** The role chip's words for a `connector`: the kind's label, or "Connector". */
export function connectorKindLabel(kind: ConnectorKind | null): string {
  switch (kind) {
    case 'integration_platform':
      return $localize`:@@products.role.integrationPlatform:Integration platform`;
    case 'sync_service':
      return $localize`:@@products.role.syncService:Sync Service`;
    default:
      return $localize`:@@products.role.connector:Connector`;
  }
}

/**
 * The heading of the powered section, with its count. A Sync Service delivers its
 * pairs (ruling 2), so its heading says so. The other two keep "it powers".
 */
export function poweredHeading(kind: ConnectorKind | null, count: number): string {
  if (kind === 'sync_service') {
    return $localize`:@@products.detail.body.powers.heading.syncService:Integrations it delivers (${count}:count:)`;
  }
  return $localize`:@@products.detail.body.powers.heading:Integrations it powers (${count}:count:)`;
}

/**
 * The first sentence of the powered section's empty state. The correction sentence
 * that follows it is the same for every kind and stays in the template, with its link.
 */
export function poweredEmptyLead(kind: ConnectorKind | null): string {
  switch (kind) {
    case 'integration_platform':
      return $localize`:@@products.detail.body.powers.empty.integrationPlatform:No integrations are recorded as running on this integration platform yet.`;
    case 'sync_service':
      return $localize`:@@products.detail.body.powers.empty.syncService:No integrations are recorded for this Sync Service yet.`;
    default:
      return $localize`:@@products.detail.body.powers.empty.connector:No integrations are recorded as running on this connector yet.`;
  }
}

/** The section-nav label for the powered section: the heading without its count. */
export function poweredNavLabel(kind: ConnectorKind | null): string {
  if (kind === 'sync_service') {
    return $localize`:@@products.detail.nav.powers.syncService:Integrations it delivers`;
  }
  return $localize`:@@products.detail.nav.powers:Integrations it powers`;
}

/**
 * The hero reach line (§13.6). A Sync Service runs the sync itself, so it "syncs".
 * The other two keep "connects". `count` is distinct endpoint products, never pairs.
 */
export function heroConnectsLabel(kind: ConnectorKind | null, count: number): string {
  if (kind === 'sync_service') {
    return count === 1
      ? $localize`:@@products.detail.hero.syncs.one:Syncs 1 product in the AEC Integrations catalog`
      : $localize`:@@products.detail.hero.syncs.other:Syncs ${count}:count: products in the AEC Integrations catalog`;
  }
  return count === 1
    ? $localize`:@@products.detail.hero.connects.one:Connects 1 product in the AEC Integrations catalog`
    : $localize`:@@products.detail.hero.connects.other:Connects ${count}:count: products in the AEC Integrations catalog`;
}

/** The connector meta description (§13.6 rung 1), by kind. NULL keeps today's text. */
export function connectorMetaDescription(
  kind: ConnectorKind | null,
  name: string,
  reach: number,
): string {
  switch (kind) {
    case 'integration_platform':
      return $localize`:@@products.detail.meta.connector.integrationPlatform:${name}:name: is an integration platform for ${reach}:count: construction and AEC products. See the integrations it powers and reviews from the teams using them.`;
    case 'sync_service':
      return $localize`:@@products.detail.meta.connector.syncService:${name}:name: is a Sync Service that syncs ${reach}:count: construction and AEC products. See the integrations it delivers and reviews from the teams using them.`;
    default:
      return $localize`:@@products.detail.meta.connector:${name}:name: connects ${reach}:count: construction and AEC products. See the integrations it powers and reviews from the teams using them.`;
  }
}

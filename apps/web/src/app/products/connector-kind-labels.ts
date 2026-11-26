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
 * Since AECI-1662 the Algolia record carries the kind, so a search card reads it
 * too. A record indexed before then reads NULL and keeps "Connector". The same
 * labels name the two options of the "Connector type" filter on `/search` and
 * `/products`. The data role, the Vendor Terms term "connector vendor" and
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

/**
 * The hero wheel's title on a connector's own page (QA pass on AECI-2035): what its
 * tiles are, the products its pairs reach. A Sync Service "syncs" them, as the reach
 * line says. The other two "connect" them.
 */
export function connectorWheelCaption(kind: ConnectorKind | null): string {
  if (kind === 'sync_service') {
    return $localize`:@@products.detail.hero.wheel.connector.caption.syncService:Products it syncs`;
  }
  return $localize`:@@products.detail.hero.wheel.connector.caption:Products it connects`;
}

/**
 * The integration count on a product card, list row or search card, at zero, for a
 * `connector` (QA pass on AECI-2035). "Not yet connected" is false of a connector,
 * whose job is to connect others: it means it has no integration on record yet. A Sync
 * Service delivers its integrations (ruling 2). The other two power them.
 */
export function connectorZeroStatLabel(kind: ConnectorKind | null): string {
  if (kind === 'sync_service') {
    return $localize`:@@products.stat.none.syncService:No integrations delivered yet`;
  }
  return $localize`:@@products.stat.none.connector:No integrations powered yet`;
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

/** One endpoint of a pair, as the "Not offered or endorsed by" line names it. */
export interface EndorsementEndpoint {
  readonly productId: string;
  readonly productName: string;
  /** The endpoint's primary vendor, or `null` when none is on record. */
  readonly vendor: { readonly id: string; readonly name: string } | null;
}

/** What {@link syncServiceEndorsementLine} reads off one pair page mechanism card. */
export interface EndorsementInput {
  readonly connectorKind: ConnectorKind | null;
  /** The connector product behind the card (`via ?? powered_by_product`). */
  readonly connectorProductId: string | null;
  /** The connector product's primary vendor (`connector_vendor_id`). */
  readonly connectorVendorId: string | null;
  /** The card's "Offered by" vendor (`built_by_vendor`), or `null` when unknown. */
  readonly offeredBy: { readonly id: string; readonly name: string } | null;
  readonly context: EndorsementEndpoint;
  readonly other: EndorsementEndpoint;
}

/**
 * The pair page's "Not offered or endorsed by" line (AECI-2043, ruling 12 on AECI-2035).
 *
 * Counsel advised on 2026-11-04 that a page suggesting sponsorship or endorsement is
 * actionable. A Sync Service card shows two other companies' products under "Offered by
 * Rivets", so every such card says, in one plain line, who offers it and that the two
 * endpoint vendors do not:
 *
 *     Offered by Rivets. Not offered or endorsed by Procore Technologies or Acumatica.
 *
 * `null`, so no line, when:
 * - the connector is not a Sync Service: a native card, an Integration platform, or an
 *   unclassified connector (`connectorKindFor` already reads NULL for an `application`);
 * - the Sync Service is itself one of the two endpoints, so its vendor does offer it;
 * - every endpoint vendor is the vendor that offers it, so there is no one to name.
 *
 * Edge cases:
 * - both endpoints from one vendor: the vendor is named once;
 * - an endpoint vendor that is the offering vendor, or the Sync Service's own vendor, is
 *   left out, since the sentence would be false for it;
 * - an endpoint with no vendor on record: "the vendor of {product}";
 * - the offering vendor unknown: the "Offered by" sentence is left out.
 *
 * Each sentence is a whole message with its own id.
 */
export function syncServiceEndorsementLine(input: EndorsementInput): string | null {
  if (input.connectorKind !== 'sync_service') return null;
  const { context, other } = input;
  if (
    input.connectorProductId !== null &&
    (input.connectorProductId === context.productId || input.connectorProductId === other.productId)
  ) {
    return null;
  }
  const offering = new Set(
    [input.offeredBy?.id, input.connectorVendorId].filter((id): id is string => !!id),
  );
  const vendorNames: string[] = [];
  const productNames: string[] = [];
  const seenVendors = new Set<string>();
  for (const endpoint of [context, other]) {
    const vendor = endpoint.vendor;
    if (!vendor) {
      productNames.push(endpoint.productName);
      continue;
    }
    if (offering.has(vendor.id) || seenVendors.has(vendor.id)) continue;
    seenVendors.add(vendor.id);
    vendorNames.push(vendor.name);
  }
  const notEndorsed = notEndorsedSentence(vendorNames, productNames);
  if (!notEndorsed) return null;
  if (!input.offeredBy) return notEndorsed;
  const offeredBy = $localize`:@@pair.mechanism.syncService.offeredBy:Offered by ${input.offeredBy.name}:vendor:.`;
  return `${offeredBy} ${notEndorsed}`;
}

/** The second sentence, by how many endpoint vendors are named and how many are not on record. */
function notEndorsedSentence(
  vendors: readonly string[],
  products: readonly string[],
): string | null {
  const [first, second] = vendors;
  const [productA, productB] = products;
  if (first !== undefined && second !== undefined) {
    return $localize`:@@pair.mechanism.syncService.notEndorsed.twoVendors:Not offered or endorsed by ${first}:vendorA: or ${second}:vendorB:.`;
  }
  if (first !== undefined && productA !== undefined) {
    return $localize`:@@pair.mechanism.syncService.notEndorsed.vendorAndProduct:Not offered or endorsed by ${first}:vendor: or the vendor of ${productA}:product:.`;
  }
  if (first !== undefined) {
    return $localize`:@@pair.mechanism.syncService.notEndorsed.oneVendor:Not offered or endorsed by ${first}:vendor:.`;
  }
  if (productA !== undefined && productB !== undefined) {
    return $localize`:@@pair.mechanism.syncService.notEndorsed.twoProducts:Not offered or endorsed by the vendors of ${productA}:productA: or ${productB}:productB:.`;
  }
  if (productA !== undefined) {
    return $localize`:@@pair.mechanism.syncService.notEndorsed.oneProduct:Not offered or endorsed by the vendor of ${productA}:product:.`;
  }
  return null;
}

/**
 * Per-side integration links: the one mapping from stored rows to the wire shape
 * (AECI-1007). The write routes (`routes/vendor-integration-links.ts`), the pair
 * page read and the vendor portal list all fold rows through {@link toSideLinks},
 * so the three cannot disagree about which kind fills which field.
 */
import {
  EMPTY_SIDE_LINKS,
  IntegrationLinkKindSchema,
  type IntegrationLinkKind,
  type IntegrationSideLinks,
  type PairVendorLinks,
} from '@aeci/shared';

const COLUMN: Record<IntegrationLinkKind, keyof IntegrationSideLinks> = {
  listing: 'listing_url',
  docs: 'docs_url',
};

export interface StoredVendorLink {
  productId: string;
  kind: string;
  url: string;
}

/** Fold one side's stored rows into `{ listing_url, docs_url }`. An unknown kind
 *  (impossible past the table CHECK) is dropped rather than shipped. */
export function toSideLinks(
  rows: ReadonlyArray<Pick<StoredVendorLink, 'kind' | 'url'>>,
): IntegrationSideLinks {
  const out: IntegrationSideLinks = { ...EMPTY_SIDE_LINKS };
  for (const row of rows) {
    const parsed = IntegrationLinkKindSchema.safeParse(row.kind);
    if (parsed.success) out[COLUMN[parsed.data]] = row.url;
  }
  return out;
}

/** One side's links, or `null` when it has set neither kind. */
function sideOrNull(rows: readonly StoredVendorLink[], productId: string) {
  const mine = rows.filter((r) => r.productId === productId);
  return mine.length > 0 ? toSideLinks(mine) : null;
}

/**
 * Both sides, framed to the pair page's context product. Reads only the row's
 * CURRENT endpoints, so a link left behind by an endpoint re-point (the product is
 * no longer on the row) is never rendered against a product it does not describe.
 */
export function toPairVendorLinks(
  rows: readonly StoredVendorLink[],
  contextProductId: string,
  otherProductId: string,
): PairVendorLinks {
  return {
    context: sideOrNull(rows, contextProductId),
    other: sideOrNull(rows, otherProductId),
  };
}

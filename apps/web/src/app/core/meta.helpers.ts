/**
 * Angular-free helpers backing `MetaService`. Kept in a separate module so the
 * Vitest spec can import them under plain Node without dragging Angular's
 * partial-compiled platform packages into the test process — same pattern as
 * `theme.helpers.ts`.
 *
 * Spec anchor: docs/STAGE_1_PHASE_2_SPEC.md §9 (§9.1 metadata, §9.2 JSON-LD).
 */

import type { ProductDetail, VendorDetail } from '@aeci/shared';

export const META_DESCRIPTION_MAX = 155;

/**
 * Default OG image when an entity has no logo of its own. We reuse the brand
 * monogram so we don't have to ship a new asset for AECI-51. Some scrapers
 * (older LinkedIn, some Slack flavors) render SVG OG images inconsistently;
 * Phase 7 polish should replace this with a rendered 1200×630 PNG.
 */
export const DEFAULT_OG_IMAGE = '/branding/monogram-light.svg';

/** Lightweight meta-tag shape; structurally compatible with Angular's `MetaDefinition`. */
export type MetaTag = { name: string; content: string } | { property: string; content: string };

export interface OgTagInput {
  title: string;
  description: string;
  url: string;
  type: string;
  image: string;
}

export interface SoftwareApplicationLd {
  '@context': 'https://schema.org';
  '@type': 'SoftwareApplication';
  name: string;
  description?: string;
  url?: string;
  applicationCategory?: string;
  applicationSubCategory?: string;
}

export interface OrganizationLd {
  '@context': 'https://schema.org';
  '@type': 'Organization';
  name: string;
  url?: string;
  logo?: string;
  foundingDate?: string;
  address?: string;
}

/**
 * Truncate `input` to ≤ `max` characters at a word boundary, appending an
 * ellipsis. Returns `''` for null / empty / whitespace-only input. If a single
 * token exceeds `max`, hard-cut at `max - 1` and append '…'.
 */
export function truncateAtWordBoundary(
  input: string | null | undefined,
  max: number = META_DESCRIPTION_MAX,
): string {
  if (!input) return '';
  const collapsed = input.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return '';
  if (collapsed.length <= max) return collapsed;

  const slice = collapsed.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut}…`;
}

/** Strip query string and fragment from a URL. Returns input unchanged if it doesn't parse. */
export function stripQueryParams(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Compose a page title: `{name}{suffix}`. Suffix carries any locale chrome. */
export function buildEntityTitle(name: string, suffix: string): string {
  return `${name}${suffix}`;
}

/**
 * Entity-kind classifier shared by the service. Kept here (not in
 * `meta.service.ts`) so the kind→og:type decision is pure-testable in plain
 * Node without booting Angular. `index` joins browse kinds in the `website`
 * bucket — an index page is not an article — while detail kinds map to
 * `article`. See Phase 2 Spec §9.1.
 */
export type MetaEntityKind =
  | 'product'
  | 'vendor'
  | 'integration'
  | 'category'
  | 'discipline'
  | 'phase'
  | 'index';

const BROWSE_META_KINDS: ReadonlySet<MetaEntityKind> = new Set(['category', 'discipline', 'phase']);

const WEBSITE_META_KINDS: ReadonlySet<MetaEntityKind> = new Set([...BROWSE_META_KINDS, 'index']);

export function isBrowseKind(kind: MetaEntityKind): boolean {
  return BROWSE_META_KINDS.has(kind);
}

export function ogTypeForKind(kind: MetaEntityKind): 'article' | 'website' {
  return WEBSITE_META_KINDS.has(kind) ? 'website' : 'article';
}

/** Build the full Open Graph + Twitter Card tag set in one pass. */
export function buildOgTags(input: OgTagInput): MetaTag[] {
  return [
    { property: 'og:title', content: input.title },
    { property: 'og:description', content: input.description },
    { property: 'og:url', content: input.url },
    { property: 'og:type', content: input.type },
    { property: 'og:image', content: input.image },
    { name: 'twitter:card', content: 'summary_large_image' },
    { name: 'twitter:title', content: input.title },
    { name: 'twitter:description', content: input.description },
    { name: 'twitter:image', content: input.image },
  ];
}

/**
 * Build a `schema.org/SoftwareApplication` JSON-LD payload for a product
 * detail page (§9.2). Null / empty source fields are omitted so output is
 * stable.
 *
 * `applicationSubCategory` maps to the first discipline because §9.2 names
 * the schema.org field without specifying which AECi taxonomy fills it;
 * disciplines are the next-most-specific axis under category.
 *
 * `offers` is intentionally omitted until `VendorLink` carries `website` —
 * tracked in AECI-68.
 */
export function buildProductJsonLd(product: ProductDetail): SoftwareApplicationLd {
  const ld: SoftwareApplicationLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: product.name,
  };
  if (product.description) ld.description = product.description;
  if (product.website) ld.url = product.website;
  const cat = product.categories[0]?.name;
  if (cat) ld.applicationCategory = cat;
  const sub = product.disciplines[0]?.name;
  if (sub) ld.applicationSubCategory = sub;
  return ld;
}

/**
 * Build a `schema.org/Organization` JSON-LD payload for a vendor detail page
 * (§9.2). `headquarters` is free text on `VendorDetail`, so `address` is set
 * as a plain string rather than a synthesized `PostalAddress`.
 */
export function buildVendorJsonLd(vendor: VendorDetail): OrganizationLd {
  const ld: OrganizationLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: vendor.company_name,
  };
  if (vendor.website) ld.url = vendor.website;
  if (vendor.logo_url) ld.logo = vendor.logo_url;
  if (vendor.founded_year !== null && vendor.founded_year !== undefined) {
    ld.foundingDate = String(vendor.founded_year);
  }
  if (vendor.headquarters) ld.address = vendor.headquarters;
  return ld;
}

/**
 * Angular-free helpers backing `MetaService`. Kept in a separate module so the
 * Vitest spec can import them under plain Node without dragging Angular's
 * partial-compiled platform packages into the test process.
 *
 * Spec anchor: docs/STAGE_1_PHASE_2_SPEC.md §9 (§9.1 metadata, §9.2 JSON-LD).
 */

import type { ProductDetail, VendorDetail } from '@aeci/shared';

export const META_DESCRIPTION_MAX = 155;

/**
 * The publisher / brand name used in the home structured data (§20.3 `WebSite`
 * and the publisher `Organization`). The `· AEC Integrations` title chrome is
 * `$localize`-wrapped in `MetaService`, but this is the language-neutral brand
 * proper-noun that schema.org consumes, so it stays a plain constant.
 */
export const SITE_NAME = 'AEC Integrations';

/**
 * Default OG image when an entity has no logo of its own. We reuse the brand
 * monogram so we don't have to ship a new asset for AECI-51. Some scrapers
 * (older LinkedIn, some Slack flavors) render SVG OG images inconsistently;
 * Phase 7 polish should replace this with a rendered 1200×630 PNG.
 *
 * This stays the monogram on purpose: it is both the entity-page fallback AND
 * the home `Organization` JSON-LD `logo` (a logo wants the square mark, not a
 * 1200×630 card). The home page's share preview uses `HOME_OG_IMAGE` instead.
 * Per-entity OG cards are a separate effort (AECI-276 out-of-scope).
 */
export const DEFAULT_OG_IMAGE = '/branding/monogram-light.svg';

/**
 * The dedicated home share card (AECI-276): a real, rendered 1200×630 PNG, not
 * the fallback monogram, so a shared `/` link previews as a marketing card
 * rather than a bare logo. Source + generator: `apps/web/scripts/home-og-*`
 * (regenerate with `pnpm --filter @aeci/web og:home`). `setHomeMeta` emits this
 * as an ABSOLUTE URL (highest-value share surface); entity pages keep their
 * relative `og:image`.
 */
export const HOME_OG_IMAGE = '/branding/home-og.png';

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
 * `schema.org/SearchAction` nested in the home `WebSite` payload — the signal
 * Google reads to offer a sitelinks search box (§20.3). `target` is a URI
 * template; `query-input` names the substitution variable.
 */
export interface SearchActionLd {
  '@type': 'SearchAction';
  target: string;
  'query-input': string;
}

/**
 * `schema.org/WebSite` JSON-LD for the home page (§20.3). Carries the site name,
 * the homepage URL, and a `SearchAction` `potentialAction` so search engines can
 * render the sitelinks search box wired to `/search`.
 */
export interface WebSiteLd {
  '@context': 'https://schema.org';
  '@type': 'WebSite';
  name: string;
  url: string;
  potentialAction: SearchActionLd;
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

/**
 * The scheme+host origin of an absolute URL (no trailing slash, no path), e.g.
 * `https://aecintegrations.com/` → `https://aecintegrations.com`. Used to build
 * the home `WebSite` / `Organization` JSON-LD against the serving origin
 * (canonical URLs are self-referential, ADR 0011). Returns the input unchanged
 * if it doesn't parse.
 */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Compose a page title: `{name}{suffix}`. Suffix carries any locale chrome. */
export function buildEntityTitle(name: string, suffix: string): string {
  return `${name}${suffix}`;
}

/**
 * The entity kinds the meta layer knows how to title and classify. Canonical
 * definition lives here (not in `meta.service.ts`, which re-exports it) so the
 * kind→og:type decision is pure-testable in plain Node without booting Angular.
 * `index` joins browse kinds in the `website` bucket — an index page is not an
 * article — while detail kinds map to `article`. See Phase 2 Spec §9.1.
 */
export type EntityKind =
  | 'product'
  | 'vendor'
  | 'integration'
  | 'category'
  | 'audience'
  | 'phase'
  | 'index';

const BROWSE_META_KINDS: ReadonlySet<EntityKind> = new Set(['category', 'audience', 'phase']);

const WEBSITE_META_KINDS: ReadonlySet<EntityKind> = new Set([...BROWSE_META_KINDS, 'index']);

export function isBrowseKind(kind: EntityKind): boolean {
  return BROWSE_META_KINDS.has(kind);
}

export function ogTypeForKind(kind: EntityKind): 'article' | 'website' {
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
 * `applicationSubCategory` maps to the first audience because §9.2 names
 * the schema.org field without specifying which AECi taxonomy fills it;
 * audiences are the next-most-specific axis under category.
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
  const sub = product.audiences[0]?.name;
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

/**
 * Build the home `schema.org/WebSite` JSON-LD with the `SearchAction` that lets
 * Google offer a sitelinks search box (§20.3 — the home JSON-LD item NOT covered
 * by AECI-51's product/vendor structured data). `origin` is the serving origin
 * with no trailing slash (e.g. `https://aecintegrations.com`); the homepage
 * `url` and the `/search?q=` target are composed from it so the structured data
 * follows the serving host (self-referential canonicals, ADR 0011).
 */
export function buildWebSiteJsonLd(input: { origin: string; name: string }): WebSiteLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: input.name,
    url: `${input.origin}/`,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${input.origin}/search?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };
}

/**
 * Build the publisher `schema.org/Organization` JSON-LD for the home page
 * (§20.3 / §20.4) — AECi as the site's publisher. Distinct from
 * `buildVendorJsonLd`, which describes a vendor *entity* on its detail page;
 * this is the directory's own brand. `origin` is the serving origin (no trailing
 * slash); `logo` should be an absolute URL when supplied.
 */
export function buildSiteOrganizationLd(input: {
  origin: string;
  name: string;
  logo?: string;
}): OrganizationLd {
  const ld: OrganizationLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: input.name,
    url: `${input.origin}/`,
  };
  if (input.logo) ld.logo = input.logo;
  return ld;
}

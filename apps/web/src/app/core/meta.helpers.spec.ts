import { describe, expect, it } from 'vitest';

import type { ProductDetail, ProductListItem, VendorDetail } from '@aeci/shared';

import {
  DEFAULT_OG_IMAGE,
  HOME_OG_IMAGE,
  META_DESCRIPTION_MAX,
  SITE_NAME,
  buildEntityTitle,
  buildOgTags,
  buildPairBreadcrumbLd,
  buildPairJsonLd,
  buildProductJsonLd,
  buildSiteOrganizationLd,
  buildVendorJsonLd,
  buildWebSiteJsonLd,
  isBrowseKind,
  ogTypeForKind,
  originOf,
  productLdId,
  stripQueryParams,
  truncateAtWordBoundary,
} from './meta.helpers';

/** A pair endpoint (`ProductListItem`, not `ProductDetail`). Defaults to Revit. */
function makePairProduct(overrides: Partial<ProductListItem> = {}): ProductListItem {
  const base: ProductListItem = {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'revit',
    name: 'Revit',
    logo_url: 'https://cdn.example/revit.png',
    product_role: 'application',
    vendor: {
      id: '00000000-0000-0000-0000-0000000000a0',
      slug: 'autodesk',
      name: 'Autodesk',
      logo_url: 'https://cdn.example/autodesk.png',
      verified: false,
    },
    primary_category: { id: 'c1', name: 'BIM Authoring', slug: 'bim-authoring' },
    integration_count: 12,
    review_count: 4,
    rating_overall_avg: 4.2,
    rating_onboarding_avg: 3.9,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}

describe('truncateAtWordBoundary', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '   \n\t  '],
  ])('returns empty string for %s', (_label, input) => {
    expect(truncateAtWordBoundary(input)).toBe('');
  });

  it('passes short strings through unchanged', () => {
    expect(truncateAtWordBoundary('A short description.')).toBe('A short description.');
  });

  it('collapses internal whitespace', () => {
    expect(truncateAtWordBoundary('a  b\n\tc')).toBe('a b c');
  });

  it('passes strings of exactly max length through', () => {
    const exact = 'a'.repeat(META_DESCRIPTION_MAX);
    expect(truncateAtWordBoundary(exact)).toBe(exact);
    expect(truncateAtWordBoundary(exact).length).toBe(META_DESCRIPTION_MAX);
  });

  it('truncates at the last word boundary and appends an ellipsis', () => {
    // 5-char words separated by spaces: "aaaaa bbbbb ccccc ddddd …"
    // Build a string > 155 chars where word boundaries are predictable.
    const word = 'word ';
    const long = word.repeat(40).trim(); // 199 chars, plenty over 155
    const out = truncateAtWordBoundary(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
    // No mid-word cut: the slice before the ellipsis must be whole "word" tokens.
    const body = out.slice(0, -1).trim();
    expect(body.split(' ').every((tok) => tok === 'word')).toBe(true);
  });

  it('hard-cuts when a single token exceeds max', () => {
    const giant = 'x'.repeat(META_DESCRIPTION_MAX + 50);
    const out = truncateAtWordBoundary(giant);
    expect(out.length).toBe(META_DESCRIPTION_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, -1)).toBe('x'.repeat(META_DESCRIPTION_MAX - 1));
  });

  it('respects a custom max', () => {
    expect(truncateAtWordBoundary('one two three four five', 10)).toBe('one two…');
  });
});

describe('stripQueryParams', () => {
  it.each([
    [
      'https://aecintegrations.com/products/foo?utm_source=x',
      'https://aecintegrations.com/products/foo',
    ],
    [
      'https://aecintegrations.com/products/foo?utm_source=x&utm_medium=y#section',
      'https://aecintegrations.com/products/foo',
    ],
    ['https://aecintegrations.com/products/foo', 'https://aecintegrations.com/products/foo'],
    ['https://aecintegrations.com/', 'https://aecintegrations.com/'],
    // AECI-143 — facet filters are query params, so a filtered listing/browse URL
    // canonicalizes to its unfiltered base (§20.6).
    [
      'https://aecintegrations.com/products?category_id=abc&page=2',
      'https://aecintegrations.com/products',
    ],
    [
      'https://aecintegrations.com/categories/structural?audience_id=a',
      'https://aecintegrations.com/categories/structural',
    ],
  ])('strips %s → %s', (input, expected) => {
    expect(stripQueryParams(input)).toBe(expected);
  });

  it('returns input unchanged on parse failure', () => {
    expect(stripQueryParams('not a url')).toBe('not a url');
  });
});

describe('originOf', () => {
  it.each([
    ['https://aecintegrations.com/', 'https://aecintegrations.com'],
    ['https://aecintegrations.com', 'https://aecintegrations.com'],
    [
      'https://staging.aecintegrations.com/products/revit?q=1',
      'https://staging.aecintegrations.com',
    ],
    ['http://localhost:8788/', 'http://localhost:8788'],
  ])('extracts the origin of %s', (input, expected) => {
    expect(originOf(input)).toBe(expected);
  });

  it('returns input unchanged on parse failure', () => {
    expect(originOf('not a url')).toBe('not a url');
  });
});

describe('buildEntityTitle', () => {
  it('composes detail titles', () => {
    expect(buildEntityTitle('Revit', ' · AEC Integrations')).toBe('Revit · AEC Integrations');
  });

  it('composes browse titles', () => {
    expect(buildEntityTitle('Scheduling', ' tools · AEC Integrations')).toBe(
      'Scheduling tools · AEC Integrations',
    );
  });

  it('does not strip or normalise the name', () => {
    expect(buildEntityTitle('  Padded  ', '')).toBe('  Padded  ');
  });
});

describe('buildOgTags', () => {
  const input = {
    title: 'Revit · AEC Integrations',
    description: 'A BIM authoring tool used across the AEC industry.',
    url: 'https://aecintegrations.com/products/revit',
    type: 'article',
    image: 'https://aecintegrations.com/branding/monogram-light.svg',
  };

  it('emits every required OG property', () => {
    const tags = buildOgTags(input);
    const properties = tags.flatMap((t) => ('property' in t ? [t.property] : []));
    expect(properties).toEqual(
      expect.arrayContaining(['og:title', 'og:description', 'og:url', 'og:type', 'og:image']),
    );
  });

  it('emits the full Twitter card siblings', () => {
    const tags = buildOgTags(input);
    const names = tags.flatMap((t) => ('name' in t ? [t.name] : []));
    expect(names).toEqual(
      expect.arrayContaining([
        'twitter:card',
        'twitter:title',
        'twitter:description',
        'twitter:image',
      ]),
    );
    const card = tags.find((t) => 'name' in t && t.name === 'twitter:card');
    expect(card).toEqual({ name: 'twitter:card', content: 'summary_large_image' });
  });

  it('binds content to the input', () => {
    const tags = buildOgTags(input);
    const get = (key: 'property' | 'name', val: string): string | undefined =>
      tags.find((t) => key in t && (t as Record<string, string>)[key] === val)?.content;
    expect(get('property', 'og:title')).toBe(input.title);
    expect(get('property', 'og:description')).toBe(input.description);
    expect(get('property', 'og:url')).toBe(input.url);
    expect(get('property', 'og:image')).toBe(input.image);
    expect(get('name', 'twitter:image')).toBe(input.image);
  });
});

describe('DEFAULT_OG_IMAGE', () => {
  it('points at the brand monogram fallback', () => {
    expect(DEFAULT_OG_IMAGE).toBe('/branding/monogram-light.svg');
  });
});

describe('HOME_OG_IMAGE', () => {
  it('points at the dedicated rendered home share card (not the monogram)', () => {
    expect(HOME_OG_IMAGE).toBe('/branding/home-og.png');
    expect(HOME_OG_IMAGE).not.toBe(DEFAULT_OG_IMAGE);
  });
});

describe('buildProductJsonLd', () => {
  function makeProduct(overrides: Partial<ProductDetail> = {}): ProductDetail {
    const base: ProductDetail = {
      id: '00000000-0000-0000-0000-000000000001',
      slug: 'revit',
      name: 'Revit',
      logo_url: 'https://cdn.example/revit.png',
      product_role: 'application',
      vendor: {
        id: '00000000-0000-0000-0000-0000000000a0',
        slug: 'autodesk',
        name: 'Autodesk',
        logo_url: 'https://cdn.example/autodesk.png',
        verified: false,
      },
      integration_count: 12,
      review_count: 4,
      rating_overall_avg: 4.2,
      rating_onboarding_avg: 3.9,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-06-01T00:00:00.000Z',
      description: 'BIM authoring tool for architects and engineers.',
      website: 'https://www.autodesk.com/products/revit',
      tool_integrations_url: null,
      api_docs_url: null,
      has_api_docs: false,
      categories: [
        { id: 'c1', name: 'BIM Authoring', slug: 'bim-authoring' },
        { id: 'c2', name: 'Design', slug: 'design' },
      ],
      audiences: [{ id: 'd1', name: 'Architecture', slug: 'architecture' }],
      phases: [],
      trades: [],
      usefulness: null,
      integrations_as_source: [],
      integrations_as_target: [],
      integrations_as_connector: [],
      related_products: [],
      reviews: [],
    };
    return { ...base, ...overrides };
  }

  const PRODUCT_CANONICAL = 'https://www.aecintegrations.com/products/revit';

  it('produces the canonical SoftwareApplication shape', () => {
    const ld = buildProductJsonLd(makeProduct(), PRODUCT_CANONICAL);
    expect(ld).toEqual({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      '@id': 'https://www.aecintegrations.com/products/revit#product',
      name: 'Revit',
      description: 'BIM authoring tool for architects and engineers.',
      url: 'https://www.autodesk.com/products/revit',
      applicationCategory: 'BIM Authoring',
      applicationSubCategory: 'Architecture',
    });
  });

  it('omits offers entirely (deferred to AECI-68)', () => {
    const ld = buildProductJsonLd(makeProduct(), PRODUCT_CANONICAL);
    expect(ld).not.toHaveProperty('offers');
  });

  it('omits null / empty source fields, but never @id', () => {
    const ld = buildProductJsonLd(
      makeProduct({
        description: null,
        website: null,
        categories: [],
        audiences: [],
      }),
      PRODUCT_CANONICAL,
    );
    expect(ld).toEqual({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      '@id': 'https://www.aecintegrations.com/products/revit#product',
      name: 'Revit',
    });
    expect(ld).not.toHaveProperty('description');
    expect(ld).not.toHaveProperty('url');
    expect(ld).not.toHaveProperty('applicationCategory');
    expect(ld).not.toHaveProperty('applicationSubCategory');
  });

  // The whole point of the AECI-518 `@id`: the node this page publishes and the
  // node the pair page references must be ONE entity. If these two ever drift,
  // the `about[]` reference dangles and the entity graph silently comes apart.
  it('publishes the same @id the pair page references in about[]', () => {
    const ld = buildProductJsonLd(makeProduct(), PRODUCT_CANONICAL);
    const pair = buildPairJsonLd({
      canonical: 'https://www.aecintegrations.com/products/procore/integrations/revit',
      origin: 'https://www.aecintegrations.com',
      name: 'Procore and Revit integrations',
      description: 'How Procore and Revit exchange data.',
      context: makePairProduct({ slug: 'procore', name: 'Procore' }),
      other: makePairProduct(),
    });
    expect(pair.about[1]['@id']).toBe(ld['@id']);
  });

  // The canonical is self-referential against the SERVING origin (ADR 0011), so
  // a preview / staging host must produce host-matched ids rather than baking in
  // the apex.
  it('derives @id from the serving origin, not a hardcoded host', () => {
    const ld = buildProductJsonLd(
      makeProduct(),
      'https://staging.aecintegrations.com/products/revit',
    );
    expect(ld['@id']).toBe('https://staging.aecintegrations.com/products/revit#product');
  });
});

describe('buildVendorJsonLd', () => {
  function makeVendor(overrides: Partial<VendorDetail> = {}): VendorDetail {
    const base: VendorDetail = {
      id: '00000000-0000-0000-0000-0000000000a0',
      slug: 'autodesk',
      company_name: 'Autodesk',
      logo_url: 'https://cdn.example/autodesk.png',
      verified: true,
      product_count: 8,
      integration_count: 30,
      review_count: 10,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-06-01T00:00:00.000Z',
      description: 'Software for designers, engineers, and builders.',
      website: 'https://www.autodesk.com',
      headquarters: 'San Francisco, CA, USA',
      founded_year: 1982,
      products: [],
    };
    return { ...base, ...overrides };
  }

  it('produces the canonical Organization shape', () => {
    const ld = buildVendorJsonLd(makeVendor());
    expect(ld).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Autodesk',
      url: 'https://www.autodesk.com',
      logo: 'https://cdn.example/autodesk.png',
      foundingDate: '1982',
      address: 'San Francisco, CA, USA',
    });
  });

  it('stringifies founded_year for schema.org foundingDate (YYYY)', () => {
    const ld = buildVendorJsonLd(makeVendor({ founded_year: 1999 }));
    expect(ld.foundingDate).toBe('1999');
    expect(typeof ld.foundingDate).toBe('string');
  });

  it('omits null source fields', () => {
    const ld = buildVendorJsonLd(
      makeVendor({
        website: null,
        logo_url: null,
        headquarters: null,
        founded_year: null,
      }),
    );
    expect(ld).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Autodesk',
    });
    expect(ld).not.toHaveProperty('url');
    expect(ld).not.toHaveProperty('logo');
    expect(ld).not.toHaveProperty('address');
    expect(ld).not.toHaveProperty('foundingDate');
  });
});

describe('buildWebSiteJsonLd', () => {
  it('produces the canonical WebSite shape with a SearchAction', () => {
    const ld = buildWebSiteJsonLd({ origin: 'https://aecintegrations.com', name: SITE_NAME });
    expect(ld).toEqual({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'AEC Integrations',
      url: 'https://aecintegrations.com/',
      potentialAction: {
        '@type': 'SearchAction',
        target: 'https://aecintegrations.com/search?q={search_term_string}',
        'query-input': 'required name=search_term_string',
      },
    });
  });

  it('composes the homepage url and search target from the serving origin', () => {
    const ld = buildWebSiteJsonLd({
      origin: 'https://staging.aecintegrations.com',
      name: SITE_NAME,
    });
    expect(ld.url).toBe('https://staging.aecintegrations.com/');
    expect(ld.potentialAction.target).toBe(
      'https://staging.aecintegrations.com/search?q={search_term_string}',
    );
  });
});

describe('buildSiteOrganizationLd', () => {
  it('produces the publisher Organization shape with an absolute logo', () => {
    const ld = buildSiteOrganizationLd({
      origin: 'https://aecintegrations.com',
      name: SITE_NAME,
      logo: 'https://aecintegrations.com/branding/monogram-light.svg',
    });
    expect(ld).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'AEC Integrations',
      url: 'https://aecintegrations.com/',
      logo: 'https://aecintegrations.com/branding/monogram-light.svg',
    });
  });

  it('omits logo when not supplied', () => {
    const ld = buildSiteOrganizationLd({ origin: 'https://aecintegrations.com', name: SITE_NAME });
    expect(ld).not.toHaveProperty('logo');
    expect(ld.url).toBe('https://aecintegrations.com/');
  });
});

describe('isBrowseKind', () => {
  it('returns true for category / audience / phase / trade', () => {
    expect(isBrowseKind('category')).toBe(true);
    expect(isBrowseKind('audience')).toBe(true);
    expect(isBrowseKind('phase')).toBe(true);
    expect(isBrowseKind('trade')).toBe(true);
  });

  it('returns false for index pages (no "tools" infix in title)', () => {
    expect(isBrowseKind('index')).toBe(false);
  });

  it('returns false for detail kinds', () => {
    expect(isBrowseKind('product')).toBe(false);
    expect(isBrowseKind('vendor')).toBe(false);
    expect(isBrowseKind('integration')).toBe(false);
  });
});

describe('ogTypeForKind', () => {
  it('returns "article" for detail kinds', () => {
    expect(ogTypeForKind('product')).toBe('article');
    expect(ogTypeForKind('vendor')).toBe('article');
    expect(ogTypeForKind('integration')).toBe('article');
  });

  it('returns "website" for browse kinds', () => {
    expect(ogTypeForKind('category')).toBe('website');
    expect(ogTypeForKind('audience')).toBe('website');
    expect(ogTypeForKind('phase')).toBe('website');
    expect(ogTypeForKind('trade')).toBe('website');
  });

  it('returns "website" for index kind — index is not an article', () => {
    expect(ogTypeForKind('index')).toBe('website');
  });
});

// ── AECI-518 — product-PAIR structured data (§9.2's deferral, resolved) ──────
// The decision record is `STAGE_2_SPEC.md` §8.7: `WebPage` + `about`, plus a
// sibling `BreadcrumbList`. These are the pure builders; the emission gate
// (indexable pairs only) is asserted in `products-pair.resolver.component.spec.ts`.

const PAIR_ORIGIN = 'https://www.aecintegrations.com';
const PAIR_CANONICAL = `${PAIR_ORIGIN}/products/procore/integrations/revit`;

describe('buildPairJsonLd', () => {
  function build(overrides: Partial<Parameters<typeof buildPairJsonLd>[0]> = {}) {
    return buildPairJsonLd({
      canonical: PAIR_CANONICAL,
      origin: PAIR_ORIGIN,
      name: 'Procore and Revit integrations',
      description: 'How Procore and Revit exchange data across their integrations.',
      context: makePairProduct({
        id: '00000000-0000-0000-0000-000000000002',
        slug: 'procore',
        name: 'Procore',
        logo_url: 'https://cdn.example/procore.png',
        primary_category: { id: 'c9', name: 'Project Management', slug: 'project-management' },
        vendor: {
          id: '00000000-0000-0000-0000-0000000000b0',
          slug: 'procore-technologies',
          name: 'Procore Technologies',
          logo_url: null,
          verified: true,
        },
      }),
      other: makePairProduct(),
      ...overrides,
    });
  }

  it('produces a WebPage whose about names both endpoint products', () => {
    expect(build()).toEqual({
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      '@id': `${PAIR_CANONICAL}#webpage`,
      url: PAIR_CANONICAL,
      name: 'Procore and Revit integrations',
      description: 'How Procore and Revit exchange data across their integrations.',
      breadcrumb: { '@id': `${PAIR_CANONICAL}#breadcrumb` },
      about: [
        {
          '@type': 'SoftwareApplication',
          '@id': `${PAIR_ORIGIN}/products/procore#product`,
          name: 'Procore',
          url: `${PAIR_ORIGIN}/products/procore`,
          applicationCategory: 'Project Management',
          image: 'https://cdn.example/procore.png',
          publisher: { '@type': 'Organization', name: 'Procore Technologies' },
        },
        {
          '@type': 'SoftwareApplication',
          '@id': `${PAIR_ORIGIN}/products/revit#product`,
          name: 'Revit',
          url: `${PAIR_ORIGIN}/products/revit`,
          applicationCategory: 'BIM Authoring',
          image: 'https://cdn.example/revit.png',
          publisher: { '@type': 'Organization', name: 'Autodesk' },
        },
      ],
    });
  });

  it('omits every optional about field when the source is null', () => {
    const bare = makePairProduct({ logo_url: null, vendor: null, primary_category: null });
    const ld = build({ context: bare, other: bare });
    expect(ld.about[0]).toEqual({
      '@type': 'SoftwareApplication',
      '@id': `${PAIR_ORIGIN}/products/revit#product`,
      name: 'Revit',
      url: `${PAIR_ORIGIN}/products/revit`,
    });
  });

  // Nested nodes inherit the enclosing document's @context; repeating it is
  // legal but noisy, and Google's own examples omit it.
  it('carries no @context on the nested about nodes', () => {
    for (const node of build().about) expect(node).not.toHaveProperty('@context');
  });

  // `about` is ordered by the URL, not alphabetically: the page is framed from
  // its context product, and the non-default orientation is a real, rendered URL.
  it('orders about by URL orientation, context first', () => {
    const ld = build();
    expect(ld.about.map((n) => n.name)).toEqual(['Procore', 'Revit']);
  });

  it('composes about @ids through productLdId so the graph cannot drift', () => {
    const ld = build();
    expect(ld.about[0]['@id']).toBe(productLdId(PAIR_ORIGIN, 'procore'));
    expect(ld.about[1]['@id']).toBe(productLdId(PAIR_ORIGIN, 'revit'));
  });
});

describe('buildPairBreadcrumbLd', () => {
  function build() {
    return buildPairBreadcrumbLd({
      canonical: PAIR_CANONICAL,
      origin: PAIR_ORIGIN,
      homeLabel: 'Home',
      context: makePairProduct({ slug: 'procore', name: 'Procore' }),
      other: makePairProduct(),
    });
  }

  // Mirrors the trail `products-pair.ts` renders: Home › {context} › {other}.
  // Google requires breadcrumb markup to match visible content, so the shape is
  // dictated by the template — including the last crumb being the OTHER
  // product's name rather than the pair title.
  it('mirrors the visible trail', () => {
    expect(build()).toEqual({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      '@id': `${PAIR_CANONICAL}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${PAIR_ORIGIN}/` },
        {
          '@type': 'ListItem',
          position: 2,
          name: 'Procore',
          item: `${PAIR_ORIGIN}/products/procore`,
        },
        { '@type': 'ListItem', position: 3, name: 'Revit' },
      ],
    });
  });

  // Omitting `item` on the final crumb is schema.org convention for "this page",
  // and it is what keeps the payload honest on the NON-default orientation,
  // whose canonical points at the other URL.
  it('omits item on the final crumb', () => {
    const last = build().itemListElement.at(-1);
    expect(last).not.toHaveProperty('item');
  });

  it('numbers positions from 1, contiguously', () => {
    expect(build().itemListElement.map((i) => i.position)).toEqual([1, 2, 3]);
  });

  it('resolves back to the WebPage that references it', () => {
    const crumbs = build();
    const page = buildPairJsonLd({
      canonical: PAIR_CANONICAL,
      origin: PAIR_ORIGIN,
      name: 'Procore and Revit integrations',
      description: 'How Procore and Revit exchange data.',
      context: makePairProduct({ slug: 'procore', name: 'Procore' }),
      other: makePairProduct(),
    });
    expect(page.breadcrumb['@id']).toBe(crumbs['@id']);
  });
});

/**
 * Focused tests for `MetaService.setNotFoundMeta` (AECI-57). The pre-existing
 * `setEntityMeta` / `setProductJsonLd` paths are exercised by the preview
 * route + the resolver spec; this file only pins the 404 contract added in
 * AECI-57: noindex meta, canonical link, JSON-LD purge — plus, since AECI-518,
 * the `clearJsonLd` invariant that made that purge universal and the pair
 * page's two new blocks.
 */
import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ProductListItem } from '@aeci/shared';

import { MetaService } from './meta.service';

function setup(): { service: MetaService; doc: Document } {
  TestBed.configureTestingModule({
    providers: [Meta, Title, MetaService],
  });
  return {
    service: TestBed.inject(MetaService),
    doc: TestBed.inject(DOCUMENT),
  };
}

describe('MetaService.setNotFoundMeta', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    // Clean any meta/links lingering from previous suites.
    const head = document.head;
    for (const el of head.querySelectorAll(
      'meta[name="description"], meta[name="robots"], link[rel="canonical"], script[data-aeci-jsonld]',
    )) {
      el.remove();
    }
    document.title = '';
  });

  it('sets title, generic description, noindex robots, and canonical link', () => {
    const { service, doc } = setup();

    service.setNotFoundMeta({
      kind: 'product',
      slug: 'missing',
      canonical: 'https://aecintegrations.com/products/missing',
    });

    expect(doc.title).toBe('Not found · AEC Integrations');

    const desc = doc.head.querySelector('meta[name="description"]') as HTMLMetaElement | null;
    expect(desc?.getAttribute('content')).toBe('The page you were looking for could not be found.');

    const robots = doc.head.querySelector('meta[name="robots"]') as HTMLMetaElement | null;
    expect(robots?.getAttribute('content')).toBe('noindex');

    const canonical = doc.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    expect(canonical?.getAttribute('href')).toBe('https://aecintegrations.com/products/missing');
  });

  it('strips query params and fragments from the canonical URL', () => {
    const { service, doc } = setup();

    service.setNotFoundMeta({
      kind: 'product',
      slug: 'missing',
      canonical: 'https://aecintegrations.com/products/missing?utm_source=email#section',
    });

    const canonical = doc.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    expect(canonical?.getAttribute('href')).toBe('https://aecintegrations.com/products/missing');
  });

  it('removes any stale JSON-LD scripts left from a prior render', () => {
    const { service, doc } = setup();
    // Seed a stale JSON-LD script (as if a prior render had set product data).
    const stale = doc.createElement('script');
    stale.setAttribute('type', 'application/ld+json');
    stale.setAttribute('data-aeci-jsonld', 'product');
    stale.textContent = '{"@type":"SoftwareApplication"}';
    doc.head.appendChild(stale);

    service.setNotFoundMeta({
      kind: 'product',
      slug: 'missing',
      canonical: 'https://aecintegrations.com/products/missing',
    });

    expect(
      doc.head.querySelectorAll('script[type="application/ld+json"][data-aeci-jsonld]'),
    ).toHaveLength(0);
  });
});

describe('MetaService.setHomeMeta', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    const head = document.head;
    for (const el of head.querySelectorAll(
      'meta[name="description"], meta[name="robots"], meta[property^="og:"], meta[name^="twitter:"], link[rel="canonical"], script[data-aeci-jsonld]',
    )) {
      el.remove();
    }
    document.title = '';
  });

  it('sets the static home title, description, canonical, and website OG type', () => {
    const { service, doc } = setup();

    service.setHomeMeta({ canonical: 'https://aecintegrations.com/' });

    expect(doc.title).toContain('AEC Integrations');

    const desc = doc.head.querySelector('meta[name="description"]') as HTMLMetaElement | null;
    expect(desc?.getAttribute('content')).toContain('independent');

    // Home is indexable — no robots tag.
    expect(doc.head.querySelector('meta[name="robots"]')).toBeNull();

    const canonical = doc.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    expect(canonical?.getAttribute('href')).toBe('https://aecintegrations.com/');

    const ogType = doc.head.querySelector('meta[property="og:type"]') as HTMLMetaElement | null;
    expect(ogType?.getAttribute('content')).toBe('website');
    const ogUrl = doc.head.querySelector('meta[property="og:url"]') as HTMLMetaElement | null;
    expect(ogUrl?.getAttribute('content')).toBe('https://aecintegrations.com/');

    // og:image / twitter:image point at the dedicated, ABSOLUTE home share card
    // (AECI-276) — not the relative monogram fallback.
    const ogImage = doc.head.querySelector('meta[property="og:image"]') as HTMLMetaElement | null;
    expect(ogImage?.getAttribute('content')).toBe(
      'https://aecintegrations.com/branding/home-og.png',
    );
    const twitterImage = doc.head.querySelector(
      'meta[name="twitter:image"]',
    ) as HTMLMetaElement | null;
    expect(twitterImage?.getAttribute('content')).toBe(
      'https://aecintegrations.com/branding/home-og.png',
    );

    // Both image-alt tags are present and non-empty (accessibility for the share
    // preview; the card is the highest-value marketing surface).
    const ogImageAlt = doc.head.querySelector(
      'meta[property="og:image:alt"]',
    ) as HTMLMetaElement | null;
    expect(ogImageAlt?.getAttribute('content')).toBeTruthy();
    const twitterImageAlt = doc.head.querySelector(
      'meta[name="twitter:image:alt"]',
    ) as HTMLMetaElement | null;
    expect(twitterImageAlt?.getAttribute('content')).toBeTruthy();
  });

  it('strips query params from the canonical and derives the origin for JSON-LD', () => {
    const { service, doc } = setup();

    service.setHomeMeta({ canonical: 'https://aecintegrations.com/?utm_source=x#frag' });

    const canonical = doc.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    expect(canonical?.getAttribute('href')).toBe('https://aecintegrations.com/');

    const website = doc.head.querySelector(
      'script[type="application/ld+json"][data-aeci-jsonld="website"]',
    ) as HTMLScriptElement | null;
    const parsed = JSON.parse(website?.textContent ?? '{}');
    expect(parsed['@type']).toBe('WebSite');
    expect(parsed.url).toBe('https://aecintegrations.com/');
    expect(parsed.potentialAction.target).toBe(
      'https://aecintegrations.com/search?q={search_term_string}',
    );
  });

  it('upserts both the WebSite and publisher Organization JSON-LD scripts', () => {
    const { service, doc } = setup();

    service.setHomeMeta({ canonical: 'https://aecintegrations.com/' });

    const scripts = doc.head.querySelectorAll(
      'script[type="application/ld+json"][data-aeci-jsonld]',
    );
    const kinds = Array.from(scripts).map((s) => s.getAttribute('data-aeci-jsonld'));
    expect(kinds).toEqual(expect.arrayContaining(['website', 'organization']));

    const org = doc.head.querySelector(
      'script[type="application/ld+json"][data-aeci-jsonld="organization"]',
    ) as HTMLScriptElement | null;
    const parsed = JSON.parse(org?.textContent ?? '{}');
    expect(parsed['@type']).toBe('Organization');
    expect(parsed.name).toBe('AEC Integrations');
    expect(parsed.logo).toBe('https://aecintegrations.com/branding/monogram-light.svg');
  });

  it('is idempotent — re-applying does not duplicate JSON-LD scripts', () => {
    const { service, doc } = setup();

    service.setHomeMeta({ canonical: 'https://aecintegrations.com/' });
    service.setHomeMeta({ canonical: 'https://aecintegrations.com/' });

    expect(
      doc.head.querySelectorAll('script[type="application/ld+json"][data-aeci-jsonld="website"]'),
    ).toHaveLength(1);
    expect(
      doc.head.querySelectorAll(
        'script[type="application/ld+json"][data-aeci-jsonld="organization"]',
      ),
    ).toHaveLength(1);
  });
});

describe('MetaService.setStaticPageMeta', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    const head = document.head;
    for (const el of head.querySelectorAll(
      'meta[name="description"], meta[name="robots"], meta[property^="og:"], meta[name^="twitter:"], link[rel="canonical"], script[data-aeci-jsonld]',
    )) {
      el.remove();
    }
    document.title = '';
  });

  it('adds a noindex robots tag when noindex is opted in (e.g. /unsubscribe)', () => {
    const { service, doc } = setup();

    service.setStaticPageMeta({
      title: 'Unsubscribe · AEC Integrations',
      description: 'Unsubscribe from the AEC Integrations mailing list.',
      canonical: 'https://aecintegrations.com/unsubscribe',
      noindex: true,
    });

    const robots = doc.head.querySelector('meta[name="robots"]') as HTMLMetaElement | null;
    expect(robots?.getAttribute('content')).toBe('noindex');
  });

  it('removes a stale robots tag when noindex is absent, so an in-app nav off a noindexed page onto /about does not leave the page noindexed', () => {
    const { service, doc } = setup();

    // Simulate landing on a noindexed static page first (e.g. /unsubscribe)…
    service.setStaticPageMeta({
      title: 'Unsubscribe · AEC Integrations',
      description: 'Unsubscribe from the AEC Integrations mailing list.',
      canonical: 'https://aecintegrations.com/unsubscribe',
      noindex: true,
    });
    expect(doc.head.querySelector('meta[name="robots"]')).not.toBeNull();

    // …then an in-app (SPA) navigation onto an indexable static page (/about),
    // which sets its meta without noindex. The stale robots tag must be cleared.
    service.setStaticPageMeta({
      title: 'About · AEC Integrations',
      description: 'About AEC Integrations.',
      canonical: 'https://aecintegrations.com/about',
    });

    expect(doc.head.querySelector('meta[name="robots"]')).toBeNull();
  });
});

// ── AECI-518 ────────────────────────────────────────────────────────────────
// `clearJsonLd` + the product-PAIR blocks. The clearing half is the fix for a
// real pre-existing defect: before this, only `setNotFoundMeta` / `setSearchMeta`
// purged, so an in-app navigation off a product or vendor detail page carried
// that page's structured data onto every page that sets meta but publishes no LD
// of its own.

const LD_SELECTOR = 'script[type="application/ld+json"][data-aeci-jsonld]';

function resetHead(): void {
  TestBed.resetTestingModule();
  for (const el of document.head.querySelectorAll(
    'meta[name="description"], meta[name="robots"], meta[property^="og:"], meta[name^="twitter:"], link[rel="canonical"], script[data-aeci-jsonld]',
  )) {
    el.remove();
  }
  document.title = '';
}

/** Seed structured data as if a prior route had published it. */
function seedStaleLd(doc: Document, kind: string): void {
  const stale = doc.createElement('script');
  stale.setAttribute('type', 'application/ld+json');
  stale.setAttribute('data-aeci-jsonld', kind);
  stale.textContent = '{"@type":"SoftwareApplication"}';
  doc.head.appendChild(stale);
}

function ldKinds(doc: Document): string[] {
  return Array.from(doc.head.querySelectorAll(LD_SELECTOR)).map(
    (s) => s.getAttribute('data-aeci-jsonld') ?? '',
  );
}

function pairProduct(overrides: Partial<ProductListItem> = {}): ProductListItem {
  const base: ProductListItem = {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'revit',
    name: 'Revit',
    logo_url: null,
    product_role: 'application',
    vendor: null,
    primary_category: null,
    integration_count: 3,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}

describe('MetaService JSON-LD lifecycle (AECI-518)', () => {
  beforeEach(resetHead);

  // The regression this fixes. `/products/:slug` publishes a SoftwareApplication;
  // the pair page and the taxonomy-browse pages publish their own or none. Before
  // AECI-518 `setEntityMeta` never purged, so the product block rode along.
  it.each([
    ['product', 'a detail page'],
    ['vendor', 'a vendor page'],
    ['website', 'the home page'],
  ])('setEntityMeta drops a stale "%s" block left by %s', (kind) => {
    const { service, doc } = setup();
    seedStaleLd(doc, kind);

    service.setEntityMeta({
      entity: 'category',
      name: 'Scheduling',
      description: 'Scheduling tools.',
      canonical: 'https://aecintegrations.com/categories/scheduling',
    });

    expect(ldKinds(doc)).toEqual([]);
  });

  it('setStaticPageMeta drops stale structured data (/about, /legal/*)', () => {
    const { service, doc } = setup();
    seedStaleLd(doc, 'product');

    service.setStaticPageMeta({
      title: 'About · AEC Integrations',
      description: 'About AEC Integrations.',
      canonical: 'https://aecintegrations.com/about',
    });

    expect(ldKinds(doc)).toEqual([]);
  });

  it('setHomeMeta drops stale detail LD before publishing its own two', () => {
    const { service, doc } = setup();
    seedStaleLd(doc, 'product');

    service.setHomeMeta({ canonical: 'https://aecintegrations.com/' });

    expect(ldKinds(doc).sort()).toEqual(['organization', 'website']);
  });

  it('setSearchMeta drops stale structured data', () => {
    const { service, doc } = setup();
    seedStaleLd(doc, 'pair');

    service.setSearchMeta({ canonical: 'https://aecintegrations.com/search' });

    expect(ldKinds(doc)).toEqual([]);
  });
});

describe('MetaService.setPairJsonLd', () => {
  const CANONICAL = 'https://aecintegrations.com/products/procore/integrations/revit';

  function applyPair(service: MetaService, canonical = CANONICAL): void {
    service.setPairJsonLd({
      canonical,
      name: 'Procore and Revit integrations',
      description: 'How Procore and Revit exchange data across their integrations.',
      homeLabel: 'Home',
      integrationsLabel: 'Integrations',
      context: pairProduct({ slug: 'procore', name: 'Procore' }),
      other: pairProduct(),
    });
  }

  beforeEach(resetHead);

  it('publishes exactly two blocks: pair + breadcrumb', () => {
    const { service, doc } = setup();
    applyPair(service);
    expect(ldKinds(doc).sort()).toEqual(['breadcrumb', 'pair']);
  });

  it('writes parseable JSON whose @ids cross-reference', () => {
    const { service, doc } = setup();
    applyPair(service);

    const page = JSON.parse(
      doc.head.querySelector(`${LD_SELECTOR}[data-aeci-jsonld="pair"]`)?.textContent ?? '{}',
    );
    const crumbs = JSON.parse(
      doc.head.querySelector(`${LD_SELECTOR}[data-aeci-jsonld="breadcrumb"]`)?.textContent ?? '{}',
    );

    expect(page['@type']).toBe('WebPage');
    expect(crumbs['@type']).toBe('BreadcrumbList');
    expect(page.breadcrumb['@id']).toBe(crumbs['@id']);
    expect(page.about.map((n: { name: string }) => n.name)).toEqual(['Procore', 'Revit']);
  });

  // The pair route carries `?context_version=` / `?other_version=` selectors
  // (AECI-303) and `?view=` (Stage 1.5 §8). None may reach the structured data,
  // for the same reason none reach the canonical.
  it('strips query params so a version selection never reaches the payload', () => {
    const { service, doc } = setup();
    applyPair(service, `${CANONICAL}?context_version=2024&view=basic#flows`);

    const page = JSON.parse(
      doc.head.querySelector(`${LD_SELECTOR}[data-aeci-jsonld="pair"]`)?.textContent ?? '{}',
    );
    expect(page.url).toBe(CANONICAL);
    expect(page['@id']).toBe(`${CANONICAL}#webpage`);
  });

  it('is idempotent — re-applying does not duplicate either block', () => {
    const { service, doc } = setup();
    applyPair(service);
    applyPair(service);
    expect(doc.head.querySelectorAll(LD_SELECTOR)).toHaveLength(2);
  });

  // `upsertJsonLdScript` escapes `</script>` so SSR serialization cannot break
  // out of the element. A product name is curator-supplied text, so this is a
  // real (if unlikely) injection path.
  it('escapes a </script> sequence in a product name', () => {
    const { service, doc } = setup();
    service.setPairJsonLd({
      canonical: CANONICAL,
      name: 'Pair',
      description: 'Pair.',
      homeLabel: 'Home',
      integrationsLabel: 'Integrations',
      context: pairProduct({ slug: 'evil', name: '</script><script>alert(1)</script>' }),
      other: pairProduct(),
    });

    const raw =
      doc.head.querySelector(`${LD_SELECTOR}[data-aeci-jsonld="pair"]`)?.textContent ?? '';
    expect(raw).not.toContain('</script>');
    expect(raw).toContain('<\\/script>');
    // Still valid JSON — `<\/` is a legal JSON escape.
    expect(JSON.parse(raw).about[0].name).toBe('</script><script>alert(1)</script>');
  });
});

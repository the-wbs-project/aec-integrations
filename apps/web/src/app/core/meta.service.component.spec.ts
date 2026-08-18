/**
 * Focused tests for `MetaService.setNotFoundMeta` (AECI-57). The pre-existing
 * `setEntityMeta` / `setProductJsonLd` paths are exercised by the preview
 * route + the resolver spec; this file only pins the 404 contract added in
 * AECI-57: noindex meta, canonical link, JSON-LD purge.
 */
import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { beforeEach, describe, expect, it } from 'vitest';

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

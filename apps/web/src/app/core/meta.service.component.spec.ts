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

    expect(doc.title).toBe('Not found — AEC Integrations');

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

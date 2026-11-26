import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { beforeEach, describe, expect, it } from 'vitest';

import { AboutPage } from './about';

function setup(): { host: HTMLElement; title: Title } {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(AboutPage);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, title: TestBed.inject(Title) };
}

describe('AboutPage', () => {
  // The Angular vitest builder shares one jsdom document across every
  // *.component.spec.ts and never resets <head> between files. Sibling specs
  // write `<meta name="robots" content="noindex">` (search-page's
  // setSearchMeta; the resolver/404 specs' setNotFoundMeta) and don't clean it
  // up, so strip any lingering robots tag first — same hygiene as
  // meta.service.component.spec.ts. Without this the indexable-page assertion
  // below fails purely on run order.
  beforeEach(() => {
    document.head.querySelector('meta[name="robots"]')?.remove();
  });

  it('leads with the trust-first positioning in the page H1', () => {
    const { host } = setup();
    expect(host.querySelector('h1')?.textContent).toContain("couldn't find anywhere else");
    expect(host.textContent).toContain('No pay-for-placement');
    // AECI-2233 (ruling 68): the full sentence is tied to order, never to position.
    expect(host.textContent).toContain('Payment never changes the order of results.');
    expect(host.textContent).not.toContain('their own position');
    // AECI-1316: vendors write some product copy, so the claim is gone.
    expect(host.textContent).not.toContain('vendor marketing');
  });

  it('renders the section headings in a valid order (one h1, then h2s)', () => {
    const { host } = setup();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    const h2s = Array.from(host.querySelectorAll('h2')).map((h) => h.textContent?.trim());
    // Includes the reused trust band's "Trust is the product" h2.
    expect(h2s).toEqual([
      'Why we exist',
      "How we're different",
      'Trust is the product',
      "Who it's for",
      'Start exploring',
    ]);
  });

  it('reuses the three trust commitments band', () => {
    const { host } = setup();
    expect(host.querySelector('aec-home-trust-pillars')).not.toBeNull();
    const commitments = Array.from(host.querySelectorAll('aec-home-trust-pillars h3')).map((h) =>
      h.textContent?.trim(),
    );
    expect(commitments).toEqual([
      'Never sell rankings',
      'Always be transparent',
      'Never review products ourselves',
    ]);
  });

  it('has one Bone band (the hero) and one Forest feature card (AECI-1800)', () => {
    const { host } = setup();
    const bands = host.querySelectorAll('aec-bone-band');
    expect(bands).toHaveLength(1);
    expect(bands[0].querySelector('h1')).not.toBeNull();
    // Forest may fill only the header, a detail hero, the footer and one feature
    // card. The commitments are that card (ruling 2026-11-17), never a band.
    const forest = host.querySelectorAll('[class*="bg-(--accent-primary)"]');
    expect(forest).toHaveLength(1);
    expect(forest[0].classList).toContain('aec-card');
    expect(forest[0].closest('aec-home-trust-pillars')).not.toBeNull();
    expect(host.querySelector('[class*="bg-(--accent-warm)"]:not(.aec-bone-band)')).toBeNull();
  });

  it('puts every band on the shared page wrap and sizes h2s on an inner span', () => {
    const { host } = setup();
    // The bone band wrap plus the three white bands.
    expect(host.querySelectorAll('.max-w-\\[1328px\\]')).toHaveLength(4);
    // The unlayered h2 rule beats a size utility on the element itself.
    for (const h2 of Array.from(host.querySelectorAll('h2'))) {
      expect(h2.className).not.toMatch(/text-t-|text-\d?xl/);
      expect(h2.querySelector('span.text-t-36')).not.toBeNull();
    }
  });

  it('routes onward to the directory and contact', () => {
    const { host } = setup();
    const hrefs = Array.from(host.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/products');
    expect(hrefs).toContain('/contact');
  });

  it('sets an indexable static-page title (no noindex robots tag)', () => {
    const { title } = setup();
    expect(title.getTitle()).toBe('About · AEC Integrations');
    // setStaticPageMeta must NOT emit a robots meta — About is canonical content.
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
  });
});

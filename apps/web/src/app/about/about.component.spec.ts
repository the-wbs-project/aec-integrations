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
    expect(host.textContent).toContain('no pay-for-placement');
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

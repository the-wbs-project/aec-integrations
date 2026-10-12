import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { VendorProgramPage } from './vendor-program';

/**
 * `/vendor-program` shell (AECI-1283, `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §2).
 * Pins what this issue owns: the one `h1` and its subhead, the
 * `#find-your-product` anchor the claim CTA scrolls to, and the indexable meta
 * with the dedicated share card. The sections themselves are AECI-1284 to 1287.
 */
function setup(): { host: HTMLElement; title: Title } {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(VendorProgramPage);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, title: TestBed.inject(Title) };
}

const content = (selector: string): string | null | undefined =>
  document.head.querySelector(selector)?.getAttribute('content');

describe('VendorProgramPage', () => {
  // The vitest builder shares one jsdom document across component specs and never
  // resets <head>. Siblings leave a noindex robots tag behind, so strip it first
  // (the `about.component.spec.ts` hygiene).
  beforeEach(() => {
    TestBed.resetTestingModule();
    document.head.querySelector('meta[name="robots"]')?.remove();
  });

  it('renders one h1 about the buyer reality, with a free-to-claim subhead', () => {
    const { host } = setup();
    const h1s = host.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent?.trim()).toBe('Contractors compare your integrations here');
    expect(host.textContent).toContain('free to claim');
  });

  it('states no statistics in the hero', () => {
    const { host } = setup();
    const hero = host.querySelector('section');
    expect(hero?.textContent).not.toMatch(/\d/);
  });

  it('ships the #find-your-product anchor the claim CTA scrolls to', () => {
    const { host } = setup();
    expect(host.querySelector('section#find-your-product')).not.toBeNull();
  });

  it('sets indexable meta with a canonical and the absolute share card', () => {
    const { title } = setup();
    expect(title.getTitle()).toBe('List your AEC software for free · AEC Integrations');
    expect(document.querySelector('meta[name="robots"]')).toBeNull();

    const canonical = document.head.querySelector('link[rel="canonical"]')?.getAttribute('href');
    expect(canonical).toMatch(/^https?:\/\/[^/]+\/vendor-program$/);

    const origin = new URL(canonical!).origin;
    expect(content('meta[property="og:image"]')).toBe(`${origin}/branding/vendor-program-og.png`);
    expect(content('meta[property="og:image:alt"]')).toBeTruthy();
    expect(content('meta[name="twitter:image:alt"]')).toBeTruthy();
  });

  it('puts the target searches in the description, not a price', () => {
    setup();
    const description = content('meta[name="description"]') ?? '';
    expect(description).toContain('AEC software directory');
    expect(description).toContain('construction software integrations');
    expect(description).not.toContain('$');
  });
});

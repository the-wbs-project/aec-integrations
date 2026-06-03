import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { PlaceholderPage } from './placeholder-page';

type Entity = 'product' | 'vendor';
type Kind = 'claim' | 'correction';

/**
 * Mirrors the four routes that load this component (app.routes.ts): the static
 * `data` carries entity/kind, the `:slug` param drives the back-link.
 */
function mockRoute(entity: Entity, kind: Kind, slug: string): ActivatedRoute {
  const paramMap = convertToParamMap({ slug });
  return {
    snapshot: { data: { entity, kind }, paramMap },
    paramMap: of(paramMap),
  } as unknown as ActivatedRoute;
}

function render(entity: Entity, kind: Kind, slug: string) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: mockRoute(entity, kind, slug) },
    ],
  });
  const fixture = TestBed.createComponent(PlaceholderPage);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const CASES = [
  {
    entity: 'product',
    kind: 'claim',
    slug: 'acme-build',
    eyebrow: 'Claim this listing',
    back: '← Back to product',
    href: '/products/acme-build',
    title: 'Claim this listing · AEC Integrations',
    mailto: 'mailto:hello@aecintegrations.com?subject=Claim%20listing',
  },
  {
    entity: 'vendor',
    kind: 'claim',
    slug: 'acme-co',
    eyebrow: 'Claim this listing',
    back: '← Back to vendor',
    href: '/vendors/acme-co',
    title: 'Claim this listing · AEC Integrations',
    mailto: 'mailto:hello@aecintegrations.com?subject=Claim%20vendor%20listing',
  },
  {
    entity: 'product',
    kind: 'correction',
    slug: 'acme-build',
    eyebrow: 'Suggest a correction',
    back: '← Back to product',
    href: '/products/acme-build',
    title: 'Suggest a correction · AEC Integrations',
    mailto: 'mailto:hello@aecintegrations.com?subject=Correction',
  },
  {
    entity: 'vendor',
    kind: 'correction',
    slug: 'acme-co',
    eyebrow: 'Suggest a correction',
    back: '← Back to vendor',
    href: '/vendors/acme-co',
    title: 'Suggest a correction · AEC Integrations',
    mailto: 'mailto:hello@aecintegrations.com?subject=Vendor%20correction',
  },
] as const;

describe('PlaceholderPage', () => {
  it.each(CASES)(
    'renders the $kind panel for a $entity, preserving copy + back-link',
    ({ entity, kind, slug, eyebrow, back, href, mailto }) => {
      const root = render(entity, kind, slug);

      // Eyebrow + heading — the text the e2e asserts by role/exact text.
      expect(root.querySelector('p')?.textContent?.trim()).toBe(eyebrow);
      expect(root.querySelector('h1')?.textContent?.trim()).toBe('Coming soon (Phase 6).');

      // Body mailto link carries the entity/kind-specific subject.
      expect(root.querySelector('a[href^="mailto:"]')?.getAttribute('href')).toBe(mailto);

      // Back-link text + routerLink target.
      const backLink = root.querySelector('div.mt-8 a');
      expect(backLink?.textContent?.trim()).toBe(back);
      expect(backLink?.getAttribute('href')).toBe(href);
    },
  );

  it.each(CASES)('sets the $kind/$entity meta title', ({ entity, kind, slug, title }) => {
    render(entity, kind, slug);
    expect(TestBed.inject(Title).getTitle()).toBe(title);
  });

  it.each(CASES)(
    'keeps $entity/$kind stub URLs out of the index (noindex)',
    ({ entity, kind, slug }) => {
      render(entity, kind, slug);
      expect(TestBed.inject(Meta).getTag('name="robots"')?.content).toBe('noindex');
    },
  );
});

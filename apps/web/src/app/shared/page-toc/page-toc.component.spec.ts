/**
 * AECI-1720 layout pass: the "On this page" list of `/methodology` and `/legal/*`.
 * Its place on the real pages is pinned in `methodology.component.spec.ts` and
 * `legal-page.component.spec.ts`.
 */
import { PLATFORM_ID, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { DocsHeading } from '../../docs/docs-markdown';
import { PROSE_PAGE_RESERVED_IDS } from '../../legal/legal-render';
import { AecPageToc, PAGE_TOC_HEADING_ID, PAGE_TOC_MIN_HEADINGS } from './page-toc';

const Stub = class {};

async function render(
  headings: readonly DocsHeading[],
  url = '/legal/terms',
  platform: 'browser' | 'server' = 'browser',
): Promise<HTMLElement> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: '**', component: Stub }]),
      { provide: PLATFORM_ID, useValue: platform },
    ],
  });
  await TestBed.inject(Router).navigateByUrl(url);
  const fixture = TestBed.createComponent(AecPageToc);
  fixture.componentRef.setInput('headings', headings);
  fixture.detectChanges();
  lastFixture = fixture;
  return fixture.nativeElement as HTMLElement;
}

let lastFixture: { detectChanges(): void } | undefined;

const ONE: readonly DocsHeading[] = [{ id: 'what-the-service-is', text: 'What the service is' }];
const THREE: readonly DocsHeading[] = [
  ...ONE,
  { id: 'how-listings-are-sourced', text: 'How listings are sourced' },
  { id: 'contact', text: 'Contact' },
];

describe('AecPageToc', () => {
  it(`renders nothing below ${PAGE_TOC_MIN_HEADINGS} headings`, async () => {
    expect((await render([])).querySelector('nav')).toBeNull();
    expect((await render(ONE)).querySelector('nav')).toBeNull();
  });

  // The visible label names the landmark, and its id can never be a heading slug.
  it('is a nav named by its visible "On this page" label', async () => {
    const nav = (await render(THREE)).querySelector('nav')!;
    const label = nav.querySelector('p')!;
    expect(label.textContent?.trim()).toBe('On this page');
    expect(label.id).toBe(PAGE_TOC_HEADING_ID);
    expect(nav.getAttribute('aria-labelledby')).toBe(PAGE_TOC_HEADING_ID);
    expect(PROSE_PAGE_RESERVED_IDS).toContain(PAGE_TOC_HEADING_ID);
  });

  // The page's own headings, word for word, in order.
  it('lists the headings as shown text, in order', async () => {
    const links = [...(await render(THREE)).querySelectorAll('nav a')];
    expect(links.map((a) => a.textContent?.trim())).toEqual([
      'What the service is',
      'How listings are sourced',
      'Contact',
    ]);
  });

  // A bare #id would resolve against <base href="/"> and leave the page.
  it('links by absolute path plus fragment, opted in to the smooth jump', async () => {
    const links = [...(await render(THREE)).querySelectorAll('nav a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/legal/terms#what-the-service-is',
      '/legal/terms#how-listings-are-sourced',
      '/legal/terms#contact',
    ]);
    for (const a of links) expect(a.hasAttribute('data-smooth-scroll')).toBe(true);
  });

  // The cached HTML is the same for every visitor: the first heading is current.
  it('marks the first heading current in the server render', async () => {
    const links = [...(await render(THREE, '/legal/terms', 'server')).querySelectorAll('nav a')];
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual(['location', null, null]);
  });

  // The current link is not told by colour alone: its weight changes too.
  it('marks the current link by weight as well as colour', async () => {
    const link = (await render(THREE)).querySelector('nav a[aria-current="location"]')!;
    expect(link.className).toContain('aria-[current=location]:font-semibold');
    expect(link.className).toContain('min-h-6');
  });

  it('moves the mark to a clicked heading', async () => {
    const host = await render(THREE);
    const third = host.querySelectorAll<HTMLAnchorElement>('nav a')[2];
    third.addEventListener('click', (e) => e.preventDefault());
    third.click();
    lastFixture!.detectChanges();
    expect(third.getAttribute('aria-current')).toBe('location');
  });
});

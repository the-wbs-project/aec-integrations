/**
 * AECI-1259 — the "On this page" rail on its own: the heading threshold and the
 * fragment links. Its place on a real article is pinned in
 * `docs-shell.component.spec.ts`.
 */
import { PLATFORM_ID, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { DocsHeading } from './docs-markdown';
import { DOCS_TOC_MIN_HEADINGS, DocsTocComponent } from './docs-toc';

const Stub = class {};

/** Mounts the rail on `url`, as the browser or as the server render. */
async function mount(
  headings: readonly DocsHeading[],
  url = '/docs/trust/how-ranking-works',
  platform: 'browser' | 'server' = 'browser',
) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: '**', component: Stub }]),
      { provide: PLATFORM_ID, useValue: platform },
    ],
  });
  await TestBed.inject(Router).navigateByUrl(url);
  const fixture = TestBed.createComponent(DocsTocComponent);
  fixture.componentRef.setInput('headings', headings);
  fixture.detectChanges();
  return fixture;
}

async function render(
  headings: readonly DocsHeading[],
  url?: string,
  platform?: 'browser' | 'server',
): Promise<HTMLElement> {
  return (await mount(headings, url, platform)).nativeElement as HTMLElement;
}

const hrefs = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('nav a')).map((a) => a.getAttribute('href'));

const ONE: readonly DocsHeading[] = [{ id: 'search', text: 'Search' }];
const TWO: readonly DocsHeading[] = [...ONE, { id: 'browsing-lists', text: 'Browsing lists' }];

describe('DocsTocComponent', () => {
  // One heading is one place; a rail pointing at it is noise.
  it(`renders nothing below ${DOCS_TOC_MIN_HEADINGS} headings`, async () => {
    expect(DOCS_TOC_MIN_HEADINGS).toBe(2);
    expect((await render([])).querySelector('nav')).toBeNull();
    expect((await render(ONE)).querySelector('nav')).toBeNull();
  });

  // A bare #id would resolve against <base href="/"> and leave the page. Plain
  // anchors, opted in to the smooth in-page jump (AECI-1752).
  it('links each heading by absolute path plus fragment', async () => {
    const host = await render(TWO);
    const nav = host.querySelector('nav')!;
    expect(nav.getAttribute('aria-label')).toBe('On this page');
    expect(Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      '/docs/trust/how-ranking-works#search',
      '/docs/trust/how-ranking-works#browsing-lists',
    ]);
    for (const a of Array.from(nav.querySelectorAll('a'))) {
      expect(a.hasAttribute('data-smooth-scroll')).toBe(true);
    }
  });

  // AECI-1843: a path-only href on a URL with a query is a different URL, so the
  // click loaded the whole page again. The browser keeps the query.
  it('keeps the query string in the browser, so a click never reloads', async () => {
    expect(hrefs(await render(TWO, '/docs/trust/how-ranking-works?utm_source=mail'))).toEqual([
      '/docs/trust/how-ranking-works?utm_source=mail#search',
      '/docs/trust/how-ranking-works?utm_source=mail#browsing-lists',
    ]);
  });

  // The docs pages are edge-cached and their key drops the query, so the server
  // render drops it too: one cache entry, one set of hrefs.
  it('drops the query on the server, so cached HTML is the same for every visitor', async () => {
    const plain = await render(TWO, '/docs/trust/how-ranking-works', 'server');
    const tagged = await render(TWO, '/docs/trust/how-ranking-works?utm_source=mail', 'server');
    expect(hrefs(tagged)).toEqual(hrefs(plain));
    expect(tagged.innerHTML).toBe(plain.innerHTML);
  });

  // Each link's accessible name is its heading text, present while the rail is closed.
  it('names every link by its heading text', async () => {
    const links = Array.from((await render(TWO)).querySelectorAll('a'));
    expect(links.map((a) => a.querySelector('.aec-docs-toc-label')?.textContent)).toEqual([
      'Search',
      'Browsing lists',
    ]);
  });

  // A click marks its heading current at once, before the observer catches up.
  it('moves aria-current to a clicked heading', async () => {
    const fixture = await mount(TWO);
    const links = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual(['location', null]);
    // Stop jsdom following the href. The host's listener runs first, as in a
    // browser, and never cancels the click itself.
    const stop = (e: Event) => e.preventDefault();
    window.addEventListener('click', stop);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    links[1].querySelector('.aec-docs-toc-label')!.dispatchEvent(click);
    window.removeEventListener('click', stop);
    fixture.detectChanges();
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'location']);
  });
});

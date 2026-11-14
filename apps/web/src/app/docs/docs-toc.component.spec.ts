/**
 * AECI-1259 — the "On this page" rail on its own: the heading threshold and the
 * fragment links. Its place on a real article is pinned in
 * `docs-shell.component.spec.ts`.
 */
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { DocsHeading } from './docs-markdown';
import { DOCS_TOC_MIN_HEADINGS, DocsTocComponent } from './docs-toc';

function render(headings: readonly DocsHeading[]): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({});
  const fixture = TestBed.createComponent(DocsTocComponent);
  fixture.componentRef.setInput('headings', headings);
  fixture.componentRef.setInput('path', '/docs/trust/how-ranking-works');
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const ONE: readonly DocsHeading[] = [{ id: 'search', text: 'Search' }];
const TWO: readonly DocsHeading[] = [...ONE, { id: 'browsing-lists', text: 'Browsing lists' }];

describe('DocsTocComponent', () => {
  // One heading is one place; a rail pointing at it is noise.
  it(`renders nothing below ${DOCS_TOC_MIN_HEADINGS} headings`, () => {
    expect(DOCS_TOC_MIN_HEADINGS).toBe(2);
    expect(render([]).querySelector('nav')).toBeNull();
    expect(render(ONE).querySelector('nav')).toBeNull();
  });

  // A bare #id would resolve against <base href="/"> and leave the page. Plain
  // anchors, opted in to the smooth in-page jump (AECI-1752).
  it('links each heading by absolute path plus fragment', () => {
    const host = render(TWO);
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

  // Each link's accessible name is its heading text, present while the rail is closed.
  it('names every link by its heading text', () => {
    const links = Array.from(render(TWO).querySelectorAll('a'));
    expect(links.map((a) => a.querySelector('.aec-docs-toc-label')?.textContent)).toEqual([
      'Search',
      'Browsing lists',
    ]);
  });

  // A click marks its heading current at once, before the observer catches up.
  it('moves aria-current to a clicked heading', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const fixture = TestBed.createComponent(DocsTocComponent);
    fixture.componentRef.setInput('headings', TWO);
    fixture.componentRef.setInput('path', '/docs/trust/how-ranking-works');
    fixture.detectChanges();
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

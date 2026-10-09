/**
 * AECI-1259 — the help-center shell (`/docs` layout route): the sidebar tree,
 * `aria-current`, the top bar, the small-screen menu toggle, and the "On this
 * page" rail it hosts on an article.
 *
 * `*.component.spec.ts` because the manifest imports `.md` files (see
 * `docs-page.component.spec.ts`). Rendered through the real `DOCS_ROUTES`, so
 * the layout route and its children are what is under test.
 */
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DOCS_SECTIONS,
  type DocsSectionId,
  type DocsSectionMeta,
  buildDocsManifest,
  getDocsPage,
} from './docs-content';
import { locate } from './docs-shell';
import { DOCS_ROUTES } from './docs.routes';

const ARTICLE = '/docs/trust/how-ranking-works';

async function renderAt(
  url: string,
): Promise<{ host: HTMLElement; harness: RouterTestingHarness }> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: 'docs', children: DOCS_ROUTES }])],
  });
  const harness = await RouterTestingHarness.create(url);
  await harness.fixture.whenStable();
  harness.fixture.detectChanges();
  return { host: harness.fixture.nativeElement as HTMLElement, harness };
}

function tree(host: HTMLElement): HTMLElement {
  return host.querySelector('nav[aria-label="Help center"]')!;
}

function current(host: HTMLElement): string[] {
  return Array.from(tree(host).querySelectorAll('a[aria-current="page"]')).map(
    (a) => a.getAttribute('href') ?? '',
  );
}

function crumbs(host: HTMLElement): (readonly [string, string | null])[] {
  return Array.from(host.querySelectorAll('nav[aria-label="Breadcrumb"] li')).map((li) => {
    const link = li.querySelector('a');
    const label = (link ?? li.querySelector('[aria-current="page"]'))?.textContent?.trim() ?? '';
    return [label, link ? link.getAttribute('href') : null] as const;
  });
}

describe('DocsShellComponent', () => {
  beforeEach(() => {
    document.head.querySelector('meta[name="robots"]')?.remove();
  });

  // The tree must list exactly what the manifest shows, so a new page or an
  // emptied section changes the sidebar with no template edit.
  it('lists Help center, then every visible section in manifest order with its pages', async () => {
    const { host } = await renderAt(ARTICLE);
    const top = Array.from(tree(host).querySelectorAll(':scope > ul > li > a')).map((a) =>
      a.getAttribute('href'),
    );
    expect(top).toEqual(['/docs', ...DOCS_SECTIONS.map((section) => section.path)]);
    for (const section of DOCS_SECTIONS) {
      const item = tree(host).querySelector(`li[data-section="${section.id}"]`)!;
      const children = Array.from(item.querySelectorAll(':scope > ul a')).map((a) => [
        a.textContent?.trim(),
        a.getAttribute('href'),
      ]);
      expect(children, section.id).toEqual(section.pages.map((page) => [page.title, page.path]));
    }
    // An empty section shows nowhere.
    expect(tree(host).querySelector('a[href^="/docs/faq"]')).toBeNull();
  });

  // Exact matching: a page marks itself only, never its section or the home.
  it('marks only the current article with aria-current="page"', async () => {
    const { host } = await renderAt(ARTICLE);
    expect(current(host)).toEqual([ARTICLE]);
  });

  // The section's own item is current on its index page, and no page under it.
  it('marks the section item on a section index', async () => {
    const { host } = await renderAt('/docs/trust');
    expect(current(host)).toEqual(['/docs/trust']);
  });

  it('marks Help center on the docs home', async () => {
    const { host } = await renderAt('/docs');
    expect(current(host)).toEqual(['/docs']);
  });

  // The trail is ancestors as links, then the current place as text.
  it('derives the top-bar breadcrumb from the URL', async () => {
    expect(crumbs((await renderAt('/docs')).host)).toEqual([['Help center', null]]);
    expect(crumbs((await renderAt('/docs/trust')).host)).toEqual([
      ['Help center', '/docs'],
      ['Trust and ranking', null],
    ]);
    // An article stops at its section, as DeepWiki's does; the h1 names the page.
    expect(crumbs((await renderAt(ARTICLE)).host)).toEqual([
      ['Help center', '/docs'],
      ['Trust and ranking', '/docs/trust'],
    ]);
  });

  // "Last updated" belongs to an article; the home and indexes have no date.
  it('shows the article date in the top bar, and none on an index', async () => {
    const page = getDocsPage('trust', 'how-ranking-works')!;
    const article = (await renderAt(ARTICLE)).host;
    expect(article.querySelector('#docs-nav-panel')?.previousElementSibling?.textContent).toContain(
      `Last updated ${page.lastUpdated}`,
    );
    const index = (await renderAt('/docs/trust')).host;
    expect(index.textContent).not.toContain('Last updated');
  });

  // Below lg the tree is a panel: closed in the SSR HTML, opened by the button,
  // closed again by any navigation.
  it('toggles the small-screen panel and closes it on navigation', async () => {
    const { host, harness } = await renderAt(ARTICLE);
    const button = host.querySelector<HTMLButtonElement>('button[aria-controls="docs-nav-panel"]')!;
    const panel = host.querySelector('#docs-nav-panel')!;
    expect(button.getAttribute('aria-label')).toBe('Docs menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(panel.classList).toContain('hidden');

    button.click();
    harness.fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(panel.classList).not.toContain('hidden');

    await TestBed.inject(Router).navigateByUrl('/docs/trust/agreement-states');
    await harness.fixture.whenStable();
    harness.fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(panel.classList).toContain('hidden');
  });

  // Escape is the expected way out of an open disclosure, and focus goes back.
  it('closes the panel on Escape and returns focus to the button', async () => {
    const { host, harness } = await renderAt(ARTICLE);
    const button = host.querySelector<HTMLButtonElement>('button[aria-controls="docs-nav-panel"]')!;
    button.click();
    harness.fixture.detectChanges();
    const link = tree(host).querySelector<HTMLAnchorElement>('a')!;
    link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    harness.fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  // The rail is real links named by the headings, pointing at ids that exist.
  it('renders the On this page rail from the article h2s, without Related', async () => {
    const { host } = await renderAt(ARTICLE);
    const page = getDocsPage('trust', 'how-ranking-works')!;
    const rail = host.querySelector('nav[aria-label="On this page"]')!;
    const links = Array.from(rail.querySelectorAll('a'));
    expect(links.map((a) => [a.textContent?.trim(), a.getAttribute('href')])).toEqual(
      page.headings.map((h) => [h.text, `${ARTICLE}#${h.id}`]),
    );
    expect(links.map((a) => a.textContent?.trim())).not.toContain('Related');
    for (const h of page.headings) {
      expect(host.querySelector(`h2[id="${h.id}"]`)?.textContent?.trim(), h.id).toBe(h.text);
    }
    // The dashes are decoration; the link text carries the name.
    for (const a of links) {
      expect(a.querySelector('.aec-docs-toc-dash')?.getAttribute('aria-hidden')).toBe('true');
    }
    // SSR-neutral start: the first heading is current until the browser scrolls.
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([
      'location',
      ...links.slice(1).map(() => null),
    ]);
  });

  // A duplicate id breaks fragment links and aria references alike.
  it('renders no duplicate id anywhere on an article', async () => {
    for (const url of [ARTICLE, '/docs/vendors/owning-an-integration', '/docs']) {
      const { host } = await renderAt(url);
      const ids = Array.from(host.querySelectorAll('[id]')).map((el) => el.id);
      expect(new Set(ids).size, url).toBe(ids.length);
    }
  });

  // The page of a single-page section IS the section, so its crumb is current.
  // No such section is visible today, so a fixture manifest reaches the branch.
  it('makes a single-page section the current crumb on its one page', () => {
    const meta = Object.fromEntries(
      DOCS_SECTIONS.map((section) => [
        section.id,
        { label: section.id, summary: 's', audience: section.audience, order: section.order },
      ]),
    ) as Record<DocsSectionId, DocsSectionMeta>;
    meta.faq = { label: 'FAQ', summary: 's', audience: 'reader', order: 9, singlePage: true };
    const source = [
      '---',
      'title: Common questions',
      'description: d',
      'section: faq',
      'order: 1',
      'last_updated: 9 October 2026',
      '---',
      '',
      '## Related',
      '',
    ].join('\n');
    const { sections } = buildDocsManifest(meta, { faq: [{ slug: 'faq', source }] });
    const located = locate('/docs/faq', sections);
    expect(located.crumbs).toEqual([{ label: 'Help center', path: '/docs' }, { label: 'FAQ' }]);
    expect(located.page?.lastUpdated).toBe('9 October 2026');
    // An unknown path falls back to the home crumb rather than throwing.
    expect(locate('/docs/nope', sections).crumbs).toEqual([{ label: 'Help center' }]);
  });
});

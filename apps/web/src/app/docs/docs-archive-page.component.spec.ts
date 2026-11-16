/**
 * AECI-1619 (counsel ruling 16) and AECI-1621 (counsel Q23): a recorded version
 * of a versioned docs page at `/docs/<section>/<slug>/v<version>`. Follows the
 * legal archive specs (`legal-page.component.spec.ts`, "archived versions").
 * `*.component.spec.ts` because the page imports the bundled `.md` files.
 */
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { buildDocsSnapshots, getDocsSnapshot } from './docs-archive-content';
import { DocsArchivePageComponent } from './docs-archive-page';
import { DOCS_PAGE_VERSIONS } from './docs-page-versions';
import { PLANS_PAGE_KNOWN_VERSIONS, PLANS_PAGE_RECORDED_ON } from './plans-versions';
import { RANKING_PAGE_KNOWN_VERSIONS, RANKING_PAGE_RECORDED_ON } from './ranking-page-versions';

const PLANS = 'vendors/plans';
const RANKING = 'trust/how-ranking-works';

function render(page: string, version: string): { host: HTMLElement; title: Title } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { data: { page, version } } } },
    ],
  });
  const fixture = TestBed.createComponent(DocsArchivePageComponent);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, title: TestBed.inject(Title) };
}

const noticeText = (host: HTMLElement, testid: string): string | undefined =>
  host.querySelector(`[data-testid="${testid}"]`)?.textContent?.replace(/\s+/g, ' ').trim();

describe('docs archive content', () => {
  it('bundles a file for every known version of every versioned page, dated as the registry says', () => {
    for (const [page, versions] of Object.entries(DOCS_PAGE_VERSIONS)) {
      for (const version of versions.known) {
        const snapshot = getDocsSnapshot(page, version);
        expect(snapshot?.page, `${page} ${version}`).toBe(page);
        expect(snapshot?.version, `${page} ${version}`).toBe(version);
        expect(snapshot?.recordedOn, `${page} ${version}`).toBe(versions.recordedOn[version]);
      }
    }
    expect(Object.keys(DOCS_PAGE_VERSIONS)).toEqual([PLANS, RANKING]);
    expect(PLANS_PAGE_KNOWN_VERSIONS.map((v) => getDocsSnapshot(PLANS, v)?.recordedOn)).toEqual(
      PLANS_PAGE_KNOWN_VERSIONS.map((v) => PLANS_PAGE_RECORDED_ON[v]),
    );
    expect(RANKING_PAGE_KNOWN_VERSIONS.map((v) => getDocsSnapshot(RANKING, v)?.recordedOn)).toEqual(
      RANKING_PAGE_KNOWN_VERSIONS.map((v) => RANKING_PAGE_RECORDED_ON[v]),
    );
    expect(getDocsSnapshot(PLANS, '0.1')).toBeUndefined();
    expect(getDocsSnapshot('trust/agreement-states', '1.0')).toBeUndefined();
  });

  it('throws on a missing file, a wrong version or date, or a file the registry does not know', () => {
    const registry = { 'a/b': { current: '1.0', known: ['1.0'], recordedOn: { '1.0': 'May 1' } } };
    const file = (version: string, date: string) =>
      `---\ntitle: B\nversion: ${version}\nrecorded_on: ${date}\n---\n\nBody.\n`;
    expect(buildDocsSnapshots(registry, { 'a/b': { '1.0': file('1.0', 'May 1') } }).size).toBe(1);
    expect(() => buildDocsSnapshots(registry, {})).toThrow(/has no bundled file/);
    expect(() => buildDocsSnapshots(registry, { 'a/b': { '1.0': file('1.1', 'May 1') } })).toThrow(
      /names version "1.1"/,
    );
    expect(() => buildDocsSnapshots(registry, { 'a/b': { '1.0': file('1.0', 'May 2') } })).toThrow(
      /recorded on "May 2", not "May 1"/,
    );
    expect(() =>
      buildDocsSnapshots(registry, {
        'a/b': { '1.0': file('1.0', 'May 1'), '2.0': file('2.0', 'May 1') },
      }),
    ).toThrow(/2.0, not a known version/);
    expect(() =>
      buildDocsSnapshots(registry, {
        'a/b': { '1.0': file('1.0', 'May 1') },
        'c/d': { '1.0': file('1.0', 'May 1') },
      }),
    ).toThrow(/"c\/d", which is not in DOCS_PAGE_VERSIONS/);
  });
});

describe('DocsArchivePageComponent: Plans (AECI-1619)', () => {
  it('renders v1.0 with the recorded-version notice linking the live page', () => {
    const { host, title } = render(PLANS, '1.0');
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent?.trim()).toBe('Plans');
    expect(noticeText(host, 'plans-archive-notice')).toBe(
      'This is the Plans page as recorded at version 1.0 on November 11, 2026. Read the current page.',
    );
    const notice = host.querySelector('[data-testid="plans-archive-notice"]');
    expect(notice?.querySelector('a')?.getAttribute('href')).toBe('/docs/vendors/plans');
    expect(host.querySelector('[data-testid="docs-archive-notice"]')).toBeNull();
    expect(title.getTitle()).toBe('Plans, version 1.0 · AEC Integrations');
  });

  it('renders the snapshot body: the headings with ids, the cards and the comparison table', () => {
    const { host } = render(PLANS, '1.0');
    const h2s = Array.from(host.querySelectorAll('h2'));
    expect(h2s.map((h) => h.textContent?.trim())).toContain('Compare plans');
    expect(h2s.find((h) => h.textContent?.trim() === 'Compare plans')?.id).toBe('compare-plans');
    expect(h2s.map((h) => h.textContent?.trim())).not.toContain('Versions');
    const table = host.querySelector('table');
    expect(table?.textContent).toContain('Seats for your colleagues');
    expect(table?.textContent).toContain('$25 USD a month');
    // The closing panel's terms are part of the record (ruled 2026-11-11). Buttons are not.
    expect(host.textContent).toContain('Full refund within 14 days.');
    expect(host.querySelector('a[href="/vendor-program"]')?.textContent).toBe('the vendor program');
    expect(host.querySelector('aec-plan-cards, aec-plan-cta-panel, button')).toBeNull();
  });

  it('is noindex and canonicalises to the live Plans page', () => {
    render(PLANS, '1.0');
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex',
    );
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toMatch(
      /\/docs\/vendors\/plans$/,
    );
  });
});

describe('DocsArchivePageComponent: How ranking works (AECI-1621)', () => {
  it('renders v1.0 with the recorded-version notice linking the live page', () => {
    const { host, title } = render(RANKING, '1.0');
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent?.trim()).toBe('How ranking works');
    expect(noticeText(host, 'docs-archive-notice')).toBe(
      'This is version 1.0, recorded on November 16, 2026. Read the current version.',
    );
    const notice = host.querySelector('[data-testid="docs-archive-notice"]');
    expect(notice?.querySelector('a')?.getAttribute('href')).toBe('/docs/trust/how-ranking-works');
    expect(host.querySelector('[data-testid="plans-archive-notice"]')).toBeNull();
    expect(title.getTitle()).toBe('How ranking works, version 1.0 · AEC Integrations');
  });

  it('renders the recorded body with its heading ids, and no Versions section', () => {
    const { host } = render(RANKING, '1.0');
    const h2s = Array.from(host.querySelectorAll('h2'));
    expect(h2s.map((h) => h.id)).toEqual([
      'search',
      'browsing-lists',
      'the-home-page',
      'what-does-not-count',
      'what-a-plan-does-not-buy',
      'corrections-are-free',
      'related',
    ]);
    expect(host.textContent).toContain('No plan, at any price, changes');
    expect(host.querySelector('a[href="/methodology"]')).not.toBeNull();
  });

  it('is noindex and canonicalises to the live ranking page', () => {
    render(RANKING, '1.0');
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex',
    );
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toMatch(
      /\/docs\/trust\/how-ranking-works$/,
    );
  });
});

describe('DocsArchivePageComponent: unknown versions', () => {
  it('throws on a version or page with no recorded file', () => {
    expect(() => render(PLANS, '9.9')).toThrow(/No recorded version "9.9"/);
    expect(() => render('trust/agreement-states', '1.0')).toThrow(/agreement-states/);
  });
});

/**
 * AECI-2237: the `/legal` index.
 *
 * INVARIANTS:
 *   1. One row per document, in `LEGAL_SLUGS` order, each linking `/legal/<slug>`.
 *   2. Each row shows the version and "Effective <date>", or "Draft" while undated.
 *   3. A switched upcoming version shows as the one in force, as on its own page.
 *   4. The page is indexable, with a self canonical.
 */
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { type LegalDoc, getLegalDoc, getLegalVersion } from './legal-content';
import { LegalIndexPage } from './legal-index';
import type { LegalUpcomingEntry } from './legal-manifest';
import { LEGAL_DOC_LOOKUP, type LegalDocLookup } from './legal-page';
import { LEGAL_SLUGS, legalPath } from './legal-slugs';
import { LEGAL_UPCOMING_ENTRIES } from './legal-upcoming-token';

function render(
  opts: {
    lookup?: LegalDocLookup;
    upcoming?: readonly LegalUpcomingEntry[];
    legalSwitched?: Record<string, boolean>;
  } = {},
): { host: HTMLElement; title: Title } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            data: opts.legalSwitched === undefined ? {} : { legalSwitched: opts.legalSwitched },
          },
        },
      },
      ...(opts.lookup ? [{ provide: LEGAL_DOC_LOOKUP, useValue: opts.lookup }] : []),
      ...(opts.upcoming ? [{ provide: LEGAL_UPCOMING_ENTRIES, useValue: opts.upcoming }] : []),
    ],
  });
  const fixture = TestBed.createComponent(LegalIndexPage);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, title: TestBed.inject(Title) };
}

const rows = (host: HTMLElement) =>
  Array.from(host.querySelectorAll<HTMLElement>('[data-testid="legal-index-row"]'));
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

/** The bundled current doc of `slug` with another effective date. */
function withDate(slug: string, effectiveDate: string): LegalDoc {
  const doc = getLegalDoc(slug)!;
  return { ...doc, frontmatter: { ...doc.frontmatter, effectiveDate } };
}

describe('LegalIndexPage', () => {
  it('has the single h1 "Legal"', () => {
    const { host } = render();
    const h1s = host.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(text(h1s[0])).toBe('Legal');
  });

  it('lists the six documents in canonical order, each linking its page (invariant 1)', () => {
    const { host } = render();
    const list = rows(host);
    expect(list).toHaveLength(6);
    expect(list.map((r) => r.querySelector('a')?.getAttribute('href'))).toEqual(
      LEGAL_SLUGS.map((slug) => legalPath(slug)),
    );
    expect(list.map((r) => text(r.querySelector('a')))).toEqual(
      LEGAL_SLUGS.map((slug) => getLegalDoc(slug)!.frontmatter.title),
    );
  });

  it('shows each version, and "Draft" while the effective date is blank (invariant 2)', () => {
    const { host } = render({
      lookup: {
        current: (slug) => (slug === 'terms' ? withDate('terms', '') : getLegalDoc(slug)),
        version: getLegalVersion,
      },
    });
    const first = rows(host)[0];
    const version = getLegalDoc('terms')!.frontmatter.version;
    expect(text(first?.querySelector('p'))).toBe(`Version ${version} · Draft`);
  });

  it('shows "Effective <date>" once dated (invariant 2)', () => {
    const { host } = render({
      lookup: {
        current: (slug) =>
          slug === 'privacy' ? withDate('privacy', 'January 4, 2027') : getLegalDoc(slug),
        version: getLegalVersion,
      },
    });
    const second = rows(host)[1];
    const version = getLegalDoc('privacy')!.frontmatter.version;
    expect(text(second?.querySelector('p'))).toBe(`Version ${version} · Effective January 4, 2027`);
  });

  describe('a switched upcoming version (invariant 3)', () => {
    const UPCOMING: LegalDoc = {
      ...getLegalDoc('vendor-terms')!,
      frontmatter: {
        ...getLegalDoc('vendor-terms')!.frontmatter,
        version: '9.0',
        effectiveDate: 'March 31, 2027',
      },
      effectiveOn: '2027-03-31',
    };
    const lookup: LegalDocLookup = {
      current: getLegalDoc,
      version: (slug, version) =>
        slug === 'vendor-terms' && version === '9.0' ? UPCOMING : getLegalVersion(slug, version),
    };
    const upcoming: LegalUpcomingEntry[] = [
      { slug: 'vendor-terms', version: '9.0', effectiveOn: '2027-03-31' },
    ];
    const vendorRow = (host: HTMLElement) =>
      rows(host)[LEGAL_SLUGS.indexOf('vendor-terms')]?.querySelector('p');

    it('before the switch the build version shows', () => {
      const { host } = render({ lookup, upcoming, legalSwitched: { 'vendor-terms': false } });
      const version = getLegalDoc('vendor-terms')!.frontmatter.version;
      expect(text(vendorRow(host))).toContain(`Version ${version}`);
    });

    it('after the switch the upcoming version shows with its date', () => {
      const { host } = render({ lookup, upcoming, legalSwitched: { 'vendor-terms': true } });
      expect(text(vendorRow(host))).toBe('Version 9.0 · Effective March 31, 2027');
    });
  });

  it('is indexable, with a self canonical (invariant 4)', () => {
    const { title } = render();
    expect(title.getTitle()).toBe('Legal · AEC Integrations');
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
    const link = document.head.querySelector('link[rel="canonical"]');
    expect(link?.getAttribute('href')).toMatch(/\/legal$/);
  });
});

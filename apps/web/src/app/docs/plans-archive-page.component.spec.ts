/**
 * AECI-1619 (counsel ruling 16): a recorded Plans version at
 * `/docs/vendors/plans/v<version>`. Follows the legal archive specs
 * (`legal-page.component.spec.ts`, "archived versions"). `*.component.spec.ts`
 * because the page imports the bundled `.md` snapshot.
 */
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { getPlansSnapshot } from './plans-archive-content';
import { PlansArchivePageComponent } from './plans-archive-page';
import { PLANS_PAGE_KNOWN_VERSIONS, PLANS_PAGE_RECORDED_ON } from './plans-versions';

function render(version: string): { host: HTMLElement; title: Title } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { data: { version } } } },
    ],
  });
  const fixture = TestBed.createComponent(PlansArchivePageComponent);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, title: TestBed.inject(Title) };
}

describe('PlansArchivePageComponent', () => {
  it('bundles a snapshot for every known version, dated as the registry says', () => {
    for (const version of PLANS_PAGE_KNOWN_VERSIONS) {
      const snapshot = getPlansSnapshot(version);
      expect(snapshot?.version, version).toBe(version);
      expect(snapshot?.recordedOn, version).toBe(PLANS_PAGE_RECORDED_ON[version]);
    }
    expect(getPlansSnapshot('0.1')).toBeUndefined();
  });

  it('renders v1.0 with the recorded-version notice linking the live page', () => {
    const { host, title } = render('1.0');
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent?.trim()).toBe('Plans');
    const notice = host.querySelector('[data-testid="plans-archive-notice"]');
    expect(notice?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'This is the Plans page as recorded at version 1.0 on November 11, 2026. Read the current page.',
    );
    expect(notice?.querySelector('a')?.getAttribute('href')).toBe('/docs/vendors/plans');
    expect(title.getTitle()).toBe('Plans, version 1.0 · AEC Integrations');
  });

  it('renders the snapshot body: the headings with ids, the cards and the comparison table', () => {
    const { host } = render('1.0');
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
    render('1.0');
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex',
    );
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toMatch(
      /\/docs\/vendors\/plans$/,
    );
  });

  it('throws on a version with no snapshot', () => {
    expect(() => render('9.9')).toThrow(/No Plans snapshot/);
  });
});

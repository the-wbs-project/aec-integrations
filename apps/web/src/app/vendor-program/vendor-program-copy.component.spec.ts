import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { Analytics } from '../analytics/analytics';
import { getDocsPage } from '../docs/docs-content';
import { VendorPlanStatus } from '../vendor/vendor-plan-status';
import { VendorProgramPage } from './vendor-program';

/**
 * Drift guard (`docs/VENDOR_PROGRAM_PAGE_SPEC.md` §3 items 4, 5, 7 and 8): the
 * vendor program page takes its Free, Managed, sort-rule and Coming soon wording
 * from the vendor guide's Plans page (`src/content/docs/vendors/plans.md`). That
 * page is Markdown, not i18n'd, so the two cannot share ids. This spec fails when
 * a sentence on one side changes without the other. Comparison is per sentence,
 * case-insensitive, ignoring the trailing punctuation a Markdown list item carries.
 * It also pins the Plans page fragments this page links to.
 */
function normalize(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Split into sentences, dropping the trailing period or comma. */
function sentences(value: string): string[] {
  return normalize(value)
    .split(/(?<=\.)\s+/)
    .map((s) => s.replace(/[.,]$/, '').trim())
    .filter((s) => s.length > 0);
}

function render(): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: Analytics, useValue: { planCtaClicked: vi.fn(), vendorProductSearch: vi.fn() } },
      {
        provide: VendorPlanStatus,
        useValue: { vendorSlug: signal(null), vendorName: signal(null), managed: signal(null) },
      },
    ],
  });
  const fixture = TestBed.createComponent(VendorProgramPage);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('vendor program copy stays in step with /docs/vendors/plans', () => {
  const plans = getDocsPage('vendors', 'plans')!;
  const docText = normalize(plans.html);

  /** Every sentence in `el` must appear on the Plans page. */
  function expectFromDocs(el: Element | null, label: string): void {
    expect(el, label).not.toBeNull();
    for (const sentence of sentences(el!.innerHTML)) {
      expect(docText, `${label}: "${sentence}"`).toContain(sentence);
    }
  }

  it('the Plans page exists', () => {
    expect(plans).toBeDefined();
  });

  it('What Free gives you: every line is the Plans page wording', () => {
    const host = render();
    const items = [...host.querySelectorAll('#vp-free li p:last-child')];
    expect(items).toHaveLength(4);
    items.forEach((p, i) => expectFromDocs(p, `free ${i}`));
  });

  it('What Managed adds: the lede and every line are the Plans page wording', () => {
    const host = render();
    expectFromDocs(host.querySelector('#vp-managed > div > p'), 'managed lede');
    const items = [...host.querySelectorAll('#vp-managed li')];
    expect(items).toHaveLength(7);
    items.forEach((li, i) => expectFromDocs(li, `managed ${i}`));
  });

  it('How listings are sorted: the sort rule is the Plans page wording', () => {
    const host = render();
    expectFromDocs(host.querySelector('#vp-sorting p'), 'sort rule');
  });

  it('Coming soon: the Plans page wording', () => {
    const host = render();
    expectFromDocs(host.querySelector('#vp-coming-soon p'), 'coming soon');
  });

  it('every Plans page fragment this page links to exists', () => {
    const host = render();
    const fragments = new Set(
      [...host.querySelectorAll('a[href^="/docs/vendors/plans#"]')].map(
        (a) => a.getAttribute('href')!.split('#')[1]!,
      ),
    );
    expect([...fragments].sort()).toEqual([
      'compare-plans',
      'what-managed-adds',
      'when-a-managed-plan-ends',
    ]);
    for (const id of fragments) expect(plans.html, id).toContain(`id="${id}"`);
  });
});

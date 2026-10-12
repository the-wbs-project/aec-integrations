import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { Analytics } from '../analytics/analytics';
import { getDocsPage } from '../docs/docs-content';
import { VendorPlanStatus } from '../vendor/vendor-plan-status';
import { VendorProgramPage } from './vendor-program';

/**
 * What the vendor program page still shares with the vendor guide's Plans page
 * (`docs/VENDOR_PROGRAM_PAGE_SPEC.md` §3).
 *
 * Since the 2026-10-12 ruling this page carries its own benefit copy, and the Plans
 * page (`src/content/docs/vendors/plans.md`) stays the feature reference. So the
 * Free, Managed and Coming soon lines are NOT checked against the docs here: the
 * facts stay aligned, the sentences do not. Two things are still genuinely shared,
 * and this spec pins only those:
 *
 * - the sort rule, one i18n id on both Angular pages (`@@app.docs.plans.sortRule`),
 *   which must also read the same as the Plans page's Markdown;
 * - the Plans page fragments this page links to, which must exist.
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
      { provide: Analytics, useValue: { planCtaClicked: vi.fn() } },
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

describe('what the vendor program page shares with /docs/vendors/plans', () => {
  const plans = getDocsPage('vendors', 'plans')!;
  const docText = normalize(plans.html);

  it('the Plans page exists', () => {
    expect(plans).toBeDefined();
  });

  it('How listings are sorted: the sort rule is the Plans page wording', () => {
    const host = render();
    const rule = host.querySelector('#vp-sorting p');
    expect(rule).not.toBeNull();
    for (const sentence of sentences(rule!.innerHTML)) {
      expect(docText, `sort rule: "${sentence}"`).toContain(sentence);
    }
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

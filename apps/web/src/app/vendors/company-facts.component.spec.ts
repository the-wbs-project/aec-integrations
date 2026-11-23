import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { CompanyFacts as CompanyFactsData } from '@aeci/shared';

import { CompanyFacts } from './company-facts';

const NONE: CompanyFactsData = {
  headquarters: null,
  founded_year: null,
  company_size: null,
  ownership_type: null,
  parent_company: null,
  funding_stage: null,
};

function render(facts: CompanyFactsData, underReview: readonly string[] = []): HTMLElement {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(CompanyFacts);
  fixture.componentRef.setInput('facts', facts);
  fixture.componentRef.setInput('underReview', underReview);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

function trigger(el: HTMLElement): HTMLButtonElement | null {
  return el.querySelector('[data-testid="company-facts-sources-trigger"]');
}

/** The visible facts: label and value side by side. */
function list(el: HTMLElement): HTMLElement {
  return el.querySelector('[data-testid="company-facts-list"]') as HTMLElement;
}

/** The Sources pop-out: a native [popover], in the DOM from the first render. */
function sources(el: HTMLElement): HTMLElement {
  return el.querySelector('[data-testid="company-facts-sources"]') as HTMLElement;
}

describe('CompanyFacts', () => {
  it('renders nothing, and no "Unknown", when no fact shows', () => {
    const el = render(NONE);
    expect(el.querySelector('section')).toBeNull();
    expect(el.textContent).not.toContain('Unknown');
    expect(el.classList.contains('hidden')).toBe(true);
  });

  it('shows an AECi fact beside its label, and its date and source link in the pop-out', () => {
    const el = render({
      ...NONE,
      company_size: {
        value: '201-1000',
        source: {
          set_by: 'aeci',
          date: '2026-11-04T00:00:00.000Z',
          url: 'https://acme.example/about',
        },
      },
    });
    expect(list(el).querySelector('dt')!.textContent).toContain('Employees');
    expect(el.textContent).toContain('201–1,000');
    // The provenance waits behind the "i": the row itself is label and value only.
    expect(list(el).textContent).not.toContain('Set by');
    expect(trigger(el)!.getAttribute('aria-label')).toBe('Sources for these company facts');
    // The button opens the browser's own popover, so the sources are in the server HTML.
    const panel = sources(el);
    expect(trigger(el)!.getAttribute('popovertarget')).toBe(panel.id);
    expect(panel.hasAttribute('popover')).toBe(true);
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-labelledby')).toBe('vendor-facts-sources-title');
    expect(panel.textContent).toContain('Set by AEC Integrations on Nov 4, 2026');
    const link = panel.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://acme.example/about');
    expect(link.getAttribute('rel')).toBe('noopener nofollow');
    expect(link.getAttribute('target')).toBe('_blank');
    // "Source" and its icon wrap as one, so the font swap cannot re-wrap the row.
    expect(link.classList).toContain('whitespace-nowrap');
  });

  it('shows a vendor fact with no link, and omits a missing date', () => {
    const el = render({
      ...NONE,
      parent_company: {
        value: 'Nemetschek Group',
        source: { set_by: 'vendor', date: null, url: null },
      },
    });
    expect(el.textContent).toContain('Nemetschek Group');
    const panel = sources(el);
    expect(panel.textContent).toContain('Set by the vendor');
    expect(panel.textContent).not.toContain(' on ');
    expect(panel.querySelector('a')).toBeNull();
  });

  it('keeps an under-review row with its marker, and offers no pop-out when nothing is sourced', () => {
    const el = render(NONE, ['headquarters']);
    expect(
      el.querySelector('[data-testid="company-fact-under-review-headquarters"]'),
    ).not.toBeNull();
    expect(trigger(el)).toBeNull();
  });

  it('renders only the facts it is given, in a fixed order', () => {
    const source = { set_by: 'aeci', date: null, url: null } as const;
    const el = render({
      ...NONE,
      funding_stage: { value: 'Public', source },
      headquarters: { value: 'Oslo', source },
    });
    const labels = [...list(el).querySelectorAll('dt')].map((d) => d.textContent);
    expect(labels).toEqual(['Headquarters', 'Funding stage']);
    expect(el.textContent).toContain('Publicly traded');
  });
});

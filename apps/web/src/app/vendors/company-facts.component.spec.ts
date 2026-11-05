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

function render(facts: CompanyFactsData): HTMLElement {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(CompanyFacts);
  fixture.componentRef.setInput('facts', facts);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('CompanyFacts', () => {
  it('renders nothing, and no "Unknown", when no fact shows', () => {
    const el = render(NONE);
    expect(el.querySelector('section')).toBeNull();
    expect(el.textContent).not.toContain('Unknown');
    expect(el.classList.contains('hidden')).toBe(true);
  });

  it('shows an AECi fact with its date and source link', () => {
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
    expect(el.querySelector('dt')!.textContent).toContain('Employees');
    expect(el.textContent).toContain('201–1,000');
    expect(el.textContent).toContain('Set by AEC Integrations on Nov 4, 2026');
    const link = el.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://acme.example/about');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(link.getAttribute('target')).toBe('_blank');
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
    expect(el.textContent).toContain('Set by the vendor');
    expect(el.textContent).not.toContain(' on ');
    expect(el.querySelector('a')).toBeNull();
  });

  it('renders only the facts it is given, in a fixed order', () => {
    const source = { set_by: 'aeci', date: null, url: null } as const;
    const el = render({
      ...NONE,
      funding_stage: { value: 'Public', source },
      headquarters: { value: 'Oslo', source },
    });
    const labels = [...el.querySelectorAll('dt')].map((d) => d.textContent);
    expect(labels).toEqual(['Headquarters', 'Funding stage']);
    expect(el.textContent).toContain('Publicly traded');
  });
});

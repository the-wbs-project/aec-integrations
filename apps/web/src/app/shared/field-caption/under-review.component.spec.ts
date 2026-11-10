/**
 * AECI-1238 (§11d.7): the under-review marker, and the pages that put it in a hidden
 * value's slot. The load-bearing assertions: the exact words, which never call the value
 * false, and that a hidden field renders the marker although its value is `null`.
 */
import { LOCALE_ID, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { CompanyFacts as CompanyFactsData } from '@aeci/shared';

import { CompanyFacts } from '../../vendors/company-facts';

import { UnderReviewMarker } from './under-review';

const WORDS = 'Under review. AEC Integrations is checking this detail.';

function text(el: Element | null): string | null {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
}

function configure() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: LOCALE_ID, useValue: 'en-US' }],
  });
}

describe('UnderReviewMarker (AECI-1238)', () => {
  it('says AECi is checking the detail, in those words', () => {
    configure();
    const fixture = TestBed.createComponent(UnderReviewMarker);
    fixture.detectChanges();
    expect(text(fixture.nativeElement.querySelector('[data-testid="field-under-review"]'))).toBe(
      WORDS,
    );
  });

  it('names the field when it cannot sit in the value slot', () => {
    configure();
    const fixture = TestBed.createComponent(UnderReviewMarker);
    fixture.componentRef.setInput('label', 'Website');
    fixture.detectChanges();
    expect(text(fixture.nativeElement)).toBe(`Website: ${WORDS}`);
  });

  it('never implies the value is false', () => {
    configure();
    const fixture = TestBed.createComponent(UnderReviewMarker);
    fixture.detectChanges();
    const words = text(fixture.nativeElement)!.toLowerCase();
    for (const banned of ['false', 'wrong', 'incorrect', 'disputed', 'inaccurate']) {
      expect(words).not.toContain(banned);
    }
  });
});

describe('CompanyFacts with a fact under review (AECI-1238)', () => {
  const FACTS: CompanyFactsData = {
    headquarters: null,
    founded_year: {
      value: 1982,
      source: { set_by: 'aeci', date: '2026-09-01T00:00:00.000Z', url: null },
    },
    company_size: null,
    ownership_type: null,
    parent_company: null,
    funding_stage: null,
  };

  it('keeps the row and puts the marker in the null value slot, with no source line', () => {
    configure();
    const fixture = TestBed.createComponent(CompanyFacts);
    fixture.componentRef.setInput('facts', FACTS);
    fixture.componentRef.setInput('underReview', ['headquarters']);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const row = el.querySelector('[data-testid="company-fact-under-review-headquarters"]');
    expect(text(row)).toBe(WORDS);
    expect(text(row?.parentElement?.querySelector('dt') ?? null)).toBe('Headquarters');
    // The other fact renders as before.
    expect(el.textContent).toContain('1982');
    expect(el.querySelectorAll('[data-testid^="company-fact-under-review-"]')).toHaveLength(1);
  });

  it('renders the panel for a hidden fact even when no other fact is set', () => {
    configure();
    const fixture = TestBed.createComponent(CompanyFacts);
    fixture.componentRef.setInput('facts', { ...FACTS, founded_year: null });
    fixture.componentRef.setInput('underReview', ['funding_stage']);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="company-fact-under-review-funding"]')).not.toBeNull();
  });

  it('renders nothing new when nothing is under review', () => {
    configure();
    const fixture = TestBed.createComponent(CompanyFacts);
    fixture.componentRef.setInput('facts', FACTS);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="field-under-review"]'),
    ).toBeNull();
  });
});

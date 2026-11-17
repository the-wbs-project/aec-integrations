import { LOCALE_ID, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { FieldCaption, FieldCorrection } from '@aeci/shared';

import { Analytics } from '../../analytics/analytics';
import type { FieldCaptionPage } from '../field-caption/field-caption';

import {
  ListingProvenance,
  type ProvenanceCorrection,
  type ProvenanceGroup,
} from './listing-provenance';

const PAGE: FieldCaptionPage = {
  surface: 'product_detail',
  entityType: 'product',
  entityId: '00000000-0000-4000-8000-000000020001',
};

const caption = (form: FieldCaption['form'], date = '2026-10-04T12:00:00.000Z'): FieldCaption => ({
  form,
  vendor_names: ['Autodesk'],
  date,
});

const correction = (
  field: string,
  opts: { cleared?: boolean; source_url?: string | null; date?: string } = {},
): FieldCorrection => ({
  field,
  date: opts.date ?? '2026-09-15T08:00:00.000Z',
  source_url: opts.source_url ?? null,
  cleared: opts.cleared ?? false,
});

function setup(inputs: {
  variant?: 'card' | 'disclosure';
  maintainedBy?: 'aeci' | 'vendor';
  reviewedAt?: string | null;
  ownerName?: string | null;
  claimed?: boolean;
  groups?: readonly ProvenanceGroup[];
  corrections?: readonly ProvenanceCorrection[];
  underReviewCount?: number;
  integrationsNote?: boolean;
}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: Analytics, useValue: { externalLinkClicked: vi.fn() } },
      { provide: LOCALE_ID, useValue: 'en-US' },
    ],
  });
  const fixture = TestBed.createComponent(ListingProvenance);
  fixture.componentRef.setInput('page', PAGE);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const squash = (t: string | null | undefined) => t?.replace(/\s+/g, ' ').trim() ?? '';
  const lines = () => Array.from(el.querySelectorAll('li')).map((li) => squash(li.textContent));
  return { el, lines, squash };
}

describe('ListingProvenance (AECI-1666)', () => {
  // Ruling 2026-11-17: every listing shows the panel, including one AECi maintains alone.
  it('AECi-only shows the record line', () => {
    const { el, lines } = setup({});
    expect(el.hasAttribute('hidden')).toBe(false);
    expect(el.querySelector('section h2')?.textContent?.trim()).toBe('About this listing');
    expect(lines()).toEqual(['AEC Integrations maintained']);
  });

  it('AECi-only adds the review date when the marker has one', () => {
    const { lines } = setup({ reviewedAt: '2026-11-01T23:30:00.000Z' });
    expect(lines()).toEqual(['AEC Integrations maintained · Reviewed November 1, 2026']);
  });

  it('AECi-only shows the disclosure copy too', () => {
    const { el } = setup({ variant: 'disclosure' });
    expect(el.querySelector('details li')?.textContent).toContain('AEC Integrations maintained');
  });

  it('opens with the record line, then the groups, corrections, count and note in order', () => {
    const { lines } = setup({
      maintainedBy: 'vendor',
      reviewedAt: '2026-11-01T00:00:00.000Z',
      groups: [{ label: 'About', caption: caption('updated') }],
      corrections: [{ label: 'Website', correction: correction('website') }],
      underReviewCount: 1,
      integrationsNote: true,
    });
    expect(lines()).toEqual([
      'Vendor maintained · Updated November 1, 2026',
      'About: Maintained by Autodesk · updated October 4, 2026',
      'Website: Corrected by AEC Integrations on September 15, 2026',
      '1 value on this page is under review.',
      "Each integration's page says who maintains it.",
    ]);
  });

  it('renders the updated and until forms with their group names', () => {
    const { lines } = setup({
      groups: [
        { label: 'About', caption: caption('updated') },
        { label: 'How teams use it', caption: caption('until') },
      ],
    });
    expect(lines().slice(1)).toEqual([
      'About: Maintained by Autodesk · updated October 4, 2026',
      'How teams use it: Maintained by Autodesk until October 4, 2026',
    ]);
  });

  it('renders the bare form for an unnamed group (a one-mechanism pair)', () => {
    const { lines } = setup({ groups: [{ label: null, caption: caption('updated') }] });
    expect(lines()[1]).toBe('Maintained by Autodesk · updated October 4, 2026');
  });

  it('renders a corrected line with a source link, and one without', () => {
    const { el, lines } = setup({
      corrections: [
        {
          label: 'Website',
          correction: correction('website', { source_url: 'https://www.example.com/register' }),
        },
        { label: 'Release stage', correction: correction('maturity') },
      ],
    });
    expect(lines()[1]).toMatch(
      /^Website: Corrected by AEC Integrations on September 15, 2026 · Source/,
    );
    expect(lines()[2]).toBe('Release stage: Corrected by AEC Integrations on September 15, 2026');
    const links = el.querySelectorAll('[data-testid="field-correction-source"]');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('https://www.example.com/register');
  });

  it('renders a removal as "Removed by", labelled', () => {
    const { lines } = setup({
      corrections: [{ label: 'Trades', correction: correction('trade_slugs', { cleared: true }) }],
    });
    expect(lines()[1]).toBe('Trades: Removed by AEC Integrations on September 15, 2026');
  });

  it('pluralizes the under-review count', () => {
    expect(setup({ underReviewCount: 1 }).lines()[1]).toBe('1 value on this page is under review.');
    expect(setup({ underReviewCount: 3 }).lines()[1]).toBe(
      '3 values on this page are under review.',
    );
  });

  // Ruling 3: an unclaimed listing never reads "Vendor maintained".
  it('forces the AECi record line on an unclaimed listing, alone or with other lines', () => {
    const alone = setup({
      maintainedBy: 'vendor',
      reviewedAt: '2026-11-01T00:00:00.000Z',
      claimed: false,
    });
    expect(alone.el.hasAttribute('hidden')).toBe(false);
    expect(alone.lines()).toEqual(['AEC Integrations maintained']);
    const withLines = setup({
      maintainedBy: 'vendor',
      reviewedAt: '2026-11-01T00:00:00.000Z',
      claimed: false,
      corrections: [{ label: 'Website', correction: correction('website') }],
    });
    expect(withLines.lines()[0]).toBe('AEC Integrations maintained');
    expect(withLines.el.textContent).not.toContain('Vendor maintained');
  });

  it('shows the panel for a vendor-maintained record with nothing else', () => {
    const { el, lines } = setup({ maintainedBy: 'vendor' });
    expect(el.hasAttribute('hidden')).toBe(false);
    expect(lines()).toEqual(['Vendor maintained']);
  });

  // Visitor-neutral: the SSR Worker runs in UTC, so a local format would render two dates
  // either side of midnight and trip a hydration mismatch.
  it('formats every date in UTC', () => {
    const { lines } = setup({
      maintainedBy: 'vendor',
      reviewedAt: '2026-11-01T23:30:00.000Z',
      groups: [{ label: 'About', caption: caption('updated', '2026-10-04T23:30:00.000Z') }],
      corrections: [
        { label: 'Website', correction: correction('website', { date: '2026-09-15T23:59:00Z' }) },
      ],
    });
    expect(lines()[0]).toContain('November 1, 2026');
    expect(lines()[1]).toContain('October 4, 2026');
    expect(lines()[2]).toContain('September 15, 2026');
  });

  it('draws a card with an overline heading, visible from lg only', () => {
    const { el } = setup({ maintainedBy: 'vendor' });
    expect(el.className).toContain('hidden');
    expect(el.className).toContain('lg:block');
    const heading = el.querySelector('h2');
    expect(heading?.textContent?.trim()).toBe('About this listing');
    expect(heading?.className).toContain('aec-overline');
    expect(el.querySelector('section')?.getAttribute('aria-labelledby')).toBe(heading?.id);
    expect(el.querySelector('details')).toBeNull();
  });

  it('draws a closed native disclosure below lg, with no id to collide with the card', () => {
    const { el } = setup({ variant: 'disclosure', maintainedBy: 'vendor' });
    expect(el.className).toContain('lg:hidden');
    const details = el.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.hasAttribute('open')).toBe(false);
    expect(el.querySelector('summary')?.textContent?.trim()).toBe('About this listing');
    expect(el.querySelector('[id]')).toBeNull();
    // The lines are in the HTML while closed, so a crawler reads them.
    expect(el.querySelector('details li')?.textContent).toContain('Vendor maintained');
  });

  it('has no badge shape on any line', () => {
    const { el } = setup({
      maintainedBy: 'vendor',
      groups: [{ label: 'About', caption: caption('updated') }],
    });
    for (const li of Array.from(el.querySelectorAll('li'))) {
      const inner = li.firstElementChild?.firstElementChild ?? li;
      expect(inner.className).not.toMatch(/\bborder\b|\bbg-|rounded/);
    }
  });
});

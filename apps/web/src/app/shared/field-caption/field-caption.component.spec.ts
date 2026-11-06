import { LOCALE_ID, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { FieldCaption, FieldCorrection } from '@aeci/shared';

import { Analytics } from '../../analytics/analytics';

import { FieldCaptionLine, type FieldCaptionPage } from './field-caption';

const PAGE: FieldCaptionPage = {
  surface: 'product_detail',
  entityType: 'product',
  entityId: '00000000-0000-4000-8000-000000020001',
};

const UPDATED: FieldCaption = {
  form: 'updated',
  vendor_names: ['Autodesk'],
  date: '2026-10-04T12:00:00.000Z',
};

const CORRECTION: FieldCorrection = {
  field: 'website',
  date: '2026-09-15T08:00:00.000Z',
  source_url: 'https://www.example.com/register',
};

function setup(inputs: {
  caption?: FieldCaption | null;
  correction?: FieldCorrection | null;
  label?: string | null;
}) {
  const analytics = { externalLinkClicked: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: Analytics, useValue: analytics },
      { provide: LOCALE_ID, useValue: 'en-US' },
    ],
  });
  const fixture = TestBed.createComponent(FieldCaptionLine);
  fixture.componentRef.setInput('page', PAGE);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const text = (id: string) =>
    el.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  return { el, text, analytics };
}

describe('FieldCaptionLine (AECI-1614)', () => {
  it('renders the updated form with the exact words', () => {
    const { text } = setup({ caption: UPDATED });
    expect(text('field-caption')).toBe('Maintained by Autodesk · updated October 4, 2026');
  });

  it('renders the until form with the exact words', () => {
    const { text } = setup({ caption: { ...UPDATED, form: 'until' } });
    expect(text('field-caption')).toBe('Maintained by Autodesk until October 4, 2026');
  });

  it('joins two vendors with "and", in the order the API sent', () => {
    const { text } = setup({ caption: { ...UPDATED, vendor_names: ['Autodesk', 'Procore'] } });
    expect(text('field-caption')).toBe(
      'Maintained by Autodesk and Procore · updated October 4, 2026',
    );
  });

  it('renders the corrected form, then a source link', () => {
    const { el, text } = setup({ correction: CORRECTION });
    expect(text('field-correction')).toContain(
      'Corrected by AEC Integrations on September 15, 2026',
    );
    const link = el.querySelector<HTMLAnchorElement>('[data-testid="field-correction-source"]');
    expect(link?.getAttribute('href')).toBe(CORRECTION.source_url);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    // The name starts with the visible text, says what it is, and announces the new tab.
    expect(link?.textContent?.replace(/\s+/g, ' ').trim()).toMatch(/^Source for this correction/);
    expect(link?.querySelector('aec-new-tab-icon')).not.toBeNull();
  });

  it('renders the date alone on a correction with no source', () => {
    const { el, text } = setup({ correction: { ...CORRECTION, source_url: null } });
    expect(text('field-correction')).toBe('Corrected by AEC Integrations on September 15, 2026');
    expect(el.querySelector('a')).toBeNull();
  });

  it.each(['http://www.example.com/a', 'javascript:alert(1)', 'not a url'])(
    'renders no link for a stored source of %s',
    (source_url) => {
      const { el, text } = setup({ correction: { ...CORRECTION, source_url } });
      expect(el.querySelector('a')).toBeNull();
      expect(text('field-correction')).toBe('Corrected by AEC Integrations on September 15, 2026');
    },
  );

  it('names the field when a label is given', () => {
    const { text } = setup({ correction: { ...CORRECTION, source_url: null }, label: 'Website' });
    expect(text('field-correction')).toBe(
      'Website: Corrected by AEC Integrations on September 15, 2026',
    );
  });

  it('formats in UTC, so an instant near midnight and a date-only string do not shift', () => {
    expect(
      setup({ caption: { ...UPDATED, date: '2026-10-04T23:59:59.000Z' } }).text('field-caption'),
    ).toContain('October 4, 2026');
    expect(
      setup({ caption: { ...UPDATED, date: '2026-10-05T00:00:00.000Z' } }).text('field-caption'),
    ).toContain('October 5, 2026');
    expect(setup({ caption: { ...UPDATED, date: '2026-10-04' } }).text('field-caption')).toContain(
      'October 4, 2026',
    );
  });

  it.each([
    ['null inputs', { caption: null, correction: null }],
    ['absent inputs', {}],
    ['an unparseable caption date', { caption: { ...UPDATED, date: 'soon' } }],
    ['an unparseable correction date', { correction: { ...CORRECTION, date: 'soon' } }],
  ])('renders nothing and hides the host for %s', (_name, inputs) => {
    const { el } = setup(inputs);
    expect(el.textContent?.trim()).toBe('');
    expect(el.hidden).toBe(true);
  });

  it('reports a source click as AECi origin with no owner', () => {
    const { el, analytics } = setup({ correction: CORRECTION });
    el.addEventListener('click', (e) => e.preventDefault());
    el.querySelector('a')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(analytics.externalLinkClicked).toHaveBeenCalledWith({
      destination: CORRECTION.source_url,
      source: 'product_detail',
      owner_vendor_id: null,
      link_origin: 'aeci',
      source_entity_type: 'product',
      source_entity_id: PAGE.entityId,
      link_purpose: 'source',
    });
  });

  it('has no badge shape: no fill, border or radius on the line', () => {
    const { el } = setup({ caption: UPDATED });
    const line = el.querySelector('[data-testid="field-caption"]')!;
    expect(line.className).not.toMatch(/\b(bg-|border|rounded)/);
    expect(line.className).toContain('text-(--text-secondary)');
  });
});

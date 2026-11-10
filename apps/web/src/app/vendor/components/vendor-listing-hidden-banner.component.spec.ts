/**
 * AECI-1238 — `VendorListingHiddenBanner` (§11d.6): the date, AECi's vendor reason,
 * that the portal still works, and the §11d.4 dispute route as a mailto link.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { VendorListingHiddenBanner } from './vendor-listing-hidden-banner';

describe('VendorListingHiddenBanner', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  function render() {
    const fixture = TestBed.createComponent(VendorListingHiddenBanner);
    fixture.componentRef.setInput('hidden', {
      at: '2026-11-09T15:30:00.000Z',
      kind: 'complaint_under_review',
      reason: 'A complaint names this listing.',
    });
    fixture.componentRef.setInput('headingId', 'test-hidden-h');
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('heads with the date AECi hid the listing, labelled by its heading', () => {
    const el = render();
    const heading = el.querySelector('h2');
    expect(heading?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Hidden from the public site by AEC Integrations on November 9, 2026',
    );
    expect(heading?.id).toBe('test-hidden-h');
    expect(el.querySelector('section')?.getAttribute('aria-labelledby')).toBe('test-hidden-h');
  });

  it('shows the reason, says the portal still works, and links the dispute email', () => {
    const el = render();
    expect(el.querySelector('[data-testid="listing-hidden-reason"]')?.textContent?.trim()).toBe(
      'Reason: A complaint names this listing.',
    );
    const text = el.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain(
      'Your portal still works and your edits still save. To dispute this, email support@aecintegrations.com and quote this message.',
    );
    const link = el.querySelector('a');
    expect(link?.getAttribute('href')).toBe('mailto:support@aecintegrations.com');
    // Not an alert: it is present from first paint and states the current state.
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });
});

/**
 * AECI-1237 (§11d.5): the portal note under a field AECi corrected and locked. It says
 * who set the value, gives the reason, the source and the dispute route. Since
 * AECI-1668 a vendor that does not hold the lock gets no reason, so its note keeps the
 * source and drops the reason and the dispute line.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { LockedField } from '@aeci/shared';

import { VendorLockedNote } from './vendor-locked-note';

const LOCK: LockedField = {
  field: 'docs_url',
  reason: 'The published docs moved to a new address.',
  set_at: '2026-11-09T12:00:00.000Z',
  source_url: 'https://example.com/docs',
};

function render(lock: LockedField) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(VendorLockedNote);
  fixture.componentRef.setInput('lock', lock);
  fixture.componentRef.setInput('noteId', 'row-docs-locked');
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const words = (el: HTMLElement) =>
  el.querySelector('[data-testid="locked-note"]')!.textContent!.replace(/\s+/g, ' ').trim();

describe('VendorLockedNote', () => {
  it('gives the holder who set it, the reason and the dispute route', () => {
    const el = render(LOCK);
    expect(el.querySelector('[data-testid="locked-note"]')!.id).toBe('row-docs-locked');
    const text = words(el);
    expect(text).toContain('Set by AEC Integrations.');
    expect(text).toContain(`Reason: ${LOCK.reason}`);
    expect(text).toContain(
      'To dispute it, email support@aecintegrations.com and quote this reason.',
    );
  });

  it('links the source in a new tab', () => {
    const link = render(LOCK).querySelector<HTMLAnchorElement>(
      '[data-testid="locked-note-source"]',
    )!;
    expect(link.href).toBe(LOCK.source_url);
    expect(link.target).toBe('_blank');
  });

  it('gives a vendor that does not hold the lock the source, no reason and no dispute line (AECI-1668)', () => {
    const el = render({ ...LOCK, reason: null });
    const text = words(el);
    expect(text).toContain('Set by AEC Integrations.');
    expect(text).not.toContain('Reason:');
    expect(text).not.toContain('To dispute it');
    expect(el.querySelector<HTMLAnchorElement>('[data-testid="locked-note-source"]')!.href).toBe(
      LOCK.source_url,
    );
  });

  it('omits the link when the lock has no source', () => {
    const el = render({ ...LOCK, source_url: null });
    expect(el.querySelector('[data-testid="locked-note-source"]')).toBeNull();
  });
});

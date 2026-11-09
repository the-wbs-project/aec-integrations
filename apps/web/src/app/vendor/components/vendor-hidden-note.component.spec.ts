/**
 * AECI-1238 (§11d.7): the portal note under a field AECi hid while it checks it. It says
 * the field stays editable and a save ends the hide, gives the reason, the source and the
 * dispute route, and never the internal note (which is never on the wire).
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { HiddenField } from '@aeci/shared';

import { VendorHiddenNote } from './vendor-hidden-note';

const HIDE: HiddenField = {
  field: 'website',
  reason: 'A reader sent a page that shows a different address.',
  set_at: '2026-11-09T12:00:00.000Z',
  source_url: 'https://example.com/notice',
};

function render(hide: HiddenField) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(VendorHiddenNote);
  fixture.componentRef.setInput('hide', hide);
  fixture.componentRef.setInput('noteId', 'profile-website-hidden');
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('VendorHiddenNote (AECI-1238)', () => {
  it('says what the hide does, the reason and the dispute route', () => {
    const el = render(HIDE);
    const note = el.querySelector('[data-testid="hidden-note"]')!;
    expect(note.id).toBe('profile-website-hidden');
    const words = note.textContent!.replace(/\s+/g, ' ').trim();
    expect(words).toContain(
      'Hidden from your public page while AEC Integrations checks it. Saving a change to this field ends the hide.',
    );
    expect(words).toContain(`Reason: ${HIDE.reason}`);
    expect(words).toContain(
      'To dispute it, email support@aecintegrations.com and quote this message.',
    );
  });

  it('links the source in a new tab', () => {
    const link = render(HIDE).querySelector<HTMLAnchorElement>(
      '[data-testid="hidden-note-source"]',
    )!;
    expect(link.href).toBe(HIDE.source_url);
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener nofollow');
  });

  it('drops a source that is not https', () => {
    const el = render({ ...HIDE, source_url: 'javascript:alert(1)' });
    expect(el.querySelector('[data-testid="hidden-note-source"]')).toBeNull();
  });
});

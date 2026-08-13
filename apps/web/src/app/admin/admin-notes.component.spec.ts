/**
 * AECI-577 — `AdminNotes`: the honesty envelope's codes rendered as prose.
 *
 * The point of the component is that the API's untranslated `message` never
 * reaches the screen (§9.4 — every string is `$localize`d, admin-only or not) and
 * that a code always produces a sentence. Both are asserted here, the second
 * exhaustively: `AdminNoteCodeSchema` is a closed enum, so iterating it catches a
 * code that gains an API implementation but no UI string.
 */
import { AdminNoteCodeSchema, type AdminNote } from '@aeci/shared';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { AdminNotes } from './admin-notes';

function render(notes: AdminNote[]) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(AdminNotes);
  fixture.componentRef.setInput('notes', notes);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const note = (over: Partial<AdminNote> & Pick<AdminNote, 'code'>): AdminNote => ({
  severity: 'info',
  message: 'UNTRANSLATED OPERATOR FALLBACK',
  ...over,
});

describe('AdminNotes', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders nothing when there are no notes', () => {
    expect(render([]).querySelector('ul')).toBeNull();
  });

  it('interpolates params into the localized sentence', () => {
    const el = render([
      note({ code: 'bot_classification_incomplete', severity: 'warn', params: { rows: 17784 } }),
    ]);
    expect(el.textContent).toContain('17784');
    expect(el.textContent).toContain('counted as human');
  });

  it('never renders the API message — that string is for curl and logs', () => {
    const el = render([note({ code: 'direct_is_mixed_bucket' })]);
    expect(el.textContent).not.toContain('UNTRANSLATED OPERATOR FALLBACK');
    expect(el.textContent).toContain('Direct mixes true direct arrivals');
  });

  it('has a sentence for every code in the shared enum', () => {
    for (const code of AdminNoteCodeSchema.options) {
      const el = render([note({ code, params: { rows: 1, day: '2026-08-10', asns: '23700' } })]);
      expect(el.textContent?.trim().length, `no prose for "${code}"`).toBeGreaterThan(10);
    }
  });

  it('puts warnings above info — they change how a number should be read', () => {
    const el = render([
      note({ code: 'direct_is_mixed_bucket', severity: 'info' }),
      note({ code: 'referrer_source_incomplete', severity: 'warn', params: { rows: 3 } }),
    ]);
    const items = [...el.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(items[0]).toContain('no recorded source');
  });

  it('names the list for assistive technology', () => {
    const el = render([note({ code: 'requires_recompute' })]);
    expect(el.querySelector('ul')?.getAttribute('aria-label')).toBeTruthy();
  });
});

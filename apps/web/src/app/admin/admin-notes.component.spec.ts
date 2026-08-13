/**
 * AECI-579 — `AdminNotes`, the shared renderer for the panel's honesty envelope.
 *
 * The API ships `code` + `params` and leaves `message` untranslated on purpose,
 * so this component is the ONLY place the operator-facing prose exists. Two
 * things are therefore worth pinning: that every `AdminNoteCode` produces real
 * localized text (a missing case would render the raw code, or nothing), and that
 * the params actually reach the string — a note that says "of product(s)" with
 * the numbers dropped is worse than no note.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { AdminNoteCodeSchema, type AdminNote, type AdminNoteCode } from '@aeci/shared';

import { AdminNotes } from './admin-notes';

function render(notes: AdminNote[]): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(AdminNotes);
  fixture.componentRef.setInput('notes', notes);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const note = (
  code: AdminNoteCode,
  params?: Record<string, string | number>,
  severity: AdminNote['severity'] = 'info',
): AdminNote => ({
  code,
  severity,
  message: `untranslated ${code}`,
  ...(params ? { params } : {}),
});

/** Params every code might read, so the exhaustive sweep never renders a blank. */
const ALL_PARAMS = {
  rows: 7,
  earliest_day: '2026-06-26',
  asns: '23700',
  promoted: 171,
  untagged: 171,
  universe: 171,
};

describe('AdminNotes', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders nothing at all when there are no notes', () => {
    const el = render([]);
    expect(el.querySelector('ul')).toBeNull();
    expect(el.textContent?.trim()).toBe('');
  });

  it('produces localized prose for EVERY note code in the vocabulary', () => {
    // Sweeps the Zod enum rather than a hand-copied list, so a code added to the
    // API without a string here fails the suite as well as the compiler.
    for (const code of AdminNoteCodeSchema.options) {
      const el = render([note(code, ALL_PARAMS)]);
      const text = el.querySelector('li')?.textContent?.trim() ?? '';
      expect(text.length, `${code} rendered nothing`).toBeGreaterThan(10);
      // Never leak the machine-readable code or the untranslated fallback.
      expect(text, `${code} leaked its code`).not.toContain(code);
      expect(text, `${code} leaked its untranslated message`).not.toContain('untranslated');
    }
  });

  it('interpolates params into the text', () => {
    const el = render([note('api_docs_flag_inconsistent', { rows: 42 }, 'warn')]);
    expect(el.textContent).toContain('42');
  });

  it('names the severity for screen readers rather than relying on colour alone', () => {
    const warn = render([note('funnel_is_promoted_cohort_only', { promoted: 3 }, 'warn')]);
    expect(warn.querySelector('.sr-only')?.textContent).toContain('Caveat');

    const info = render([note('partial_day', undefined, 'info')]);
    expect(info.querySelector('.sr-only')?.textContent).toContain('Note');
  });

  it('renders one list item per note', () => {
    const el = render([
      note('partial_day'),
      note('trade_facet_sparse_by_design', { untagged: 171, universe: 171 }),
    ]);
    expect(el.querySelectorAll('li')).toHaveLength(2);
  });
});

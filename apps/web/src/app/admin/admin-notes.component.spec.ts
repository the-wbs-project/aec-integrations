/**
 * AECI-576 / Phase 8.3 P1.2 — `AdminNotes`.
 *
 * The contract worth protecting here is the one §1.1 / §9.4 of
 * `docs/ADMIN_PANEL_SPEC.md` set up together: the API's `code` + `params` are the
 * contract, its `message` is an untranslated operator fallback, and the UI renders
 * localized prose from the code. So the load-bearing assertion is that **every
 * code produces prose and no response's `message` ever reaches the DOM** — if a
 * new code were ever added without a UI string, the map would fail to compile,
 * but a regression that started echoing `message` would otherwise look fine.
 */
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { AdminNote, AdminNoteCode } from '@aeci/shared';

import { AdminNotes } from './admin-notes';

/** Every code in the shared enum, with the params the API actually sends for it. */
const ALL_CODES: ReadonlyArray<{ code: AdminNoteCode; params?: AdminNote['params'] }> = [
  { code: 'partial_day', params: { day: '2026-08-13' } },
  {
    code: 'bot_classification_incomplete',
    params: { rows: 42, window_from: '2026-08-12', window_to: '2026-08-13' },
  },
  { code: 'referrer_source_incomplete', params: { rows: 7 } },
  { code: 'direct_is_mixed_bucket' },
  { code: 'visitor_definition_approximate' },
  { code: 'catalog_series_is_additions_only', params: { metric: 'catalog.products_created' } },
  { code: 'catalog_series_starts_at', params: { earliest_day: '2026-05-01' } },
  { code: 'internal_filter_unavailable' },
  { code: 'internal_filter_applied', params: { asns: '23700' } },
  { code: 'requires_recompute' },
  { code: 'algolia_credentials_absent' },
];

const OPERATOR_FALLBACK = 'UNTRANSLATED OPERATOR MESSAGE';

function makeNote(over: Partial<AdminNote> & { code: AdminNoteCode }): AdminNote {
  return {
    code: over.code,
    severity: over.severity ?? 'info',
    message: over.message ?? OPERATOR_FALLBACK,
    ...(over.params ? { params: over.params } : {}),
  };
}

function render(notes: readonly AdminNote[]): HTMLElement {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(AdminNotes);
  fixture.componentRef.setInput('notes', notes);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('AdminNotes', () => {
  it('renders nothing at all when there are no notes', () => {
    const el = render([]);
    expect(el.querySelector('ul')).toBeNull();
    expect(el.textContent?.trim()).toBe('');
  });

  it('renders localized prose for every note code and never the wire `message`', () => {
    const el = render(
      ALL_CODES.map(({ code, params }) => makeNote({ code, ...(params ? { params } : {}) })),
    );

    const items = el.querySelectorAll('li');
    expect(items).toHaveLength(ALL_CODES.length);
    expect(el.textContent).not.toContain(OPERATOR_FALLBACK);
    for (const li of items) {
      // Each row is a severity chip plus real prose — never an empty cell.
      expect(li.textContent?.trim().length ?? 0).toBeGreaterThan(10);
    }
  });

  it('interpolates note params into the prose', () => {
    const el = render([
      makeNote({
        code: 'bot_classification_incomplete',
        severity: 'warn',
        params: { rows: 42, window_from: '2026-08-12', window_to: '2026-08-13' },
      }),
    ]);
    expect(el.textContent).toContain('42');
  });

  it('substitutes a placeholder rather than "undefined" when a param is missing', () => {
    const el = render([makeNote({ code: 'partial_day' })]);
    expect(el.textContent).not.toContain('undefined');
  });

  it('distinguishes warn from info without relying on color alone', () => {
    const el = render([
      makeNote({ code: 'requires_recompute', severity: 'info' }),
      makeNote({ code: 'bot_classification_incomplete', severity: 'warn', params: { rows: 1 } }),
    ]);
    const chips = [...el.querySelectorAll('li span:first-child')].map((s) => s.textContent?.trim());
    expect(chips).toEqual(['Note', 'Caveat']);
  });

  it('keeps duplicate codes distinct instead of collapsing them', () => {
    const el = render([
      makeNote({ code: 'referrer_source_incomplete', params: { rows: 1 } }),
      makeNote({ code: 'referrer_source_incomplete', params: { rows: 2 } }),
    ]);
    expect(el.querySelectorAll('li')).toHaveLength(2);
  });

  describe('accessibility (structural)', () => {
    it('is a named list, adds no headings, and introduces no nested landmark', () => {
      const el = render([makeNote({ code: 'requires_recompute' })]);
      const list = el.querySelector('ul[role="list"]');
      expect(list?.getAttribute('aria-label')).toBeTruthy();
      expect(el.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
      // An <aside> here nests a `complementary` landmark inside <main>, which
      // axe flags (landmark-complementary-is-top-level). The list carries the
      // accessible name instead.
      expect(el.querySelector('aside, section, nav')).toBeNull();
    });
  });
});

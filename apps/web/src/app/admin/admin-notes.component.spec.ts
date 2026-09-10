/**
 * AECI-576 / Phase 8.3 P1.2 — `AdminNotes` (extended by AECI-579 / P1.5).
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

import { AdminNoteCodeSchema, type AdminNote, type AdminNoteCode } from '@aeci/shared';

import { AdminNotes } from './admin-notes';

/**
 * The params the API actually sends, per code. Codes that send none are absent.
 *
 * AECI-752 — this used to be a hand-written list of codes that CLAIMED to be
 * "every code in the shared enum" and was eleven short, so the test below passed
 * while never rendering `automation_filter_applied`, `operator_leak_is_an_inference`,
 * the audience pair or any of the four connector codes. Deriving the list from
 * `AdminNoteCodeSchema.options` makes that impossible: a code added to the enum
 * is rendered here whether or not anyone remembers to add it. `NOTE_PROSE` being
 * an exhaustive `Record` already forces a *string* to exist; this forces it to
 * actually be exercised.
 */
const PARAMS_BY_CODE: Partial<Record<AdminNoteCode, AdminNote['params']>> = {
  partial_day: { day: '2026-08-13' },
  bot_classification_incomplete: { rows: 42, window_from: '2026-08-12', window_to: '2026-08-13' },
  referrer_source_incomplete: { rows: 7 },
  automation_filter_applied: { flagged: 163 },
  catalog_series_is_additions_only: { metric: 'catalog.products_created' },
  catalog_series_starts_at: { earliest_day: '2026-05-01' },
  internal_filter_applied: { asns: '23700' },
  // AECI-579 / P1.5 — catalog coverage.
  funnel_is_promoted_cohort_only: { promoted: 171 },
  trade_facet_sparse_by_design: { untagged: 171, universe: 171 },
  api_docs_flag_inconsistent: { rows: 3 },
  // AECI-581 / P2.1.
  series_partly_reconstructed: { reconstructed_days: 4, reconstructed_through: '2026-08-05' },
  // AECI-580 / P1.6 — system status.
  cron_liveness_unavailable: { unknown: 2, total: 14 },
  stored_result_unreadable: { job: 'algolia-drift' },
  // AECI-586 / P5.1 — audience.
  utm_attribution_incomplete: { missing: 12, total: 40 },
  // AECI-722 — the connector surface.
  stub_actions_never_fetched: { never_fetched: 90, total: 120 },
};

const ALL_CODES: ReadonlyArray<{ code: AdminNoteCode; params?: AdminNote['params'] }> =
  AdminNoteCodeSchema.options.map((code) => {
    const params = PARAMS_BY_CODE[code];
    return params ? { code, params } : { code };
  });

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

  // AECI-752. The two internal-filter notes speak for `ANALYTICS_INTERNAL_ASNS`
  // and must not be readable as a claim about the screen. The old strings said
  // "every figure here is unfiltered" and "the unfiltered figure is always the
  // primary one", which sat directly above a headline the automation filter had
  // already reduced (AECI-745) and the operator-leak match had trimmed (AECI-683).
  //
  // Asserting the ABSENCE of the old phrasing is the point: any replacement that
  // generalises the same way trips this, whereas a positive assertion on the new
  // sentence would only pin today's wording.
  it('scopes the internal-filter notes to the ASN axis, never to every figure', () => {
    const el = render([
      makeNote({ code: 'internal_filter_unavailable' }),
      makeNote({ code: 'internal_filter_applied', params: { asns: '23700' } }),
    ]);
    const text = el.textContent ?? '';

    expect(text).not.toContain('every figure');
    expect(text).not.toContain('unfiltered');
    // And it must not explain WHY no exclusion ran. `internal_filter_unavailable`
    // also fires when the var IS set and the request simply did not ask, which
    // `/admin/catalog` reaches through `GET /api/admin/metrics/timeseries`.
    expect(text).not.toContain('not configured');
    // Each still names the thing it is actually about.
    expect(text).toContain('ASN');
    expect(text).toContain('company-network');
    // And the applied note still carries §13 D10 constraint 2, re-scoped: the
    // figure INCLUDING those networks stays primary. Dropping that claim would
    // be the opposite failure.
    expect(text).toContain('23700');
    expect(text).toContain('primary');
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

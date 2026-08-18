/**
 * AECI-577 / Phase 8.3 P1.3 — `ActivityFeed` logic + structural a11y.
 *
 * The live axe pass runs in Playwright / static-serve on rendered routes (the
 * repo's component-level a11y convention — cf. `request-queue.component.spec.ts`).
 * Here we assert the feed's behaviour (SSR-neutral first paint, the
 * `afterNextRender` fetch and its derived window, day grouping, the six filters'
 * round trips, pagination, error and empty states) and the two honesty
 * invariants that are easy to regress: **both traffic figures are rendered
 * whenever they exist**, and a NULL `referrer_source` reads as *unknown* rather
 * than *Direct*.
 *
 * Harness mirrors `request-queue.component.spec.ts`: zoneless + a macrotask
 * `settle()` to drain `afterNextRender`'s async load.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminPageViewRow,
  AdminPageViewsResponse,
  AdminTrafficBreakdownResponse,
} from '@aeci/shared';

import { AecSelect } from '../../shared/aec-select/aec-select';
import { ActivityFeed } from './activity-feed';
import { AdminPageViewsApi } from './admin-page-views-api';

/** Matches the component's `PATH_DEBOUNCE_MS`, plus slack. */
const AFTER_DEBOUNCE_MS = 420;

function makeRow(over: Partial<AdminPageViewRow> & { id: number }): AdminPageViewRow {
  return {
    id: over.id,
    created_at: over.created_at ?? '2026-08-10T09:00:00.000Z',
    is_bot: 'is_bot' in over ? (over.is_bot ?? null) : false,
    bot_name: over.bot_name ?? null,
    visitor_hash: 'visitor_hash' in over ? (over.visitor_hash ?? null) : '365d59e9',
    cf_asn: 'cf_asn' in over ? (over.cf_asn ?? null) : 23700,
    cf_country: 'cf_country' in over ? (over.cf_country ?? null) : 'ID',
    cf_colo: 'cf_colo' in over ? (over.cf_colo ?? null) : 'CGK',
    path: over.path ?? '/',
    entity_type: over.entity_type ?? null,
    entity: over.entity ?? null,
    referrer_source: 'referrer_source' in over ? (over.referrer_source ?? null) : 'Direct',
    referrer: over.referrer ?? null,
  };
}

function makeResponse(
  rows: AdminPageViewRow[],
  over: Partial<AdminPageViewsResponse> = {},
): AdminPageViewsResponse {
  return {
    data: rows,
    page: 1,
    perPage: 50,
    total: rows.length,
    traffic: 'human',
    window: {
      from: '2026-08-04T00:00:00.000Z',
      to: '2026-08-11T00:00:00.000Z',
      timezone: 'UTC',
      days: 7,
    },
    generated_at: '2026-08-10T12:00:00.000Z',
    source: 'live',
    notes: [],
    internal_filter: { available: false, applied: false, asns: [] },
    window_total: { total: rows.length, excluding_internal: null },
    window_visitors: { total: rows.length, excluding_internal: null },
    ...over,
  };
}

const EMPTY_BREAKDOWN: AdminTrafficBreakdownResponse = {
  data: [],
  page: 1,
  perPage: 100,
  total: 0,
  dimension: 'source',
  traffic: 'all',
  window: {
    from: '2026-08-04T00:00:00.000Z',
    to: '2026-08-11T00:00:00.000Z',
    timezone: 'UTC',
    days: 7,
  },
  generated_at: '2026-08-10T12:00:00.000Z',
  source: 'live',
  notes: [],
  internal_filter: { available: false, applied: false, asns: [] },
  window_total: { total: 0, excluding_internal: null },
};

interface ApiMock {
  listPageViews: ReturnType<typeof vi.fn>;
  listFilterOptions: ReturnType<typeof vi.fn>;
}

function makeApiMock(response: AdminPageViewsResponse): ApiMock {
  return {
    listPageViews: vi.fn(async () => structuredClone(response)),
    listFilterOptions: vi.fn(async (dimension: 'source' | 'country') =>
      structuredClone({ ...EMPTY_BREAKDOWN, dimension }),
    ),
  };
}

function settle(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configure(api: ApiMock) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminPageViewsApi, useValue: api },
    ],
  });
  return TestBed.createComponent(ActivityFeed);
}

async function setup(api: ApiMock) {
  const fixture = configure(api);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

/** Re-render after an interaction that triggers a refetch. */
async function drain(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
}

function group(el: HTMLElement, labelId: string): HTMLElement {
  const found = el.querySelector(`[aria-labelledby="${labelId}"]`);
  if (!found) throw new Error(`No group labelled by "${labelId}"`);
  return found as HTMLElement;
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn as HTMLButtonElement;
}

const lastQuery = (api: ApiMock) => api.listPageViews.mock.calls.at(-1)?.[0];

describe('ActivityFeed', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  describe('first paint and load', () => {
    it('fetches nothing until a render has happened, and paints a skeleton until it lands', async () => {
      const api = makeApiMock(makeResponse([makeRow({ id: 1 })]));
      const fixture = configure(api);
      // Construction alone must not reach the network: on the server the render
      // callback never runs, so an SSR pass issues no request and bakes no
      // visitor data into the HTML.
      expect(api.listPageViews).not.toHaveBeenCalled();

      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      // The heading is static; rows are not, and are absent until the fetch lands.
      expect(el.querySelector('h2')?.textContent).toContain('Activity');
      expect(el.querySelector('table')).toBeNull();
      expect(el.textContent).toContain('Loading the activity feed');
    });

    it('fetches in afterNextRender with a trailing 7-day UTC window', async () => {
      const { api } = await setup(makeApiMock(makeResponse([makeRow({ id: 1 })])));
      expect(api.listPageViews).toHaveBeenCalledTimes(1);
      const q = lastQuery(api);
      expect(q).toMatchObject({ traffic: 'human', page: 1, perPage: 50, exclude_internal: false });
      // Seven inclusive days ending today (UTC).
      const days =
        (Date.parse(`${q.to}T00:00:00.000Z`) - Date.parse(`${q.from}T00:00:00.000Z`)) / 86_400_000;
      expect(days).toBe(6);
      expect(q.to).toBe(new Date().toISOString().slice(0, 10));
      // No filters set → no filter params sent at all.
      expect(q.source).toBeUndefined();
      expect(q.country).toBeUndefined();
      expect(q.path_contains).toBeUndefined();
    });

    it('populates the source and country dropdowns from the breakdown endpoint', async () => {
      const { api } = await setup(makeApiMock(makeResponse([])));
      expect(api.listFilterOptions).toHaveBeenCalledTimes(2);
      expect(api.listFilterOptions.mock.calls.map((c) => c[0])).toEqual(['source', 'country']);
    });
  });

  describe('rows', () => {
    it('renders the §5.2 columns and groups rows under a UTC day separator', async () => {
      const { el } = await setup(
        makeApiMock(
          makeResponse([
            makeRow({
              id: 2,
              created_at: '2026-08-10T09:00:00.000Z',
              path: '/products/:slug',
              entity_type: 'product',
              entity: { id: 'p1', name: 'Procore', slug: 'procore' },
              referrer_source: 'Google',
              referrer: 'www.google.com',
            }),
            makeRow({ id: 1, created_at: '2026-08-09T09:00:00.000Z', path: '/' }),
          ]),
        ),
      );
      const separators = [...el.querySelectorAll('th[scope="rowgroup"]')].map((th) =>
        th.textContent?.trim(),
      );
      expect(separators).toEqual(['2026-08-10 (UTC)', '2026-08-09 (UTC)']);

      expect(el.textContent).toContain('365d59e9 · AS23700');
      expect(el.textContent).toContain('ID · CGK');
      expect(el.textContent).toContain('Google');
      expect(el.textContent).toContain('www.google.com');
      // The entity name links; the stored route pattern stays visible beside it.
      const link = el.querySelector('a[href="/products/procore"]');
      expect(link?.textContent?.trim()).toBe('Procore');
      expect(el.textContent).toContain('/products/:slug');
    });

    it('renders an exact UTC instant in the time tooltip', async () => {
      const { el } = await setup(
        makeApiMock(makeResponse([makeRow({ id: 1, created_at: '2026-08-10T09:07:00.000Z' })])),
      );
      const time = el.querySelector('time');
      expect(time?.getAttribute('datetime')).toBe('2026-08-10T09:07:00.000Z');
      expect(time?.getAttribute('title')).toBe('2026-08-10 09:07:00 UTC');
    });

    it('labels an unclassified row rather than letting it pass as human', async () => {
      const { el } = await setup(
        makeApiMock(
          makeResponse([
            makeRow({ id: 3, is_bot: true, bot_name: 'Googlebot' }),
            makeRow({ id: 2, is_bot: true, bot_name: null }),
            makeRow({ id: 1, is_bot: null }),
          ]),
        ),
      );
      expect(el.textContent).toContain('Googlebot');
      expect(el.textContent).toContain('Other bot');
      expect(el.textContent).toContain('Unclassified');
    });

    it('reads a null referrer_source as unknown, never as Direct', async () => {
      const { el } = await setup(
        makeApiMock(makeResponse([makeRow({ id: 1, referrer_source: null })])),
      );
      expect(el.textContent).toContain('Unknown');
      expect(el.textContent).not.toContain('Direct');
    });

    it('falls back to a screen-reader label when a visitor or location is unknown', async () => {
      const { el } = await setup(
        makeApiMock(
          makeResponse([
            makeRow({ id: 1, visitor_hash: null, cf_asn: null, cf_country: null, cf_colo: null }),
          ]),
        ),
      );
      expect(el.textContent).toContain('Unknown visitor');
      expect(el.textContent).toContain('Unknown location');
    });
  });

  describe('filters', () => {
    it('round-trips the traffic population and reflects it in aria-pressed', async () => {
      const { el, fixture, api } = await setup(makeApiMock(makeResponse([makeRow({ id: 1 })])));
      const g = group(el, 'admin-activity-traffic-label');
      expect(buttonByText(g, 'Humans').getAttribute('aria-pressed')).toBe('true');

      buttonByText(g, 'Bots').click();
      await drain(fixture);

      expect(lastQuery(api)).toMatchObject({ traffic: 'bot', page: 1 });
      expect(buttonByText(g, 'Bots').getAttribute('aria-pressed')).toBe('true');
      expect(buttonByText(g, 'Humans').getAttribute('aria-pressed')).toBe('false');
    });

    it('round-trips a source chosen in the select', async () => {
      const { fixture, api } = await setup(makeApiMock(makeResponse([makeRow({ id: 1 })])));
      const select = fixture.debugElement.queryAll(By.directive(AecSelect))[0];
      select.componentInstance.changed.emit('Google');
      await drain(fixture);
      expect(lastQuery(api)).toMatchObject({ source: 'Google' });
    });

    it('debounces the path filter and drops it again when cleared', async () => {
      const { el, fixture, api } = await setup(makeApiMock(makeResponse([makeRow({ id: 1 })])));
      const input = el.querySelector('#admin-activity-path') as HTMLInputElement;

      input.value = '/products';
      input.dispatchEvent(new Event('input'));
      await settle(AFTER_DEBOUNCE_MS);
      await drain(fixture);
      expect(lastQuery(api)).toMatchObject({ path_contains: '/products' });

      input.value = '';
      input.dispatchEvent(new Event('input'));
      await settle(AFTER_DEBOUNCE_MS);
      await drain(fixture);
      expect(lastQuery(api).path_contains).toBeUndefined();
    });

    it('applies a preset window and refetches both the feed and the option lists', async () => {
      const { el, fixture, api } = await setup(makeApiMock(makeResponse([makeRow({ id: 1 })])));
      buttonByText(group(el, 'admin-activity-preset-label'), '30 days').click();
      await drain(fixture);

      const q = lastQuery(api);
      const days =
        (Date.parse(`${q.to}T00:00:00.000Z`) - Date.parse(`${q.from}T00:00:00.000Z`)) / 86_400_000;
      expect(days).toBe(29);
      expect(api.listFilterOptions).toHaveBeenCalledTimes(4);
    });

    it('returns to page 1 whenever a filter changes', async () => {
      const { el, fixture, api } = await setup(
        makeApiMock(makeResponse([makeRow({ id: 1 })], { total: 120 })),
      );
      buttonByText(el, 'Next').click();
      await drain(fixture);
      expect(lastQuery(api).page).toBe(2);

      buttonByText(group(el, 'admin-activity-traffic-label'), 'All').click();
      await drain(fixture);
      expect(lastQuery(api).page).toBe(1);
    });
  });

  describe('the internal-traffic toggle (§13 D10)', () => {
    it('is hidden when ANALYTICS_INTERNAL_ASNS is unset — the shipped default', async () => {
      const { el } = await setup(makeApiMock(makeResponse([makeRow({ id: 1 })])));
      expect(el.querySelector('#admin-activity-internal')).toBeNull();
    });

    it('shows both figures with the toggle OFF, so neither number stands alone', async () => {
      const { el } = await setup(
        makeApiMock(
          makeResponse([makeRow({ id: 1 })], {
            internal_filter: { available: true, applied: false, asns: [23700] },
            window_total: { total: 1204, excluding_internal: 312 },
            window_visitors: { total: 90, excluding_internal: 41 },
          }),
        ),
      );
      const toggle = el.querySelector('#admin-activity-internal') as HTMLInputElement;
      expect(toggle).not.toBeNull();
      expect(toggle.checked).toBe(false);
      expect(el.textContent).toContain('Filter out internal traffic (AS23700)');
      // The unfiltered figures are primary; the filtered ones sit beside them.
      expect(el.textContent).toContain('1204');
      expect(el.textContent).toContain('312 excluding internal traffic');
      expect(el.textContent).toContain('41 excluding internal traffic');
    });

    it('sends exclude_internal when switched on', async () => {
      const { el, fixture, api } = await setup(
        makeApiMock(
          makeResponse([makeRow({ id: 1 })], {
            internal_filter: { available: true, applied: false, asns: [23700] },
            window_total: { total: 4, excluding_internal: 2 },
          }),
        ),
      );
      const toggle = el.querySelector('#admin-activity-internal') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      await drain(fixture);
      expect(lastQuery(api)).toMatchObject({ exclude_internal: true, page: 1 });
    });
  });

  describe('notes, pagination, and failure states', () => {
    it('renders the API notes as localized prose', async () => {
      const { el } = await setup(
        makeApiMock(
          makeResponse([makeRow({ id: 1 })], {
            notes: [
              {
                code: 'bot_classification_incomplete',
                severity: 'warn',
                message: 'untranslated operator fallback',
                params: { rows: 17784 },
              },
            ],
          }),
        ),
      );
      expect(el.textContent).toContain(
        '17784 page views in this window were captured before bot classification',
      );
      // The API's `message` is for curl and logs, never for the screen.
      expect(el.textContent).not.toContain('untranslated operator fallback');
    });

    it('pages forward and hides the paginator when everything fits', async () => {
      const { el, fixture, api } = await setup(
        makeApiMock(makeResponse([makeRow({ id: 1 })], { total: 120 })),
      );
      expect(el.textContent).toContain('Page 1 of 3 · 120 rows');
      buttonByText(el, 'Next').click();
      await drain(fixture);
      expect(lastQuery(api).page).toBe(2);

      const small = await setup(makeApiMock(makeResponse([makeRow({ id: 1 })], { total: 1 })));
      expect(small.el.querySelector('aec-admin-paginator nav')).toBeNull();
    });

    it('shows an alert and recovers on retry', async () => {
      const api = makeApiMock(makeResponse([makeRow({ id: 1 })]));
      api.listPageViews.mockRejectedValueOnce(new Error('401'));
      const { el, fixture } = await setup(api);

      expect(el.querySelector('[role="alert"]')?.textContent).toContain("couldn't load");
      buttonByText(el, 'Try again').click();
      await drain(fixture);

      expect(el.querySelector('[role="alert"]')).toBeNull();
      expect(el.querySelector('table')).not.toBeNull();
    });

    it('shows an empty state rather than an empty table', async () => {
      const { el } = await setup(makeApiMock(makeResponse([])));
      expect(el.textContent).toContain('No visits match these filters');
      expect(el.querySelector('table')).toBeNull();
    });

    it('survives the filter-option lookup failing', async () => {
      const api = makeApiMock(makeResponse([makeRow({ id: 1 })]));
      api.listFilterOptions.mockRejectedValue(new Error('boom'));
      const { el } = await setup(api);
      // Losing a dropdown's options is not a reason to fail the screen.
      expect(el.querySelector('table')).not.toBeNull();
    });
  });

  describe('accessibility (structural)', () => {
    it('leaves the h1 to the shell and heads the section with an h2', async () => {
      const { el } = await setup(makeApiMock(makeResponse([makeRow({ id: 1 })])));
      expect(el.querySelectorAll('h1')).toHaveLength(0);
      expect(el.querySelectorAll('h2')).toHaveLength(1);
    });

    it('gives every table header a scope and the table an accessible name', async () => {
      const { el } = await setup(makeApiMock(makeResponse([makeRow({ id: 1 })])));
      const table = el.querySelector('table') as HTMLTableElement;
      expect(table.getAttribute('aria-label')).toBeTruthy();
      const headers = [...table.querySelectorAll('th')];
      expect(headers.length).toBeGreaterThan(0);
      for (const th of headers) expect(th.getAttribute('scope')).toBeTruthy();
    });

    it('gives every filter group a resolvable accessible name', async () => {
      const { el } = await setup(makeApiMock(makeResponse([makeRow({ id: 1 })])));
      const groups = [...el.querySelectorAll('[role="group"]')];
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) {
        const id = g.getAttribute('aria-labelledby');
        expect(id).toBeTruthy();
        expect(el.querySelector(`#${id}`)?.textContent?.trim()).toBeTruthy();
      }
    });

    it('labels every free-text and date input', async () => {
      const { el } = await setup(makeApiMock(makeResponse([makeRow({ id: 1 })])));
      const inputs = [...el.querySelectorAll('input')];
      expect(inputs.length).toBeGreaterThan(0);
      for (const input of inputs) {
        expect(el.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
      }
    });

    it('announces the result count politely', async () => {
      const { el } = await setup(makeApiMock(makeResponse([makeRow({ id: 1 })], { total: 42 })));
      const live = el.querySelector('[role="status"][aria-live="polite"]');
      expect(live?.textContent).toContain('42 visits match these filters');
    });
  });
});

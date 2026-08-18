/**
 * AECI-586 / Phase 8.3 P5.1 — `/admin/audience`.
 *
 * Mirrors `traffic.component.spec.ts`: browser platform, a macrotask `settle()`
 * to drain `afterNextRender`'s async load, and a mocked API. The live axe pass
 * runs in Playwright against the rendered route (the repo's component-level a11y
 * convention).
 *
 * **The empty-state suite is first and is the largest.** Both source tables hold
 * zero rows in production (§3), so that render is what an operator sees on day
 * one — and every failure mode the AC names lives there: a `0%` churn rate, an
 * axis drawn around a flat zero line, a `NaN`. They are asserted individually
 * rather than as one snapshot, because each is a different bug.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminAudienceResponse, AdminFeedbackResponse } from '@aeci/shared';

import { AdminAudience } from './audience';
import { AdminAudienceApi } from './admin-audience-api';

const WINDOW = {
  from: '2026-05-16T00:00:00.000Z',
  to: '2026-08-14T00:00:00.000Z',
  timezone: 'UTC' as const,
  days: 90,
};

/** An empty list: what production actually returns today. */
function emptyAudience(over: Partial<AdminAudienceResponse> = {}): AdminAudienceResponse {
  return {
    window: WINDOW,
    generated_at: '2026-08-13T17:30:00.000Z',
    source: 'live',
    notes: [],
    breakdown_limit: 8,
    subscribers: { active: 0, unsubscribed: 0, total_ever: 0, churn_rate: null },
    series: [
      { day: '2026-08-11', signups: 0, unsubscribes: 0, active_cumulative: 0 },
      { day: '2026-08-12', signups: 0, unsubscribes: 0, active_cumulative: 0 },
      { day: '2026-08-13', signups: 0, unsubscribes: 0, active_cumulative: 0 },
    ],
    window_totals: {
      signups: 0,
      unsubscribes: 0,
      net: 0,
      active_at_start: 0,
      active_at_end: 0,
      churn_rate: null,
    },
    utm: { source: [], medium: [], campaign: [] },
    geography: { country: [], region: [], city: [], asn: [] },
    feedback: { total_ever: 0, in_window: 0 },
    ...over,
  };
}

function populatedAudience(over: Partial<AdminAudienceResponse> = {}): AdminAudienceResponse {
  return emptyAudience({
    subscribers: { active: 5, unsubscribed: 3, total_ever: 8, churn_rate: 3 / 8 },
    series: [
      { day: '2026-08-11', signups: 2, unsubscribes: 0, active_cumulative: 4 },
      { day: '2026-08-12', signups: 1, unsubscribes: 1, active_cumulative: 4 },
      { day: '2026-08-13', signups: 0, unsubscribes: 1, active_cumulative: 3 },
    ],
    window_totals: {
      signups: 3,
      unsubscribes: 2,
      net: 1,
      active_at_start: 3,
      active_at_end: 4,
      churn_rate: 2 / 3,
    },
    utm: {
      source: [
        { key: 'newsletter', label: 'newsletter', subscribers: 2 },
        { key: null, label: 'Unattributed', subscribers: 1 },
      ],
      medium: [{ key: 'email', label: 'email', subscribers: 2 }],
      campaign: [{ key: 'launch', label: 'launch', subscribers: 2 }],
    },
    geography: {
      country: [{ key: 'ID', label: 'ID', subscribers: 2 }],
      region: [{ key: 'Jakarta', label: 'Jakarta', subscribers: 2 }],
      city: [{ key: 'Jakarta', label: 'Jakarta', subscribers: 2 }],
      asn: [{ key: '23700', label: 'PT Telkom Indonesia', subscribers: 2 }],
    },
    feedback: { total_ever: 2, in_window: 2 },
    ...over,
  });
}

function emptyFeedback(over: Partial<AdminFeedbackResponse> = {}): AdminFeedbackResponse {
  return {
    data: [],
    page: 1,
    perPage: 10,
    total: 0,
    generated_at: '2026-08-13T17:30:00.000Z',
    source: 'live',
    notes: [],
    ...over,
  };
}

function populatedFeedback(over: Partial<AdminFeedbackResponse> = {}): AdminFeedbackResponse {
  return emptyFeedback({
    total: 12,
    data: [
      {
        id: 2,
        created_at: '2026-08-12T10:00:00.000Z',
        features: 'A comparison view',
        tools: 'Procore, Revit',
        email: 'someone@example.com',
        subscribed: true,
        country: 'ID',
        city: 'Jakarta',
        region: 'Jakarta',
        timezone: 'Asia/Jakarta',
        referrer: 'https://example.com/blog',
      },
      {
        id: 1,
        created_at: '2026-08-11T10:00:00.000Z',
        features: null,
        tools: 'Bluebeam',
        email: null,
        subscribed: false,
        country: null,
        city: null,
        region: null,
        timezone: null,
        referrer: null,
      },
    ],
    ...over,
  });
}

interface ApiMock {
  audience: ReturnType<typeof vi.fn>;
  feedback: ReturnType<typeof vi.fn>;
}

function makeApi(over: Partial<ApiMock> = {}): ApiMock {
  return {
    audience: vi.fn(async () => emptyAudience()),
    feedback: vi.fn(async () => emptyFeedback()),
    ...over,
  };
}

const populatedApi = () =>
  makeApi({
    audience: vi.fn(async () => populatedAudience()),
    feedback: vi.fn(async () => populatedFeedback()),
  });

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: ApiMock = makeApi()) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminAudienceApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(AdminAudience);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn;
}

async function click(fixture: { detectChanges(): void }, btn: HTMLButtonElement) {
  btn.click();
  await settle();
  fixture.detectChanges();
}

/** The inbox's cards only. The charts above render legends as `<ul>`/`<li>`, so
 *  an unscoped `li` query walks into them. */
function feedbackCards(root: HTMLElement): HTMLLIElement[] {
  const section = root.querySelector('[aria-labelledby="admin-audience-feedback-heading"]');
  return [...(section?.querySelectorAll('li') ?? [])];
}

describe('AdminAudience', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('paints a visitor-state-neutral shell before any data arrives', () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: AdminAudienceApi, useValue: makeApi() },
      ],
    });
    const fixture = TestBed.createComponent(AdminAudience);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.textContent).toContain('Loading audience data');
    // No figure, no chart and no clock reading in the server render.
    expect(el.querySelector('svg')).toBeNull();
    expect(el.textContent).not.toContain('Active subscribers');
  });

  it('fetches the bundle and the inbox for the default 90-day window', async () => {
    const { api } = await setup();

    expect(api.audience).toHaveBeenCalledTimes(1);
    expect(api.feedback).toHaveBeenCalledTimes(1);

    const { from, to } = api.audience.mock.calls[0]![0] as { from: string; to: string };
    // Both ends inclusive, so a 90-day window spans 89 days of offset.
    const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    expect(spanDays).toBe(89);
    expect(api.feedback).toHaveBeenCalledWith({ page: 1, perPage: 10 });
  });

  // ── The empty state: what production renders today (§3) ──────────────────

  describe('with an empty mailing list and inbox', () => {
    it('renders the churn rate as "Not measured", never as 0%', async () => {
      const { el } = await setup();

      // Both readouts: the all-time tile and the window panel.
      expect(el.textContent?.match(/Not measured/g)?.length).toBe(2);
      expect(el.textContent).not.toContain('0%');
    });

    it('says why the churn rate is absent rather than leaving a bare dash', async () => {
      const { el } = await setup();

      expect(el.textContent).toContain('No subscribers yet, so there is no rate to report.');
      expect(el.textContent).toContain(
        'Nobody was subscribed when this window opened, so a rate for it is undefined.',
      );
    });

    it('draws no chart at all — no axis around a flat zero line', async () => {
      const { el } = await setup();

      // Every chart on the page falls through to its empty label. An SVG here
      // would mean an axis was drawn around a measurement nobody took.
      expect(el.querySelector('svg')).toBeNull();
      expect(el.textContent).toContain('No subscribers yet.');
      expect(el.textContent).toContain('No signups in this window.');
    });

    it('renders the counts as a measured zero, which is a different claim', async () => {
      const { el } = await setup();

      // The three stocks ARE measured and ARE zero — unlike the rate. This is the
      // distinction the section turns on, so both halves are asserted.
      expect(el.textContent).toContain('Active subscribers');
      expect(el.textContent).toContain('0');
    });

    it('renders an empty feedback inbox and hides the paginator', async () => {
      const { el } = await setup();

      expect(el.textContent).toContain('No feedback has been submitted yet.');
      expect(el.querySelector('aec-admin-paginator nav')).toBeNull();
    });

    it('shows no caveats — 0 of 0 signups is not incomplete', async () => {
      const { el } = await setup();
      expect(el.textContent).not.toContain('About these figures');
    });

    it('renders no NaN or Infinity anywhere', async () => {
      const { el } = await setup();
      // Not "undefined": the word appears legitimately in this screen's own copy
      // ("…so a rate for it is undefined"), which is the sentence explaining the
      // em dash. Angular interpolates an undefined value as an empty string
      // anyway, so the leak this guards against is the arithmetic one.
      expect(el.textContent).not.toMatch(/NaN|Infinity/);
    });
  });

  // ── The populated path ────────────────────────────────────────────────────

  describe('with subscribers', () => {
    it('renders the lifetime figures and the all-time churn rate', async () => {
      const { el } = await setup(populatedApi());

      expect(el.textContent).toContain('5'); // active
      expect(el.textContent).toContain('8'); // total ever
      expect(el.textContent).toContain('37.5%'); // 3 of 8
    });

    it('renders the window churn with its denominator stated', async () => {
      const { el } = await setup(populatedApi());

      expect(el.textContent).toContain('66.7%');
      expect(el.textContent).toContain('2 of the 3 subscribers active when this window opened');
    });

    it('states that churn is exact rather than estimated (§5.4)', async () => {
      const { el } = await setup(populatedApi());
      expect(el.textContent).toContain('Exact, not estimated');
    });

    it('signs the net change so a loss cannot read as a gain', async () => {
      const { el } = await setup(populatedApi());
      expect(el.textContent).toContain('+1');

      const losing = populatedApi();
      losing.audience = vi.fn(async () =>
        populatedAudience({
          window_totals: {
            signups: 1,
            unsubscribes: 4,
            net: -3,
            active_at_start: 6,
            active_at_end: 3,
            churn_rate: 4 / 6,
          },
        }),
      );
      const { el: el2 } = await setup(losing);
      expect(el2.textContent).toContain('-3');
    });

    it('draws the charts once there is something to draw', async () => {
      const { el } = await setup(populatedApi());
      expect(el.querySelectorAll('svg').length).toBeGreaterThan(0);
    });

    it('renders the unattributed UTM bucket with its own localized label', async () => {
      const { el } = await setup(populatedApi());

      // The API's `label` for a null key is untranslated operator text; the UI
      // keys off `key === null` and supplies its own.
      expect(el.textContent).toContain('No campaign source');
      expect(el.textContent).not.toContain('Unattributed');
    });

    it('labels a network by its holder name, not its number', async () => {
      const { el } = await setup(populatedApi());
      expect(el.textContent).toContain('PT Telkom Indonesia');
    });
  });

  // ── Controls ──────────────────────────────────────────────────────────────

  describe('controls', () => {
    it('re-fetches on a range change and returns the inbox to page 1', async () => {
      const { fixture, api, el } = await setup();

      await click(fixture, buttonByText(el, '365 days'));

      expect(api.audience).toHaveBeenCalledTimes(2);
      const { from, to } = api.audience.mock.calls[1]![0] as { from: string; to: string };
      const spanDays =
        (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
      expect(spanDays).toBe(364);
      expect(api.feedback).toHaveBeenLastCalledWith({ page: 1, perPage: 10 });
    });

    it('ignores a re-click of the active range rather than re-querying', async () => {
      const { fixture, api, el } = await setup();

      await click(fixture, buttonByText(el, '90 days'));
      expect(api.audience).toHaveBeenCalledTimes(1);
    });

    it('changes no query when the timezone toggle flips (§9.5)', async () => {
      const { fixture, api, el } = await setup();

      await click(fixture, buttonByText(el, 'WIB'));

      // Presentational only: the buckets are UTC calendar days computed
      // server-side and cannot be re-bucketed here.
      expect(api.audience).toHaveBeenCalledTimes(1);
      expect(el.textContent).toContain('Daily buckets are UTC days: 07:00 to 07:00 WIB.');
    });

    it('pages the inbox without re-running the aggregates', async () => {
      const { fixture, api, el } = await setup(populatedApi());

      await click(fixture, buttonByText(el, 'Next'));

      expect(api.feedback).toHaveBeenLastCalledWith({ page: 2, perPage: 10 });
      // The subscriber figures do not depend on the inbox page.
      expect(api.audience).toHaveBeenCalledTimes(1);
    });
  });

  // ── Feedback rendering ────────────────────────────────────────────────────

  describe('the feedback inbox', () => {
    it('renders the submitted text, the email and the opt-in chip', async () => {
      const { el } = await setup(populatedApi());

      expect(el.textContent).toContain('A comparison view');
      expect(el.textContent).toContain('Procore, Revit');
      expect(el.textContent).toContain('someone@example.com');
      expect(el.textContent).toContain('Joined the mailing list');
    });

    it('renders the referrer as text, never as a link', async () => {
      const { el } = await setup(populatedApi());

      expect(el.textContent).toContain('https://example.com/blog');
      // A clickable link to an arbitrary submitted URL buys nothing here and
      // opens a redirect surface on an admin screen.
      const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
      expect(hrefs).not.toContain('https://example.com/blog');
    });

    it('escapes submitted content rather than interpreting it as markup', async () => {
      const api = populatedApi();
      api.feedback = vi.fn(async () =>
        populatedFeedback({
          total: 1,
          data: [
            {
              id: 9,
              created_at: '2026-08-12T10:00:00.000Z',
              features: '<img src=x onerror="alert(1)">',
              tools: null,
              email: null,
              subscribed: false,
              country: null,
              city: null,
              region: null,
              timezone: null,
              referrer: null,
            },
          ],
        }),
      );
      const { el } = await setup(api);

      expect(el.querySelector('img')).toBeNull();
      expect(el.textContent).toContain('<img src=x onerror="alert(1)">');
    });

    it('omits a field the submitter left blank rather than printing an empty row', async () => {
      const { el } = await setup(populatedApi());

      // Scoped to the inbox: the chart legends render `<li>`s too, so a bare
      // `querySelectorAll('li')` walks into the charts above.
      const second = feedbackCards(el)[1]!;
      expect(second.textContent).toContain('Bluebeam');
      expect(second.textContent).not.toContain('Features they want');
      expect(second.textContent).not.toContain('Email');
    });
  });

  // ── Notes, errors, structure ──────────────────────────────────────────────

  it('localizes a note from its code rather than the wire message', async () => {
    const api = makeApi({
      audience: vi.fn(async () =>
        populatedAudience({
          notes: [
            {
              code: 'audience_history_is_current_state',
              severity: 'info',
              message: 'RAW OPERATOR TEXT',
            },
          ],
        }),
      ),
    });
    const { el } = await setup(api);

    expect(el.textContent).toContain('resubscribing clears that timestamp');
    expect(el.textContent).not.toContain('RAW OPERATOR TEXT');
  });

  it('interpolates the attribution note from its params, not from `rows`', async () => {
    const api = makeApi({
      audience: vi.fn(async () =>
        populatedAudience({
          notes: [
            {
              code: 'utm_attribution_incomplete',
              severity: 'info',
              message: 'raw',
              params: { missing: 1, total: 3 },
            },
          ],
        }),
      ),
    });
    const { el } = await setup(api);

    expect(el.textContent).toContain('1 of 3 signups in this window arrived with no campaign');
  });

  it('falls back to the operator message for a code this build does not know', async () => {
    const api = makeApi({
      audience: vi.fn(async () =>
        populatedAudience({
          notes: [
            {
              code: 'some_future_code' as never,
              severity: 'warn',
              message: 'A caveat from a newer API.',
            },
          ],
        }),
      ),
    });
    const { el } = await setup(api);

    expect(el.textContent).toContain('A caveat from a newer API.');
  });

  it('surfaces a retryable error when the reads fail, then recovers', async () => {
    let fail = true;
    const api = makeApi({
      audience: vi.fn(async () => {
        if (fail) throw new Error('boom');
        return populatedAudience();
      }),
    });
    const { fixture, el } = await setup(api);

    expect(el.querySelector('[role="alert"]')).not.toBeNull();
    expect(el.textContent).toContain('Audience data could not be loaded.');

    fail = false;
    await click(fixture, buttonByText(el, 'Try again'));

    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.textContent).toContain('37.5%');
  });

  it('gives every filter group an accessible name and every toggle a pressed state', async () => {
    const { el } = await setup();

    for (const fieldset of el.querySelectorAll('fieldset')) {
      expect(fieldset.querySelector('legend')?.textContent?.trim()).toBeTruthy();
    }
    for (const button of el.querySelectorAll('fieldset button')) {
      expect(button.getAttribute('aria-pressed')).toMatch(/true|false/);
    }
  });

  it('renders headings in order beneath the shell h1', async () => {
    const { el } = await setup(populatedApi());

    const levels = [...el.querySelectorAll('h2, h3, h4')].map((h) => Number(h.tagName[1]));
    expect(levels[0]).toBe(2);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
    }
  });
});

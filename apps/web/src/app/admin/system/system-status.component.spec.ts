/**
 * AECI-580 / Phase 8.3 P1.6 — `SystemStatus` (the `/admin/system` page).
 *
 * The three assertions the AC singles out, all of them about the screen refusing
 * to overstate what it knows:
 *
 *   1. **A SHA mismatch between the two Workers renders a visible warning** —
 *      with a fixture where the two differ, and its negative (matching SHAs, and
 *      an `unknown` sentinel, produce no alarm).
 *   2. **A check that returns zero rows renders as passing, not as empty.**
 *   3. **Cron liveness renders "Unknown", never "ok", when `job_runs` is absent.**
 *      This is the failure mode that would make the screen lie. AECI-583 made a
 *      recorded outcome reachable, and sharpened rather than relaxed this: the
 *      no-rows case is kept verbatim as the "a newly added cron must still render
 *      honestly" guard, and an unfinished run reads "In flight", never a success.
 *   4. **A stored data-quality result is labelled as stored.** The default view
 *      now replays the last 04:00 run, so the "as of" line is what stops those
 *      figures reading as live ones.
 *
 * Plus the degradation path: losing `/_version` must cost only that one card.
 *
 * Harness mirrors `reviewer-bans.component.spec.ts`: zoneless TestBed + a
 * macrotask `settle()` to drain `afterNextRender`'s async load.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminCronRun,
  AdminDataQualityCheck,
  AdminSystemResponse,
  VersionResponse,
} from '@aeci/shared';

import { AdminSystemApi } from './admin-system-api';
import { SystemStatus } from './system-status';

const API_SHA = 'a1b2c3d';
const SSR_SHA = 'a1b2c3d';

function makeCron(over: Partial<AdminCronRun> & { job: AdminCronRun['job'] }): AdminCronRun {
  return {
    job: over.job,
    schedule: over.schedule ?? '0 4 * * *',
    source: over.source ?? 'unknown',
    last_run_at: over.last_run_at ?? null,
    last_outcome: over.last_outcome ?? null,
    duration_ms: over.duration_ms ?? null,
    derived_from: over.derived_from ?? null,
    run_state: over.run_state ?? null,
  };
}

function makeCheck(over: Partial<AdminDataQualityCheck> & { id: string }): AdminDataQualityCheck {
  return {
    id: over.id,
    label: over.label ?? `Check ${over.id}`,
    severity: over.severity ?? 'warn',
    count: over.count ?? 0,
    sample: over.sample ?? [],
    ...(over.note ? { note: over.note } : {}),
    ...(over.skipped ? { skipped: over.skipped } : {}),
    ...(over.error ? { error: over.error } : {}),
  };
}

function makeSystem(over: Partial<AdminSystemResponse> = {}): AdminSystemResponse {
  return {
    generated_at: '2026-08-13T05:00:00.000Z',
    source: 'live',
    recomputed: false,
    notes: [],
    version: {
      sha: API_SHA,
      deployed_at: '2026-08-13T04:00:00.000Z',
      environment: 'production',
    },
    crons: [
      makeCron({ job: 'metrics-snapshot', schedule: '15 0 * * *' }),
      makeCron({ job: 'retention-prune', schedule: '0 3 * * *' }),
      makeCron({ job: 'data-quality', schedule: '0 4 * * *' }),
      makeCron({ job: 'analytics-digest', schedule: '0 5 * * *' }),
      makeCron({ job: 'moderation-snapshot', schedule: '0 6 * * *' }),
      makeCron({ job: 'home-stats', schedule: '0 7 * * *' }),
      makeCron({ job: 'algolia-sync', schedule: '0 8 * * *' }),
      makeCron({ job: 'algolia-drift', schedule: '0 9 * * *' }),
      makeCron({ job: 'request-reconcile', schedule: '*/15 * * * *' }),
      makeCron({ job: 'waf-poll', schedule: '0 * * * *' }),
    ],
    data_quality: null,
    algolia: { watermark: null, drift: null, orphan_sweep: null },
    database: { size_bytes: 19_030_016, tables: [{ table: 'products', rows: 171 }] },
    stats_freshness: {
      computed_at: '2026-08-13T01:00:00.000Z',
      age_hours: 4,
      stale: false,
    },
    ...over,
  };
}

function makeSsrVersion(sha = SSR_SHA): VersionResponse {
  return { sha, deployedAt: '2026-08-13T04:00:00.000Z', environment: 'production' };
}

interface SystemApiMock {
  getSystem: ReturnType<typeof vi.fn>;
  getSsrVersion: ReturnType<typeof vi.fn>;
}

function makeApiMock(
  system: AdminSystemResponse = makeSystem(),
  ssr: VersionResponse | Error = makeSsrVersion(),
): SystemApiMock {
  return {
    getSystem: vi.fn(async () => structuredClone(system)),
    getSsrVersion: vi.fn(async () => {
      if (ssr instanceof Error) throw ssr;
      return structuredClone(ssr);
    }),
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: SystemApiMock = makeApiMock()) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: AdminSystemApi, useValue: api }],
  });
  const fixture = TestBed.createComponent(SystemStatus);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

/** The cron table's `<tr>` for a given job id. */
function cronRow(el: HTMLElement, job: string): HTMLElement {
  const table = el.querySelector('table');
  const row = [...(table?.querySelectorAll('tbody tr') ?? [])].find(
    (tr) => tr.querySelector('th')?.textContent?.trim() === job,
  );
  if (!row) throw new Error(`No cron row for "${job}"`);
  return row as HTMLElement;
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn as HTMLButtonElement;
}

describe('SystemStatus — version mismatch (AC 1)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('renders a visible alert when the SSR and API SHAs differ', async () => {
    const { el } = await setup(makeApiMock(makeSystem(), makeSsrVersion('deadbee')));

    const alert = [...el.querySelectorAll('[role="alert"]')].find((n) =>
      n.textContent?.includes('different commits'),
    );
    expect(alert).toBeTruthy();
    // Both SHAs stay on screen so the operator can see WHICH is behind.
    expect(el.textContent).toContain('deadbee');
    expect(el.textContent).toContain(API_SHA);
  });

  it('renders no mismatch alert when the two SHAs agree', async () => {
    const { el } = await setup();

    const alert = [...el.querySelectorAll('[role="alert"]')].find((n) =>
      n.textContent?.includes('different commits'),
    );
    expect(alert).toBeUndefined();
  });

  it('does not cry mismatch when a SHA was never injected — that is unknown, not a difference', async () => {
    const system = makeSystem({
      version: { sha: 'unknown', deployed_at: '1970-01-01T00:00:00.000Z', environment: 'preview' },
    });
    const { el } = await setup(makeApiMock(system, makeSsrVersion('a1b2c3d')));

    const alert = [...el.querySelectorAll('[role="alert"]')].find((n) =>
      n.textContent?.includes('different commits'),
    );
    expect(alert).toBeUndefined();
  });

  it('reads BOTH endpoints — one version alone cannot detect a stale SSR deploy', async () => {
    const { api } = await setup();
    expect(api.getSystem).toHaveBeenCalledTimes(1);
    expect(api.getSsrVersion).toHaveBeenCalledTimes(1);
  });

  it('degrades to "unavailable" for the SSR card alone when /_version fails', async () => {
    const { el } = await setup(makeApiMock(makeSystem(), new Error('offline')));

    expect(el.textContent).toContain('Unavailable');
    expect(el.textContent).toContain('version could not be read');
    // The rest of the diagnostic page still renders.
    expect(el.textContent).toContain(API_SHA);
    expect(el.querySelector('table')).toBeTruthy();
  });
});

describe('SystemStatus — data-quality checks (AC 2)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('renders a zero-row check as PASSING, not as an empty row', async () => {
    const system = makeSystem({
      recomputed: true,
      data_quality: {
        source: 'live',
        computed_at: '2026-08-13T05:00:00.000Z',
        failing: 0,
        checks: [
          makeCheck({ id: 'products_without_vendor', label: 'Products with no vendor', count: 0 }),
        ],
      },
    });
    const { el } = await setup(makeApiMock(system));

    const item = [...el.querySelectorAll('li')].find((li) =>
      li.textContent?.includes('Products with no vendor'),
    );
    expect(item).toBeTruthy();
    expect(item?.textContent).toContain('Passing');
    // Severity and count are always shown, even when clean.
    expect(item?.textContent).toContain('warn');
    expect(item?.textContent).toContain('0');
  });

  it('renders severity and sample rows for a check with findings', async () => {
    const system = makeSystem({
      recomputed: true,
      data_quality: {
        source: 'live',
        computed_at: '2026-08-13T05:00:00.000Z',
        failing: 1,
        checks: [
          makeCheck({
            id: 'broken_integration_refs',
            label: 'Integrations referencing a pulled product',
            severity: 'error',
            count: 2,
            sample: ['int-1: source "A" (retracted)', 'int-2: target "B" (rejected)'],
          }),
        ],
      },
    });
    const { el } = await setup(makeApiMock(system));

    const item = [...el.querySelectorAll('li')].find((li) =>
      li.textContent?.includes('Integrations referencing a pulled product'),
    );
    expect(item?.textContent).toContain('Needs attention');
    expect(item?.textContent).toContain('error');
    expect(item?.querySelector('details')).toBeTruthy();
    expect(item?.textContent).toContain('int-1: source "A" (retracted)');
  });

  it('distinguishes a skipped check and an errored check from a finding', async () => {
    const system = makeSystem({
      recomputed: true,
      data_quality: {
        source: 'live',
        computed_at: '2026-08-13T05:00:00.000Z',
        failing: 1,
        checks: [
          makeCheck({
            id: 'algolia_index_drift',
            label: 'Algolia index drift',
            skipped: true,
            note: 'skipped — Algolia credentials not configured',
          }),
          makeCheck({ id: 'logo_404', label: 'Logo 404s', error: 'fetch failed' }),
        ],
      },
    });
    const { el } = await setup(makeApiMock(system));

    const skipped = [...el.querySelectorAll('li')].find((li) =>
      li.textContent?.includes('Algolia index drift'),
    );
    const errored = [...el.querySelectorAll('li')].find((li) =>
      li.textContent?.includes('Logo 404s'),
    );
    expect(skipped?.textContent).toContain('Skipped');
    expect(skipped?.textContent).not.toContain('Passing');
    expect(errored?.textContent).toContain('Errored');
    expect(errored?.textContent).toContain('fetch failed');
  });

  it('does not run the checks on load, and runs them on demand with ?recompute=1', async () => {
    const api = makeApiMock();
    const { fixture, el } = await setup(api);

    expect(api.getSystem).toHaveBeenCalledWith({ recompute: false });
    expect(el.textContent).toContain('No stored result yet');

    api.getSystem.mockImplementation(async () =>
      makeSystem({
        recomputed: true,
        data_quality: {
          source: 'live',
          computed_at: '2026-08-13T05:00:00.000Z',
          failing: 0,
          checks: [makeCheck({ id: 'products_without_vendor', label: 'Products with no vendor' })],
        },
      }),
    );
    buttonByText(el, 'Run data-quality checks').click();
    await fixture.whenStable();
    await settle();
    fixture.detectChanges();

    expect(api.getSystem).toHaveBeenLastCalledWith({ recompute: true });
    expect(el.textContent).toContain('Passing');
  });

  it('says when the checks shown are a stored result rather than a fresh one', async () => {
    const system = makeSystem({
      data_quality: {
        source: 'job_runs',
        computed_at: '2026-08-13T04:01:00.000Z',
        failing: 0,
        checks: [makeCheck({ id: 'products_without_vendor' })],
      },
    });
    const { el } = await setup(makeApiMock(system));

    // Without this line the stored figures read as live ones.
    expect(el.textContent).toContain('Stored result from the last scheduled run');
    expect(el.textContent).not.toContain('Run just now');
  });

  it('says when they were run live', async () => {
    const system = makeSystem({
      recomputed: true,
      data_quality: {
        source: 'live',
        computed_at: '2026-08-13T05:00:00.000Z',
        failing: 0,
        checks: [makeCheck({ id: 'products_without_vendor' })],
      },
    });
    const { el } = await setup(makeApiMock(system));

    expect(el.textContent).toContain('Run just now');
    expect(el.textContent).not.toContain('Stored result from the last scheduled run');
  });

  it('renders stored_result_unreadable as localized prose naming the job', async () => {
    const system = makeSystem({
      notes: [
        {
          code: 'stored_result_unreadable',
          severity: 'warn',
          message: 'RAW OPERATOR FALLBACK',
          params: { job: 'data-quality' },
        },
      ],
    });
    const { el } = await setup(makeApiMock(system));

    expect(el.textContent).toContain("A stored result from the data-quality job couldn't be read");
    expect(el.textContent).not.toContain('RAW OPERATOR FALLBACK');
  });
});

describe('SystemStatus — cron liveness (AC 3)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('renders every cron as "Unknown" — never "ok" — when job_runs is absent', async () => {
    const { el } = await setup();

    for (const job of [
      'metrics-snapshot',
      'data-quality',
      'analytics-digest',
      'moderation-snapshot',
      'home-stats',
      'algolia-sync',
      'algolia-drift',
      'request-reconcile',
      'waf-poll',
    ]) {
      const row = cronRow(el, job);
      expect(row.textContent).toContain('Unknown');
      expect(row.textContent).toContain('No record');
      expect(row.textContent?.toLowerCase()).not.toContain('ok');
    }
  });

  it('shows all ten jobs with their schedules — an omitted job would read as "not configured"', async () => {
    const { el } = await setup();
    const rows = el.querySelectorAll('table tbody tr');
    // Ten cron rows + one row per database table (a second table).
    expect([...rows].filter((r) => r.textContent?.includes('* *')).length).toBe(10);
    expect(cronRow(el, 'request-reconcile').textContent).toContain('*/15 * * * *');
  });

  it('qualifies a derived timestamp as inferred and still reports the outcome as unknown', async () => {
    const system = makeSystem({
      crons: [
        makeCron({
          job: 'home-stats',
          schedule: '0 7 * * *',
          source: 'derived',
          last_run_at: '2026-08-13T01:00:00.000Z',
          derived_from: 'stats_cache.computed_at',
        }),
      ],
    });
    const { el } = await setup(makeApiMock(system));

    const row = cronRow(el, 'home-stats');
    expect(row.textContent).toContain('inferred from stats_cache.computed_at');
    // A watermark proves the job RAN, not that it SUCCEEDED.
    expect(row.textContent).toContain('Inferred');
  });

  it('renders the cron_liveness_unavailable caveat as localized prose, not the API message', async () => {
    const system = makeSystem({
      notes: [
        {
          code: 'cron_liveness_unavailable',
          severity: 'warn',
          message: 'RAW OPERATOR FALLBACK',
          params: { unknown: 8, total: 8 },
        },
      ],
    });
    const { el } = await setup(makeApiMock(system));

    expect(el.textContent).toContain('8 of 8 scheduled jobs have no recorded run yet');
    expect(el.textContent).not.toContain('RAW OPERATOR FALLBACK');
  });

  it('renders a recorded success as localized prose, never the raw wire value', async () => {
    const system = makeSystem({
      crons: [
        makeCron({
          job: 'home-stats',
          schedule: '0 7 * * *',
          source: 'job_runs',
          last_run_at: '2026-08-13T07:00:00.000Z',
          last_outcome: 'ok',
          duration_ms: 1234,
          run_state: 'complete',
        }),
      ],
    });
    const { el } = await setup(makeApiMock(system));

    const row = cronRow(el, 'home-stats');
    expect(row.textContent).toContain('Succeeded');
    // The template used to interpolate `last_outcome` directly. That branch was
    // unreachable until AECI-583; now that it isn't, it must be translated.
    expect(row.textContent).not.toMatch(/\bok\b/);
  });

  it('shows the duration of a recorded run — and NOT a dangling "inferred from"', async () => {
    const system = makeSystem({
      crons: [
        makeCron({
          job: 'waf-poll',
          schedule: '0 * * * *',
          source: 'job_runs',
          last_run_at: '2026-08-13T07:00:00.000Z',
          last_outcome: 'ok',
          duration_ms: 1234,
          run_state: 'complete',
        }),
      ],
    });
    const { el } = await setup(makeApiMock(system));

    const row = cronRow(el, 'waf-poll');
    expect(row.textContent).toContain('took 1,234 ms');
    // Regression guard: `derived_from` is null on a recorded row, and the
    // qualifier used to render off `last_run_at` alone.
    expect(row.textContent).not.toContain('inferred from');
  });

  it('renders a failed run distinctly', async () => {
    const system = makeSystem({
      crons: [
        makeCron({
          job: 'algolia-drift',
          schedule: '0 9 * * *',
          source: 'job_runs',
          last_run_at: '2026-08-13T09:00:00.000Z',
          last_outcome: 'failed',
          duration_ms: 10,
          run_state: 'complete',
        }),
      ],
    });
    const { el } = await setup(makeApiMock(system));

    const row = cronRow(el, 'algolia-drift');
    expect(row.textContent).toContain('Failed');
    expect(row.querySelector('.text-\\(--status-error\\)')).not.toBeNull();
  });

  it('renders an unfinished run as in flight — not as "Recorded", and never as a success', async () => {
    const system = makeSystem({
      crons: [
        makeCron({
          job: 'data-quality',
          schedule: '0 4 * * *',
          source: 'job_runs',
          last_run_at: '2026-08-13T04:00:00.000Z',
          last_outcome: null,
          duration_ms: null,
          run_state: 'in_flight',
        }),
      ],
    });
    const { el } = await setup(makeApiMock(system));

    const row = cronRow(el, 'data-quality');
    expect(row.textContent).toContain('In flight');
    expect(row.textContent).toContain('started, no finish recorded');
    expect(row.textContent).not.toContain('Recorded');
    expect(row.textContent).not.toContain('Succeeded');
  });

  it('falls back to the API message for a note code it does not recognize', async () => {
    const system = makeSystem({
      notes: [
        {
          code: 'partial_day' as const,
          severity: 'info',
          message: 'A brand new caveat the UI has no string for.',
        },
      ],
    });
    const { el } = await setup(makeApiMock(system));

    expect(el.textContent).toContain('A brand new caveat the UI has no string for.');
  });
});

describe('SystemStatus — Algolia + database', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('reports an unrecorded orphan sweep as unrecorded — never as clean', async () => {
    const { el } = await setup();
    expect(el.textContent).toContain('No sweep has been recorded yet');
    expect(el.textContent).not.toContain('No orphaned records found');
  });

  it('renders the stored sweep, and flags the safety cap an operator has to act on', async () => {
    const system = makeSystem({
      algolia: {
        watermark: null,
        drift: null,
        orphan_sweep: {
          ran_at: '2026-08-13T09:00:30.000Z',
          ok: true,
          total_orphans: 7,
          total_deleted: 5,
          capped: 1,
          indexes: [
            {
              entity: 'products',
              index_name: 'aeci_products',
              index_count: 100,
              promoted_count: 95,
              orphans: 5,
              deleted: 5,
              skipped_by_safety_cap: false,
              ok: true,
            },
            {
              entity: 'vendors',
              index_name: 'aeci_vendors',
              index_count: 50,
              promoted_count: 48,
              orphans: 2,
              deleted: 0,
              skipped_by_safety_cap: true,
              ok: true,
            },
          ],
        },
      },
    });
    const { el } = await setup(makeApiMock(system));

    expect(el.textContent).toContain('Removed 5 of 7 orphaned record(s)');
    expect(el.textContent).toContain('aeci_vendors');
    expect(el.textContent).toContain('1 index(es) were refused by the safety cap');
  });

  it('reports a never-run sync rather than a zero watermark', async () => {
    const { el } = await setup();
    expect(el.textContent).toContain('incremental sync has never run');
  });

  it('renders the watermark stamp and each entity cursor', async () => {
    const system = makeSystem({
      algolia: {
        watermark: {
          computed_at: '2026-08-13T02:30:00.000Z',
          entities: [
            { entity: 'product', watermark: '2026-08-13T02:00:00.000Z' },
            { entity: 'vendor', watermark: '2026-08-13T02:00:00.000Z' },
          ],
        },
        drift: null,
        orphan_sweep: null,
      },
    });
    const { el } = await setup(makeApiMock(system));

    expect(el.textContent).toContain('product');
    expect(el.textContent).toContain('2026-08-13T02:00:00.000Z');
  });

  it('renders D1 size and per-table row counts', async () => {
    const system = makeSystem({
      database: {
        size_bytes: 19_030_016,
        tables: [
          { table: 'products', rows: 171 },
          { table: 'vendors', rows: 126 },
        ],
      },
    });
    const { el } = await setup(makeApiMock(system));

    expect(el.textContent).toContain('18.15 MB');
    expect(el.textContent).toContain('products');
    expect(el.textContent).toContain('171');
    // Total across tables.
    expect(el.textContent).toContain('297');
  });

  it('reports an unknown D1 size as unknown rather than estimating it', async () => {
    const system = makeSystem({
      database: { size_bytes: null, tables: [{ table: 'products', rows: 171 }] },
    });
    const { el } = await setup(makeApiMock(system));

    expect(el.textContent).toContain('Unknown');
  });
});

describe('SystemStatus — load states', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('renders a retryable error when the bundle fails to load', async () => {
    const api = makeApiMock();
    api.getSystem.mockRejectedValue(new Error('401'));
    const { fixture, el } = await setup(api);

    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "couldn't load system status",
    );

    api.getSystem.mockImplementation(async () => makeSystem());
    buttonByText(el, 'Try again').click();
    await fixture.whenStable();
    await settle();
    fixture.detectChanges();

    expect(el.textContent).toContain('Scheduled jobs');
  });

  it('paints nothing that claims a state before the fetch resolves (SSR-neutral first paint)', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: AdminSystemApi, useValue: makeApiMock() },
      ],
    });
    const fixture = TestBed.createComponent(SystemStatus);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.textContent).toContain('Loading system status');
    expect(el.querySelector('table')).toBeNull();
  });
});

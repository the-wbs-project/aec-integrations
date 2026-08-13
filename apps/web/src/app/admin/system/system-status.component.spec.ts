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
 *      This is the failure mode that would make the screen lie.
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
    expect(el.textContent).toContain("aren't run automatically");

    api.getSystem.mockImplementation(async () =>
      makeSystem({
        recomputed: true,
        data_quality: {
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

  it('shows all nine jobs with their schedules — an omitted job would read as "not configured"', async () => {
    const { el } = await setup();
    const rows = el.querySelectorAll('table tbody tr');
    // Nine cron rows + one row per database table (a second table).
    expect([...rows].filter((r) => r.textContent?.includes('* *')).length).toBe(9);
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

    expect(el.textContent).toContain('8 of 8 scheduled jobs have no last-run record');
    expect(el.textContent).not.toContain('RAW OPERATOR FALLBACK');
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

  it('reports the orphan sweep as unrecorded rather than clean', async () => {
    const { el } = await setup();
    expect(el.textContent).toContain('No result is stored for the orphan sweep');
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

/**
 * `POST /api/promote` — Datadog observability for `skipped[]` (§4). A promote can
 * return `200` while silently NOT linking some entities (an integration whose far
 * endpoint isn't promoted, a usefulness group that didn't resolve, …). The metrics
 * layer only sees the 2xx, so the handler emits a `warn` log + an
 * `aeci.api.promote.skipped` count so the partial loss is visible in Datadog alone
 * (docs/REVIEW_APP_PROMOTE_API.md §6). The transport is mocked here to assert the
 * exact log payload + metric tags.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { products } from '../db/schema';
import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import {
  createPromoteHandler,
  type PromoteAlgoliaSync,
  type PromoteGoogleIndexingNotify,
  type PromoteHomeStatsRefresh,
  type PromoteIndexNowNotify,
} from './promote';

vi.mock('../datadog', () => ({
  logToDatadog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const noop = async () => {};
const noopAlgolia: PromoteAlgoliaSync = noop;
const noopIndexNow: PromoteIndexNowNotify = noop;
const noopGoogleIndexing: PromoteGoogleIndexingNotify = noop;
const noopHomeStats: PromoteHomeStatsRefresh = noop;

const baseEnv: Env = { ENV: 'preview' };
const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(logToDatadog).mockClear();
  vi.mocked(submitCount).mockClear();
});
afterEach(() => t.dispose());

function promote(body: unknown) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(errorHandler());
  app.post(
    '/api/promote',
    createPromoteHandler(t.factory, noopAlgolia, noopIndexNow, noopGoogleIndexing, noopHomeStats),
  );
  return app.request(
    '/api/promote',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    baseEnv,
    fakeExecutionContext(),
  );
}

/** The `logToDatadog` event whose message is the partial-skipped signal. */
function partialSkippedLog(): Record<string, unknown> | undefined {
  const call = vi
    .mocked(logToDatadog)
    .mock.calls.find(
      (c) => (c[3] as { message?: string })?.message === 'aeci.api.promote.partial_skipped',
    );
  return call?.[3] as Record<string, unknown> | undefined;
}

/** All `aeci.api.promote.skipped` count submissions as `[value, tags]` pairs. */
function skippedMetricCalls(): Array<{ value: number; tags: string[] }> {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((c) => c[3] === 'aeci.api.promote.skipped')
    .map((c) => ({ value: c[4] as number, tags: c[5] as string[] }));
}

describe('promote skip observability', () => {
  it('logs partial_skipped with per-kind detail + emits a skipped count per kind', async () => {
    const res = await promote({
      vendors: [],
      product: {
        ref: 'p1',
        name: 'Revit',
        // A usefulness group that resolves to no existing audience term (it is NOT
        // in `audiences`, so it is never find-or-created) → one `usefulness` skip.
        usefulness: { audiences: [{ name: 'Made Up Discipline', points: ['pt'] }], phases: [] },
      },
      integrations: [
        // Both target a product that isn't promoted → two `integration` skips.
        { ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: uuid(9) } },
        { ref: 'i2', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: uuid(8) } },
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped: { kind: string }[] };
    expect(body.skipped).toHaveLength(3);

    // One structured log carrying the full detail + per-kind scalar counts.
    const log = partialSkippedLog();
    expect(log).toMatchObject({
      level: 'warn',
      source: 'review-app-promote',
      outcome: 'partial',
      skipped_count: 3,
      skipped_integration: 2,
      skipped_usefulness: 1,
    });
    expect(log!.skipped).toHaveLength(3);

    // One alertable count per kind (value = that kind's skip count; query `sum:`).
    const metrics = skippedMetricCalls();
    expect(metrics).toContainEqual({ value: 2, tags: ['source:promote', 'kind:integration'] });
    expect(metrics).toContainEqual({ value: 1, tags: ['source:promote', 'kind:usefulness'] });
  });

  it('emits nothing for a clean promote (no skips)', async () => {
    const existing = uuid(1);
    await t.db.insert(products).values({
      id: existing,
      slug: 'navisworks',
      name: 'Navisworks',
      promotionStatus: 'promoted',
    });

    const res = await promote({
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        { ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: existing } },
      ],
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { skipped: unknown[] }).skipped).toHaveLength(0);
    expect(partialSkippedLog()).toBeUndefined();
    expect(skippedMetricCalls()).toHaveLength(0);
  });
});

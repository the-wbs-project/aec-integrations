/**
 * Promote ingest — Datadog observability for `skipped[]` (§4). A promote can succeed
 * while silently NOT linking some entities (an integration whose far endpoint isn't
 * promoted, a usefulness group that didn't resolve, …). Neither the metrics layer nor a
 * `status: 'complete'` poll response reveals that, so the ingest emits a `warn` log + an
 * `aeci.api.promote.skipped` count so the partial loss is visible in Datadog alone
 * (docs/REVIEW_APP_PROMOTE_API.md §6). The transport is mocked here to assert the
 * exact log payload + metric tags.
 */

import { PromotePayloadSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { products } from '../db/schema';
import { logToPosthog, submitCount } from '../posthog';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import {
  dispatchPromoteHooks,
  runPromoteIngest,
  type PromoteAlgoliaSync,
  type PromoteGoogleIndexingNotify,
  type PromoteHomeStatsRefresh,
  type PromoteIndexNowNotify,
  type PromoteRunCtx,
} from './promote';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
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
  vi.mocked(logToPosthog).mockClear();
  vi.mocked(submitCount).mockClear();
});
afterEach(() => t.dispose());

/** Run the ingest + its post-commit tail exactly as the Workflow's commit step does. */
async function promote(body: unknown) {
  const execCtx = fakeExecutionContext();
  const rc: PromoteRunCtx = {
    env: baseEnv,
    request: new Request('http://localhost:8787/api/promote'),
    waitUntil: (promise) => execCtx.waitUntil(promise),
    bookmark: () => null,
  };
  const deps = {
    dbFor: t.factory,
    syncAlgolia: noopAlgolia,
    notifyIndexNow: noopIndexNow,
    notifyGoogleIndexing: noopGoogleIndexing,
    refreshHomeStats: noopHomeStats,
  };
  const result = await runPromoteIngest(rc, PromotePayloadSchema.parse(body), deps);
  dispatchPromoteHooks(rc, result, deps);
  return result.response;
}

/** The `logToPosthog` event whose message is the partial-skipped signal. */
function partialSkippedLog(): Record<string, unknown> | undefined {
  const call = vi
    .mocked(logToPosthog)
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

/** The `logToPosthog` event whose message is the stale-supabaseId signal (AECI-568). */
function staleIdLog(): Record<string, unknown> | undefined {
  const call = vi
    .mocked(logToPosthog)
    .mock.calls.find(
      (c) => (c[3] as { message?: string })?.message === 'aeci.api.promote.stale_supabase_id',
    );
  return call?.[3] as Record<string, unknown> | undefined;
}

/** All `aeci.api.promote.stale_id` count submissions as `[value, tags]` pairs. */
function staleIdMetricCalls(): Array<{ value: number; tags: string[] }> {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((c) => c[3] === 'aeci.api.promote.stale_id')
    .map((c) => ({ value: c[4] as number, tags: c[5] as string[] }));
}

describe('promote skip observability', () => {
  it('logs partial_skipped with per-kind detail + emits a skipped count per kind', async () => {
    const response = await promote({
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

    expect(response.skipped).toHaveLength(3);

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

    const response = await promote({
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        { ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: existing } },
      ],
    });

    expect(response.skipped).toHaveLength(0);
    expect(partialSkippedLog()).toBeUndefined();
    expect(skippedMetricCalls()).toHaveLength(0);
    expect(staleIdLog()).toBeUndefined();
    expect(staleIdMetricCalls()).toHaveLength(0);
  });
});

/**
 * AECI-568. A `supabaseId` whose row is gone now falls back to a create instead of a
 * no-op update. That is the right repair, but it is silent from the outside — the
 * response just says `created` — so the fallback carries its own warn log + count, the
 * only signal that the review app is holding a dead pointer.
 */
describe('promote stale-supabaseId observability', () => {
  it('logs stale_supabase_id with per-kind detail + emits a stale_id count per kind', async () => {
    const goneVendor = uuid(7);
    const goneProduct = uuid(8);

    await promote({
      vendors: [{ ref: 'v1', supabaseId: goneVendor, companyName: 'Autodesk' }],
      product: { ref: 'p1', supabaseId: goneProduct, name: 'Revit' },
      integrations: [],
    });

    const log = staleIdLog();
    expect(log).toMatchObject({
      level: 'warn',
      source: 'review-app-promote',
      outcome: 'recreated',
      stale_id_count: 2,
      stale_vendor: 1,
      stale_product: 1,
    });
    expect(log!.stale_supabase_ids).toEqual([
      { kind: 'vendor', ref: 'v1', supabaseId: goneVendor },
      { kind: 'product', ref: 'p1', supabaseId: goneProduct },
    ]);

    const metrics = staleIdMetricCalls();
    expect(metrics).toContainEqual({ value: 1, tags: ['source:promote', 'kind:vendor'] });
    expect(metrics).toContainEqual({ value: 1, tags: ['source:promote', 'kind:product'] });
  });
});

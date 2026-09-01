/**
 * Promote ingest — Datadog observability for `skipped[]` (§4). A promote can succeed
 * while silently NOT linking some entities (an integration whose far endpoint isn't
 * promoted, a usefulness group that didn't resolve, …). Neither the metrics layer nor a
 * `status: 'complete'` poll response reveals that, so the ingest emits a `warn` log + an
 * `aeci.api.promote.skipped` count so the partial loss is visible in Datadog alone
 * (docs/REVIEW_APP_PROMOTE_API.md §6). The transport is mocked here to assert the
 * exact log payload + metric tags.
 */

import { PromotePayloadSchema, type PromoteResponse } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { products } from '../db/schema';
import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import {
  dispatchPromoteHooks,
  runPromoteIngest,
  type PromoteAlgoliaSync,
  type PromoteHomeStatsRefresh,
  type PromoteIndexNowNotify,
  type PromoteRunCtx,
} from './promote';

vi.mock('../datadog', () => ({
  logToDatadog: vi.fn(),
  logBatchToDatadog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const noop = async () => {};
const noopAlgolia: PromoteAlgoliaSync = noop;
const noopIndexNow: PromoteIndexNowNotify = noop;
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
    refreshHomeStats: noopHomeStats,
  };
  const result = await runPromoteIngest(rc, PromotePayloadSchema.parse(body), deps);
  dispatchPromoteHooks(rc, result, deps);
  return result.response;
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

/** The `logToDatadog` event whose message is the stale-supabaseId signal (AECI-568). */
function staleIdLog(): Record<string, unknown> | undefined {
  const call = vi
    .mocked(logToDatadog)
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

/** The `logToDatadog` event whose message is the unresolved-link signal (AECI-730). */
function unresolvedLinkLog(): Record<string, unknown> | undefined {
  const call = vi
    .mocked(logToDatadog)
    .mock.calls.find(
      (c) => (c[3] as { message?: string })?.message === 'aeci.api.promote.unresolved_link',
    );
  return call?.[3] as Record<string, unknown> | undefined;
}

/** All `aeci.api.promote.unresolved_link` count submissions as `[value, tags]` pairs. */
function unresolvedLinkMetricCalls(): Array<{ value: number; tags: string[] }> {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((c) => c[3] === 'aeci.api.promote.unresolved_link')
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
    expect(unresolvedLinkLog()).toBeUndefined();
    expect(unresolvedLinkMetricCalls()).toHaveLength(0);
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

/**
 * AECI-730. An unresolvable `poweredByProduct` / `builtByVendor` writes the integration
 * WITHOUT that column — a partial write that no existing signal covered: it is not a
 * `skipped[]` entry (the row landed), not a stale id, and not an error.
 *
 * The severity split is the contract here, not an implementation detail. Zapier and
 * Workato are parked permanently (AECI-700), so this fires on routine promotes forever;
 * logging it at `warn` or folding it into `aeci.api.promote.skipped` would make the
 * "something wasn't written" signal permanently dirty, which is the noise the issue
 * exists to avoid.
 */
describe('promote unresolved-link observability (AECI-730)', () => {
  it('logs unresolved_link at INFO with per-field detail + a count per field', async () => {
    const target = uuid(1);
    await t.db.insert(products).values({
      id: target,
      slug: 'navisworks',
      name: 'Navisworks',
      promotionStatus: 'promoted',
    });

    const response = await promote({
      vendors: [],
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          // Neither is promoted — the connector-parked and dead-vendor-pointer cases.
          poweredByProduct: { supabaseId: uuid(9) },
          builtByVendor: { supabaseId: uuid(8) },
        },
      ],
    });

    // The integration itself landed, so `skipped[]` stays empty — and so does its log.
    expect(response.skipped).toHaveLength(0);
    expect(partialSkippedLog()).toBeUndefined();
    expect(skippedMetricCalls()).toHaveLength(0);

    const log = unresolvedLinkLog();
    expect(log).toMatchObject({
      level: 'info',
      source: 'review-app-promote',
      outcome: 'unlinked',
      unresolved_link_count: 2,
      unresolved_powered_by: 1,
      unresolved_built_by: 1,
    });
    expect(log!.unresolved_links).toHaveLength(2);

    const metrics = unresolvedLinkMetricCalls();
    expect(metrics).toContainEqual({ value: 1, tags: ['source:promote', 'field:powered_by'] });
    expect(metrics).toContainEqual({ value: 1, tags: ['source:promote', 'field:built_by'] });
  });

  it('tolerates a pre-AECI-730 response with no `unresolvedLinks` key', async () => {
    // An AECI-571 replay returns the ledger's stored response verbatim, and a row
    // written before this change has no such key. `dispatchPromoteHooks` runs AFTER
    // the commit, outside any catch, so a throw here would fail an already-committed
    // promote for the length of the deploy window.
    const rc: PromoteRunCtx = {
      env: baseEnv,
      request: new Request('http://localhost:8787/api/promote'),
      waitUntil: () => {},
      bookmark: () => null,
    };
    const legacyResponse = {
      vendors: [],
      product: null,
      integrations: [],
      taxonomy: { categories: [], audiences: [], phases: [], trades: [] },
      skipped: [],
    } as PromoteResponse;

    expect(() =>
      dispatchPromoteHooks(
        rc,
        {
          response: legacyResponse,
          removedTradeSlugs: [],
          wrote: false,
          bookmark: null,
          auditEntries: [],
          staleSupabaseIds: [],
        },
        {
          dbFor: t.factory,
          syncAlgolia: noopAlgolia,
          notifyIndexNow: noopIndexNow,
          refreshHomeStats: noopHomeStats,
        },
      ),
    ).not.toThrow();
    expect(unresolvedLinkLog()).toBeUndefined();
  });
});

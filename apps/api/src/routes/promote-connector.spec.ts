/**
 * `runConnectorCatalogIngest` — the AECI-714 arm of the promote family.
 *
 * The planner's own SQL is covered in `lib/promote-connector-catalog.spec.ts`. What
 * matters here is the ADR 0021 machinery around it: the ledger-first batch, the
 * exactly-once replay, and — the case a future refactor is most likely to break — that
 * this arm dispatches almost none of the product arm's post-commit hooks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PromoteConnectorPagePayload } from '@aeci/shared';
import { PromoteConnectorPagePayloadSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, connectorStubs, products, promoteJobs } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import type { PromoteRunCtx } from './promote';
import { dispatchConnectorHooks, runConnectorCatalogIngest } from './promote-connector';

const CONNECTOR_ID = '11111111-1111-4111-8111-111111111111';
const CATALOG_ID = 'rec76C362381D6CDF';
const STAMPS = { firstSeenAt: '2026-08-27T06:10:37.867Z', lastSeenAt: '2026-08-27T06:11:54.977Z' };
const JOB_ID = 'connector-page-0001';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

function page(overrides: Record<string, unknown> = {}): PromoteConnectorPagePayload {
  return PromoteConnectorPagePayloadSchema.parse({
    catalog: { id: CATALOG_ID, connectorProductId: CONNECTOR_ID },
    page: { index: 0, of: 1 },
    stubs: [{ id: 'recStubProcore01', slug: 'procore', label: 'Procore', ...STAMPS }],
    ...overrides,
  });
}

function runCtx(): PromoteRunCtx {
  return {
    env: { ENV: 'preview' } as Env,
    request: new Request('https://api.test/api/promote/connector-catalog'),
    waitUntil: () => {},
    bookmark: () => null,
  };
}

async function seedConnector() {
  await t.db
    .insert(products)
    .values({ id: CONNECTOR_ID, slug: 'mindcloud', name: 'MindCloud', productRole: 'connector' });
}

const deps = () => ({ dbFor: () => t.dbCtx });

describe('runConnectorCatalogIngest (AECI-714)', () => {
  it('commits the page, its ledger row and ONE audit row in a single batch', async () => {
    await seedConnector();
    const result = await runConnectorCatalogIngest(runCtx(), page(), deps(), { jobId: JOB_ID });

    expect(result.response.kind).toBe('connector');
    expect(result.response.counts.stubs.created).toBe(1);
    expect(result.wrote).toBe(true);
    expect((await t.db.select().from(connectorStubs)).length).toBe(1);

    const ledger = await t.db.query.promoteJobs.findFirst({
      where: eq(promoteJobs.jobId, JOB_ID),
    });
    expect((ledger?.result as { kind?: string })?.kind).toBe('connector');

    // §26.1: exactly one summary row, in the same batch as the rows it describes.
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('connector_catalog.synced');
    expect(audits[0]?.entityId).toBe(CATALOG_ID);
    // The counts and the page cursor ARE the row's content — a summary row that carried
    // only the shared `source` facet would satisfy §26.1's letter and none of its purpose,
    // and that is exactly what a naive `metadata: AUDIT_META` assignment produces.
    const meta = audits[0]?.metadata as Record<string, unknown>;
    expect(meta.source).toBe('review-app-promote');
    expect(meta.page).toEqual({ index: 0, of: 1 });
    expect((meta.counts as { stubs: { created: number } }).stubs.created).toBe(1);
  });

  it('replays a committed job from its ledger instead of committing again', async () => {
    await seedConnector();
    await runConnectorCatalogIngest(runCtx(), page(), deps(), { jobId: JOB_ID });

    // A Workflow step is at-least-once. The second run must not write a second audit
    // row, and must return the ORIGINAL counts rather than the "everything unchanged"
    // a re-plan would honestly produce.
    const replay = await runConnectorCatalogIngest(runCtx(), page(), deps(), { jobId: JOB_ID });
    expect(replay.response.counts.stubs.created).toBe(1);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
    expect(await t.db.select().from(promoteJobs)).toHaveLength(1);
  });

  it('writes its ledger row even when the page changed nothing, but no audit row', async () => {
    await seedConnector();
    await runConnectorCatalogIngest(runCtx(), page(), deps(), { jobId: JOB_ID });

    // The asymmetry is deliberate: rule 4 governs the AUDIT row, not the exactly-once
    // guard. Dropping the ledger on a no-op would break "same jobId → same answer" the
    // moment a review-side change landed between two sends of one id.
    const second = await runConnectorCatalogIngest(runCtx(), page(), deps(), {
      jobId: 'connector-page-0002',
    });
    expect(second.wrote).toBe(false);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
    expect(await t.db.select().from(promoteJobs)).toHaveLength(2);
  });

  it('refuses to describe a committed job whose ledger is unreadable', async () => {
    await seedConnector();
    // A product-shaped ledger under a connector job id: the commit HAPPENED, so
    // re-planning would report the wrong counts and returning it would be the wrong
    // shape entirely. Failing loudly is the only honest answer.
    await t.db.insert(promoteJobs).values({ jobId: JOB_ID, result: { v: 1, response: {} } });
    await expect(
      runConnectorCatalogIngest(runCtx(), page(), deps(), { jobId: JOB_ID }),
    ).rejects.toThrow(/already committed/);
  });

  it('commits without a ledger row when no job id is supplied', async () => {
    await seedConnector();
    const result = await runConnectorCatalogIngest(runCtx(), page(), deps());
    expect(result.wrote).toBe(true);
    expect(await t.db.select().from(promoteJobs)).toHaveLength(0);
  });

  it('reaches no count, index, URL or cache surface — a source guard, not a mock', async () => {
    // The executable form of the "two hooks, not seven" decision, written as a source
    // guard for the same reason the `vendor_entitlements` no-read-path check is: a
    // spy only proves the hook did not fire on THIS input, while the thing worth
    // preventing is someone wiring this arm into `dispatchPromoteHooks` wholesale.
    // §13.5 is categorical — reachable data never counts, anywhere.
    // Comments stripped first: the module's own doc block NAMES the hooks it does not
    // use, and explaining an absence must not trip the guard against it.
    const source = readFileSync(join(process.cwd(), 'src/routes/promote-connector.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      'syncAlgolia',
      'syncPromoteTargets',
      'notifyIndexNow',
      'notifyGoogleIndexing',
      'refreshHomeStats',
      'cacheTagsForPromote',
      'CACHE_PURGE_QUEUE',
      'recomputeProductCounts',
      'connectorEvidencedPairs',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    // And the two that DO apply are present, so the guard cannot pass vacuously.
    expect(source).toContain('logBatchToPosthog');
    expect(source).toContain('logPromoteSkips');
    expect(typeof dispatchConnectorHooks).toBe('function');
  });
});

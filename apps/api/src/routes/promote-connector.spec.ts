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
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, recordingFactory, type TestDb } from '../test/d1';
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

  it('reaches no count, index or URL surface — a source guard, not a mock', async () => {
    // The executable form of the "two hooks, not seven" decision, written as a source
    // guard for the same reason the `vendor_entitlements` no-read-path check is: a
    // spy only proves the hook did not fire on THIS input, while the thing worth
    // preventing is someone wiring this arm into `dispatchPromoteHooks` wholesale.
    // §13.5 is categorical — reachable data never counts, anywhere.
    //
    // AECI-892 removed `CACHE_PURGE_QUEUE` and `cacheTagsForPromote` from this list
    // and no others. The cache absence was always conditional — "no cacheable route
    // depends on these rows YET" — and §13.7's reach line is the first public reader.
    // The count, index and URL absences are not conditional and stay.
    //
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
      // The PRODUCT arm's tag deriver. This arm has its own, and borrowing that one
      // would emit `pair:*` and `sitemap`, both of which §13.7 forbids.
      'cacheTagsForPromote',
      'recomputeProductCounts',
      'connectorEvidencedPairs',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    // And the three that DO apply are present, so the guard cannot pass vacuously.
    expect(source).toContain('logBatchToPosthog');
    expect(source).toContain('logPromoteSkips');
    expect(source).toContain('cacheTagsForConnectorPage');
    expect(typeof dispatchConnectorHooks).toBe('function');
  });
});

/**
 * The reach-line cache purge (AECI-892).
 *
 * `CACHE_STRATEGY.md` §3 rule 5 parked this obligation when AECI-714 landed and said
 * in terms that it *"transfers to whichever issue first renders them"*. These assert
 * the transfer arrived with the constraints attached, not just the enqueue:
 *
 *  - a page that changed nothing purges nothing, so a re-sync of six catalogues does
 *    not repaint the whole catalog every night;
 *  - the tags are `product:*` and nothing else. `pair:*` would purge a page §13.7
 *    forbids building, and `sitemap` would repaint `sitemap.xml` once per page of a
 *    30-page run for URLs that do not exist;
 *  - a pair row moving purges BOTH its endpoints, which is the case a mapping-only
 *    collector misses — AECI-890 wrote 669 pair rows and not one mapping.
 */
describe('dispatchConnectorHooks — the reach-line purge', () => {
  function queueEnv() {
    const sent: { tags: string[]; source: string }[] = [];
    const env = {
      ENV: 'preview',
      CACHE_PURGE_QUEUE: {
        sendBatch: async (msgs: { body: { tags: string[]; source: string } }[]) => {
          for (const m of msgs) sent.push(m.body);
        },
      },
    } as unknown as Env;
    return { env, sent };
  }

  async function flush(
    env: Env,
    purgeProductIds: string[],
    over: { dbFor?: DbFactory; bookmark?: string | null } = {},
  ) {
    const tasks: Promise<unknown>[] = [];
    const rc: PromoteRunCtx = {
      env,
      request: new Request('https://api.test/api/promote/connector-catalog'),
      waitUntil: (p: Promise<unknown>) => tasks.push(p),
      bookmark: () => over.bookmark ?? null,
    };
    dispatchConnectorHooks(
      rc,
      {
        response: {
          kind: 'connector',
          catalogId: CATALOG_ID,
          page: { index: 0, of: 1 },
          counts: {
            catalogs: zeroCounts(),
            surfaces: zeroCounts(),
            stubs: zeroCounts(),
            mappings: zeroCounts(),
            pairs: zeroCounts(),
            claims: zeroCounts(),
          },
          skipped: [],
        },
        wrote: purgeProductIds.length > 0,
        bookmark: null,
        auditEntries: [],
        purgeProductIds,
      },
      // The in-memory D1 harness, injected the same way the commit step takes it.
      { dbFor: over.dbFor ?? t.factory },
    );
    await Promise.all(tasks);
  }

  const zeroCounts = () => ({ created: 0, updated: 0, unchanged: 0, deleted: 0, skipped: 0 });

  it('enqueues product tags for the moved endpoints', async () => {
    await seedConnector();
    await t.db.insert(products).values([
      { id: '22222222-2222-4222-8222-222222222222', slug: 'procore', name: 'Procore' },
      { id: '33333333-3333-4333-8333-333333333333', slug: 'sage-intacct', name: 'Sage Intacct' },
    ]);
    const { env, sent } = queueEnv();
    await flush(env, [
      CONNECTOR_ID,
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ]);
    expect(sent).toHaveLength(1);
    expect([...sent[0]!.tags].sort()).toEqual([
      'product:mindcloud',
      'product:procore',
      'product:sage-intacct',
    ]);
  });

  it('resumes the write session for the slug read, rather than reading unconstrained', async () => {
    // The one anchor this read must not take is the default. With no `opts` it
    // resolves to `first-unconstrained`, and once D1 read replication is enabled a
    // product a recent promote created is simply absent from the SELECT — its
    // `product:{slug}` tag is dropped and nothing is logged on either side. The
    // product arm's post-commit reads anchor on `rc.bookmark()` for exactly this
    // reason (AECI-250); this asserts the connector arm does too.
    await seedConnector();
    const rec = recordingFactory(t.db);
    const { env, sent } = queueEnv();
    await flush(env, [CONNECTOR_ID], { dbFor: rec.factory, bookmark: 'bm-after-commit' });
    expect(rec.calls).toEqual([{ bookmark: 'bm-after-commit' }]);
    expect(sent[0]!.tags).toEqual(['product:mindcloud']);
  });

  it('enqueues NOTHING for a page that changed nothing', async () => {
    const { env, sent } = queueEnv();
    await flush(env, []);
    expect(sent).toEqual([]);
  });

  it('never emits `pair:*` or `sitemap`', async () => {
    await seedConnector();
    const { env, sent } = queueEnv();
    await flush(env, [CONNECTOR_ID]);
    const tags = sent.flatMap((m) => m.tags);
    expect(tags.some((tag) => tag.startsWith('pair:'))).toBe(false);
    expect(tags).not.toContain('sitemap');
    expect(tags.every((tag) => tag.startsWith('product:'))).toBe(true);
  });
});

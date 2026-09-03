import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import app from './index';
import { makeShimDb, type ShimHandle } from './test/d1';
import { seedCatalog, seedProducts } from './test/seed-fixture';

const TOKEN = 'test-tool-token';
const CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe('datatool routes', () => {
  let preview: ShimHandle;
  let staging: ShimHandle;
  let demo: ShimHandle;
  let production: ShimHandle;
  let env: Record<string, unknown>;

  beforeEach(() => {
    preview = makeShimDb();
    staging = makeShimDb();
    demo = makeShimDb();
    production = makeShimDb();
    // No Algolia/CF creds → the post-write refresh gracefully skips (no network).
    env = {
      DB_PREVIEW: preview.db,
      DB_STAGING: staging.db,
      DB_DEMO: demo.db,
      DB_PRODUCTION: production.db,
      TOOL_TOKEN: TOKEN,
      ACCESS_AUD: 'aud',
      ACCESS_TEAM_DOMAIN: 'REPLACE_WITH_TEAM.cloudflareaccess.com',
    };
  });
  afterEach(() => {
    preview.dispose();
    staging.dispose();
    demo.dispose();
    production.dispose();
  });

  function call(path: string, body: unknown, token?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return app.fetch(
      new Request('http://tool.local' + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
      env,
      CTX,
    );
  }

  it('403s the API without auth, serves the UI ungated', async () => {
    const denied = await call('/api/copy', { source: 'preview', dest: 'staging', dryRun: true });
    expect(denied.status).toBe(403);

    const ui = await app.fetch(new Request('http://tool.local/'), env, CTX);
    expect(ui.status).toBe(200);
    expect((await ui.text()).includes('AECi datatool')).toBe(true);
    expect(ui.headers.get('Cache-Control')).toBe('no-store');
  });

  it('copy dry-run reports counts without writing (authed via tool token)', async () => {
    seedCatalog(preview.raw);
    const res = await call(
      '/api/copy',
      { source: 'preview', dest: 'staging', dryRun: true },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      dryRun: boolean;
      tables: { table: string; sourceRows: number }[];
    };
    expect(json.dryRun).toBe(true);
    expect(json.tables.find((t) => t.table === 'products')!.sourceRows).toBe(2);
    expect(
      (staging.raw.prepare('SELECT count(*) AS n FROM products').get() as { n: number }).n,
    ).toBe(0);
  });

  it('rejects execute without the typed confirmation', async () => {
    seedCatalog(preview.raw);
    const res = await call(
      '/api/copy',
      { source: 'preview', dest: 'staging', dryRun: false },
      TOKEN,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFIRM_MISMATCH');
  });

  it('executes a confirmed copy and skips refresh when no Algolia/CF creds', async () => {
    seedCatalog(preview.raw);
    const res = await call(
      '/api/copy',
      { source: 'preview', dest: 'staging', dryRun: false, confirmName: 'aeci-app-staging' },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      executed: boolean;
      refresh: { reindex: { skipped: boolean } };
    };
    expect(json.executed).toBe(true);
    expect(
      (staging.raw.prepare('SELECT count(*) AS n FROM products').get() as { n: number }).n,
    ).toBe(2);
    expect(json.refresh.reindex.skipped).toBe(true);
  });

  it('routes a confirmed copy to the demo DB with only the typed confirm (no prod double-confirm)', async () => {
    seedCatalog(preview.raw);
    const res = await call(
      '/api/copy',
      { source: 'preview', dest: 'demo', dryRun: false, confirmName: 'aeci-app-demo' },
      TOKEN,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { executed: boolean }).executed).toBe(true);
    // Wrote to demo, not staging/production.
    expect((demo.raw.prepare('SELECT count(*) AS n FROM products').get() as { n: number }).n).toBe(
      2,
    );
    expect(
      (staging.raw.prepare('SELECT count(*) AS n FROM products').get() as { n: number }).n,
    ).toBe(0);
  });

  it('requires the production double-confirm', async () => {
    seedCatalog(preview.raw);
    const res = await call(
      '/api/copy',
      { source: 'preview', dest: 'production', dryRun: false, confirmName: 'aeci-app-production' },
      TOKEN,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'PROD_CONFIRM_REQUIRED',
    );
    expect(
      (production.raw.prepare('SELECT count(*) AS n FROM products').get() as { n: number }).n,
    ).toBe(0);
  });

  it('seeds reviews into a confirmed target', async () => {
    seedProducts(staging.raw, 12);
    const dry = await call(
      '/api/seed',
      { target: 'staging', action: 'apply', dryRun: true },
      TOKEN,
    );
    const drySummary = (await dry.json()) as { summary: { totalReviews: number } };
    expect(drySummary.summary.totalReviews).toBeGreaterThan(0);

    const res = await call(
      '/api/seed',
      { target: 'staging', action: 'apply', dryRun: false, confirmName: 'aeci-app-staging' },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const seeded = (
      staging.raw.prepare("SELECT count(*) AS n FROM reviews WHERE id LIKE 'aeceed00-%'").get() as {
        n: number;
      }
    ).n;
    expect(seeded).toBe(((await res.json()) as { inserted: number }).inserted);
    expect(seeded).toBeGreaterThan(0);
  });

  it('400s a seed when the target has no products', async () => {
    const res = await call(
      '/api/seed',
      { target: 'staging', action: 'apply', dryRun: true },
      TOKEN,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NO_PRODUCTS');
  });

  it('standalone reindex returns ok and skips without creds', async () => {
    seedCatalog(staging.raw);
    const res = await call('/api/reindex', { target: 'staging' }, TOKEN);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; reindex: { skipped: boolean } };
    expect(json.ok).toBe(true);
    expect(json.reindex.skipped).toBe(true);
  });

  // ── WC-7 (AECI-321): post-write cache purge via the per-tier queue producer ──────

  /** A mock cache-purge Queue producer capturing every `send()`. */
  function queueSpy() {
    return { send: vi.fn().mockResolvedValue(undefined) };
  }

  it('standalone reindex enqueues a purgeEverything message to the target tier queue', async () => {
    seedCatalog(staging.raw);
    const stagingQueue = queueSpy();
    env.CACHE_PURGE_QUEUE_STAGING = stagingQueue;

    const res = await call('/api/reindex', { target: 'staging' }, TOKEN);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { purge: { ok: boolean; enqueued: boolean } };
    expect(json.purge.enqueued).toBe(true);
    expect(stagingQueue.send).toHaveBeenCalledTimes(1);
    expect(stagingQueue.send).toHaveBeenCalledWith({ purgeEverything: true, source: 'datatool' });
  });

  it('routes the purge to only the target tier queue', async () => {
    seedCatalog(staging.raw);
    const stagingQueue = queueSpy();
    const demoQueue = queueSpy();
    env.CACHE_PURGE_QUEUE_STAGING = stagingQueue;
    env.CACHE_PURGE_QUEUE_DEMO = demoQueue;

    const res = await call('/api/reindex', { target: 'staging' }, TOKEN);
    expect(res.status).toBe(200);
    expect(stagingQueue.send).toHaveBeenCalledTimes(1);
    expect(demoQueue.send).not.toHaveBeenCalled();
  });

  it('gracefully skips the purge when the target tier has no queue producer', async () => {
    seedCatalog(preview.raw);
    // preview has no `aeci-cache-purge-preview` queue → no producer bound.
    const res = await call('/api/reindex', { target: 'preview' }, TOKEN);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { purge: { ok: boolean; enqueued: boolean } };
    expect(json.purge.ok).toBe(false);
    expect(json.purge.enqueued).toBe(false);
  });

  it('skips the purge enqueue when reindex requests purge:false', async () => {
    seedCatalog(staging.raw);
    const stagingQueue = queueSpy();
    env.CACHE_PURGE_QUEUE_STAGING = stagingQueue;

    const res = await call('/api/reindex', { target: 'staging', purge: false }, TOKEN);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { purge: unknown }).purge).toBeNull();
    expect(stagingQueue.send).not.toHaveBeenCalled();
  });

  it('a confirmed copy enqueues the destination tier purge', async () => {
    seedCatalog(preview.raw);
    const stagingQueue = queueSpy();
    env.CACHE_PURGE_QUEUE_STAGING = stagingQueue;

    const res = await call(
      '/api/copy',
      { source: 'preview', dest: 'staging', dryRun: false, confirmName: 'aeci-app-staging' },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { refresh: { purge: { enqueued: boolean } } };
    expect(json.refresh.purge.enqueued).toBe(true);
    expect(stagingQueue.send).toHaveBeenCalledWith({ purgeEverything: true, source: 'datatool' });
  });

  // ── Prune orphaned integrations ────────────────────────────────────────────

  /** Add an exact twin of the seeded `int-1` so the guards see a redundant copy. */
  function seedOrphanTwin(h: ShimHandle): string {
    const id = 'bbbbbbbb-0000-4000-8000-000000000002';
    h.raw
      .prepare(
        `INSERT INTO integrations (id, name, source_product_id, target_product_id, mechanism_kind, direction, created_at, updated_at)
         VALUES (?, 'Revit to AutoCAD', 'prod-1', 'prod-2', 'native', 'one-way', ?, ?)`,
      )
      .run(id, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    return id;
  }

  it('prune dry-run reports the footprint + rollback SQL without writing', async () => {
    seedCatalog(staging.raw);
    const orphan = seedOrphanTwin(staging);

    const res = await call('/api/prune-integrations', { target: 'staging', ids: orphan }, TOKEN);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      dryRun: boolean;
      found: number;
      blocked: string[];
      affectedSlugs: string[];
      rollbackSql: string;
    };
    expect(json.dryRun).toBe(true);
    expect(json.found).toBe(1);
    expect(json.blocked).toEqual([]);
    expect(json.affectedSlugs.sort()).toEqual(['autocad', 'revit']);
    expect(json.rollbackSql).toContain('INSERT OR IGNORE INTO "integrations"');
    // Nothing written.
    expect(staging.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 2 });
  });

  it('400s a malformed id list', async () => {
    seedCatalog(staging.raw);
    const res = await call(
      '/api/prune-integrations',
      { target: 'staging', ids: 'not-a-uuid' },
      TOKEN,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BAD_IDS');
  });

  it('409s the execute path when a guard trips, even with a valid confirmation', async () => {
    seedCatalog(staging.raw);
    const orphan = seedOrphanTwin(staging);
    // Remove the twin, so the remaining row is the ONLY copy of that
    // (source, target, mechanism) — `orphansWithoutATwin` must fire and block.
    staging.raw.prepare('DELETE FROM integrations WHERE id = ?').run('int-1');

    const res = await call(
      '/api/prune-integrations',
      { target: 'staging', ids: orphan, dryRun: false, confirmName: 'aeci-app-staging' },
      TOKEN,
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('GUARD_TRIPPED');
    // The guard is the last gate before an irreversible delete: nothing was removed.
    expect(staging.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 1 });
  });

  // ── Overriding a tripped guard (AECI-593) ──────────────────────────────────
  //
  // A curator can editorially retract an edge — delete the Airtable record on
  // purpose — which strands the live D1 row with no twin. Deleting it is correct
  // but must be deliberate, so the acknowledged set has to equal the tripped set
  // exactly and carry a reason.

  /** Leaves `orphan` as the only copy of its (source, target, mechanism): both guards trip. */
  function seedNoTwinOrphan(h: ShimHandle): string {
    seedCatalog(h.raw);
    const orphan = seedOrphanTwin(h);
    h.raw
      .prepare(
        "INSERT INTO taxonomy_data_objects (id, slug, name, display_order, created_at, updated_at) VALUES ('do-1','rfis','RFIs',10,?,?)",
      )
      .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    h.raw
      .prepare(
        "INSERT INTO claims (id, integration_id, data_object_id, direction, created_at, updated_at) VALUES ('claim-orphan', ?, 'do-1', 'a_to_b', ?, ?)",
      )
      .run(orphan, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    h.raw.prepare('DELETE FROM integrations WHERE id = ?').run('int-1');
    return orphan;
  }

  const REASON = 'AECI-593: curator retracted this edge in Airtable on 2026-08-09.';

  it('deletes when every tripped guard is acknowledged with a reason', async () => {
    const orphan = seedNoTwinOrphan(staging);

    const dry = await call('/api/prune-integrations', { target: 'staging', ids: orphan }, TOKEN);
    const blocked = ((await dry.json()) as { blocked: string[] }).blocked;
    expect(blocked.sort()).toEqual(['claimsUniqueToOrphans', 'orphansWithoutATwin']);

    const res = await call(
      '/api/prune-integrations',
      {
        target: 'staging',
        ids: orphan,
        dryRun: false,
        confirmName: 'aeci-app-staging',
        acknowledgeGuards: blocked,
        acknowledgeReason: REASON,
      },
      TOKEN,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      executed: boolean;
      deleted: { integrations: number; claims: number };
      acknowledgedGuards: string[];
      acknowledgeReason: string;
    };
    expect(json.executed).toBe(true);
    expect(json.deleted).toMatchObject({ integrations: 1, claims: 1 });
    // Echoed back so the operator's own record of the run carries the override.
    expect(json.acknowledgedGuards.sort()).toEqual([
      'claimsUniqueToOrphans',
      'orphansWithoutATwin',
    ]);
    expect(json.acknowledgeReason).toBe(REASON);
    expect(staging.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 0 });
  });

  it('409s when only some of the tripped guards are acknowledged', async () => {
    const orphan = seedNoTwinOrphan(staging);

    const res = await call(
      '/api/prune-integrations',
      {
        target: 'staging',
        ids: orphan,
        dryRun: false,
        confirmName: 'aeci-app-staging',
        acknowledgeGuards: ['orphansWithoutATwin'],
        acknowledgeReason: REASON,
      },
      TOKEN,
    );

    expect(res.status).toBe(409);
    const err = (await res.json()) as { error: { code: string; message: string } };
    expect(err.error.code).toBe('GUARD_TRIPPED');
    expect(err.error.message).toContain('claimsUniqueToOrphans');
    expect(staging.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 1 });
  });

  it('400s when acknowledging a guard that reads zero (the plan is stale)', async () => {
    const orphan = seedNoTwinOrphan(staging);

    const res = await call(
      '/api/prune-integrations',
      {
        target: 'staging',
        ids: orphan,
        dryRun: false,
        confirmName: 'aeci-app-staging',
        acknowledgeGuards: [
          'claimsUniqueToOrphans',
          'orphansWithoutATwin',
          'orphansRicherThanTwin',
        ],
        acknowledgeReason: REASON,
      },
      TOKEN,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('GUARD_ACK_STALE');
    expect(staging.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 1 });
  });

  it('400s an acknowledgment on a plan where nothing tripped', async () => {
    seedCatalog(staging.raw);
    const orphan = seedOrphanTwin(staging); // twin survives → all guards read zero

    const res = await call(
      '/api/prune-integrations',
      {
        target: 'staging',
        ids: orphan,
        dryRun: false,
        confirmName: 'aeci-app-staging',
        acknowledgeGuards: ['orphansWithoutATwin'],
        acknowledgeReason: REASON,
      },
      TOKEN,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('GUARD_ACK_STALE');
    expect(staging.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 2 });
  });

  it('400s an override with no reason — the log line is the only audit trail', async () => {
    const orphan = seedNoTwinOrphan(staging);

    const res = await call(
      '/api/prune-integrations',
      {
        target: 'staging',
        ids: orphan,
        dryRun: false,
        confirmName: 'aeci-app-staging',
        acknowledgeGuards: ['claimsUniqueToOrphans', 'orphansWithoutATwin'],
        acknowledgeReason: 'ok',
      },
      TOKEN,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'ACK_REASON_REQUIRED',
    );
    expect(staging.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 1 });
  });

  it('400s an unknown guard name', async () => {
    const orphan = seedNoTwinOrphan(staging);

    const res = await call(
      '/api/prune-integrations',
      {
        target: 'staging',
        ids: orphan,
        dryRun: false,
        confirmName: 'aeci-app-staging',
        acknowledgeGuards: ['noSuchGuard'],
        acknowledgeReason: REASON,
      },
      TOKEN,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BAD_ACK_GUARDS');
  });

  it('still requires prodConfirm when guards are acknowledged on production', async () => {
    const orphan = seedNoTwinOrphan(production);

    const res = await call(
      '/api/prune-integrations',
      {
        target: 'production',
        ids: orphan,
        dryRun: false,
        confirmName: 'aeci-app-production',
        acknowledgeGuards: ['claimsUniqueToOrphans', 'orphansWithoutATwin'],
        acknowledgeReason: REASON,
      },
      TOKEN,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'PROD_CONFIRM_REQUIRED',
    );
    expect(production.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({
      n: 1,
    });
  });

  it('requires the typed DB name to execute', async () => {
    seedCatalog(staging.raw);
    const orphan = seedOrphanTwin(staging);
    const res = await call(
      '/api/prune-integrations',
      { target: 'staging', ids: orphan, dryRun: false, confirmName: 'wrong' },
      TOKEN,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFIRM_MISMATCH');
  });

  it('requires prodConfirm on production', async () => {
    seedCatalog(production.raw);
    const orphan = seedOrphanTwin(production);
    const res = await call(
      '/api/prune-integrations',
      { target: 'production', ids: orphan, dryRun: false, confirmName: 'aeci-app-production' },
      TOKEN,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'PROD_CONFIRM_REQUIRED',
    );
  });

  it('executes, repairs integration_count, and returns rollback SQL', async () => {
    seedCatalog(staging.raw);
    const orphan = seedOrphanTwin(staging);
    // Counts start at the fixture's (now stale) value of 1 each; the twin makes 2.
    staging.raw.prepare('UPDATE products SET integration_count = 2').run();

    const res = await call(
      '/api/prune-integrations',
      { target: 'staging', ids: orphan, dryRun: false, confirmName: 'aeci-app-staging' },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      executed: boolean;
      deleted: { integrations: number };
      recounted: { productId: string; from: number; to: number }[];
      rollbackSql: string;
    };
    expect(json.executed).toBe(true);
    expect(json.deleted.integrations).toBe(1);
    expect(json.recounted).toHaveLength(2);
    expect(json.recounted.every((r) => r.from === 2 && r.to === 1)).toBe(true);
    expect(json.rollbackSql).toContain(orphan);

    expect(staging.raw.prepare('SELECT id FROM integrations').all()).toEqual([{ id: 'int-1' }]);
    expect(
      staging.raw.prepare('SELECT integration_count AS c FROM products ORDER BY slug').all(),
    ).toEqual([{ c: 1 }, { c: 1 }]);
  });
});

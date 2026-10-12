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
  let staging: ShimHandle;
  let demo: ShimHandle;
  let production: ShimHandle;
  let env: Record<string, unknown>;

  beforeEach(() => {
    staging = makeShimDb();
    demo = makeShimDb();
    production = makeShimDb();
    // No Algolia/CF creds → the post-write refresh gracefully skips (no network).
    env = {
      DB_STAGING: staging.db,
      DB_DEMO: demo.db,
      DB_PRODUCTION: production.db,
      TOOL_TOKEN: TOKEN,
      ACCESS_AUD: 'aud',
      ACCESS_TEAM_DOMAIN: 'REPLACE_WITH_TEAM.cloudflareaccess.com',
    };
  });
  afterEach(() => {
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
    const denied = await call('/api/copy', { source: 'production', dest: 'staging', dryRun: true });
    expect(denied.status).toBe(403);

    const ui = await app.fetch(new Request('http://tool.local/'), env, CTX);
    expect(ui.status).toBe(200);
    expect((await ui.text()).includes('AECi datatool')).toBe(true);
    expect(ui.headers.get('Cache-Control')).toBe('no-store');
  });

  it('copy dry-run reports counts without writing (authed via tool token)', async () => {
    seedCatalog(production.raw);
    const res = await call(
      '/api/copy',
      { source: 'production', dest: 'staging', dryRun: true },
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
    seedCatalog(production.raw);
    const res = await call(
      '/api/copy',
      { source: 'production', dest: 'staging', dryRun: false },
      TOKEN,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFIRM_MISMATCH');
  });

  it('executes a confirmed copy and skips refresh when no Algolia/CF creds', async () => {
    seedCatalog(production.raw);
    const res = await call(
      '/api/copy',
      { source: 'production', dest: 'staging', dryRun: false, confirmName: 'aeci-app-staging' },
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
    seedCatalog(production.raw);
    const res = await call(
      '/api/copy',
      { source: 'production', dest: 'demo', dryRun: false, confirmName: 'aeci-app-demo' },
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
    seedCatalog(staging.raw);
    const res = await call(
      '/api/copy',
      { source: 'staging', dest: 'production', dryRun: false, confirmName: 'aeci-app-production' },
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
    seedCatalog(demo.raw);
    // No CACHE_PURGE_QUEUE_DEMO bound in this env → no producer for the target tier.
    const res = await call('/api/reindex', { target: 'demo' }, TOKEN);
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
    seedCatalog(production.raw);
    const stagingQueue = queueSpy();
    env.CACHE_PURGE_QUEUE_STAGING = stagingQueue;

    const res = await call(
      '/api/copy',
      { source: 'production', dest: 'staging', dryRun: false, confirmName: 'aeci-app-staging' },
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
         VALUES (?, 'Revit to AutoCAD', 'prod-1', 'prod-2', 'native', 'a_to_b', ?, ?)`,
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

  // ── Vendor-held rows (AECI-1005 / ADR 0035) ────────────────────────────────

  it('refuses a claimed row on the execute path, and no acknowledgment overrides it', async () => {
    seedCatalog(staging.raw);
    const orphan = seedOrphanTwin(staging);
    staging.raw
      .prepare('UPDATE integrations SET claimed_at = ? WHERE id = ?')
      .run('2026-09-21T00:00:00.000Z', orphan);

    const dry = await call('/api/prune-integrations', { target: 'staging', ids: orphan }, TOKEN);
    const plan = (await dry.json()) as { ok: boolean; vendorHeld: string[]; note: string };
    expect(plan.ok).toBe(false);
    expect(plan.vendorHeld).toEqual([orphan]);
    expect(plan.note).toMatch(/vendor-held/);

    const res = await call(
      '/api/prune-integrations',
      {
        target: 'staging',
        ids: orphan,
        dryRun: false,
        confirmName: 'aeci-app-staging',
        acknowledgeGuards: [],
        acknowledgeReason: 'trying to override the vendor-held refusal',
      },
      TOKEN,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VENDOR_HELD');
    expect(staging.raw.prepare('SELECT COUNT(*) AS n FROM integrations').get()).toEqual({ n: 2 });
  });

  it('refuses a vendor-created row the same way', async () => {
    seedCatalog(staging.raw);
    const orphan = seedOrphanTwin(staging);
    staging.raw.prepare(`UPDATE integrations SET origin = 'vendor' WHERE id = ?`).run(orphan);

    const res = await call(
      '/api/prune-integrations',
      { target: 'staging', ids: orphan, dryRun: false, confirmName: 'aeci-app-staging' },
      TOKEN,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VENDOR_HELD');
  });

  // ── Overriding a tripped guard (AECI-593) ──────────────────────────────────
  //
  // A curator can editorially retract an edge — delete the upstream record on
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

  const REASON = 'AECI-593: curator retracted this edge in the review app on 2026-08-09.';

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

  // ── AECI-1273: copy exclusions and the structured failure report ────────────────

  it('copy dry-run lists the excluded log tables with their source counts', async () => {
    seedCatalog(production.raw);
    production.raw
      .prepare(
        "INSERT INTO page_views (path, product_id, created_at) VALUES ('/products/:slug', 'prod-1', '2026-10-01T00:00:00.000Z')",
      )
      .run();
    const res = await call('/api/copy', { source: 'production', dest: 'staging' }, TOKEN);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      includeLogTables: boolean;
      tables: { table: string }[];
      excludedTables: { table: string; sourceRows: number }[];
    };
    expect(json.includeLogTables).toBe(false);
    expect(json.tables.map((t) => t.table)).not.toContain('page_views');
    expect(json.excludedTables.find((t) => t.table === 'page_views')!.sourceRows).toBe(1);

    const optIn = await call(
      '/api/copy',
      { source: 'production', dest: 'staging', includeLogTables: true },
      TOKEN,
    );
    const optJson = (await optIn.json()) as {
      excludedTables: unknown[];
      tables: { table: string }[];
    };
    expect(optJson.excludedTables).toEqual([]);
    expect(optJson.tables.map((t) => t.table)).toContain('page_views');
  });

  it('copy refuses with EXCLUDED_TABLE_REFERENCED when a reloaded table points at an excluded one', async () => {
    const ddl =
      'CREATE TABLE zz_child (id TEXT PRIMARY KEY, view_id INTEGER REFERENCES page_views(id))';
    production.raw.prepare(ddl).run();
    staging.raw.prepare(ddl).run();
    const res = await call('/api/copy', { source: 'production', dest: 'staging' }, TOKEN);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; detail: string[] } };
    expect(json.error.code).toBe('EXCLUDED_TABLE_REFERENCED');
    expect(json.error.detail.join(' ')).toContain('zz_child');
  });

  it('a failed copy returns COPY_FAILED with stage, table, rows written, and the D1 message', async () => {
    seedCatalog(production.raw);
    // An orphan product_vendors row: the staging FK rejects it on insert.
    production.raw.pragma('foreign_keys = OFF');
    production.raw
      .prepare(
        "INSERT INTO product_vendors (product_id, vendor_id, is_primary, created_at) VALUES ('prod-2', 'ven-missing', 0, 'x')",
      )
      .run();
    production.raw.pragma('foreign_keys = ON');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await call(
      '/api/copy',
      { source: 'production', dest: 'staging', dryRun: false, confirmName: 'aeci-app-staging' },
      TOKEN,
    );
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const json = (await res.json()) as {
      error: {
        code: string;
        message: string;
        stage: string;
        table: string;
        rowsWritten: number;
        completedTables: string[];
        d1Message: string;
      };
    };
    expect(json.error.code).toBe('COPY_FAILED');
    expect(json.error.stage).toBe('reload');
    expect(json.error.table).toBe('product_vendors');
    expect(json.error.rowsWritten).toBe(0); // both rows share one batch, which rolled back
    expect(json.error.completedTables).toContain('products');
    expect(json.error.d1Message).toContain('FOREIGN KEY');
    expect(json.error.message).toContain('PARTIALLY replaced');

    // One JSON log line carrying the same report.
    const logged = errors.mock.calls.map(
      (c) => JSON.parse(String(c[0])) as Record<string, unknown>,
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      event: 'datatool.copy_failed',
      stage: 'reload',
      table: 'product_vendors',
      source: 'production',
      dest: 'staging',
    });
    errors.mockRestore();
  });

  it('an unexpected throw becomes a JSON 500, never a bare one', async () => {
    env.DB_STAGING = undefined; // introspect() throws a TypeError on the missing binding
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('/api/copy', { source: 'production', dest: 'staging' }, TOKEN);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
    expect(JSON.parse(String(errors.mock.calls[0][0]))).toMatchObject({
      event: 'datatool.unhandled_error',
      path: '/api/copy',
    });
    errors.mockRestore();
  });

  it('the UI offers the log-table opt-in, unchecked by default', async () => {
    const html = await (await app.fetch(new Request('http://tool.local/'), env, CTX)).text();
    expect(html).toMatch(/<input type="checkbox" id="copy-logs">/);
    expect(html).toContain('includeLogTables');
    expect(html).toContain('PARTIALLY replaced');
    // The client script is a string inside a template literal, so an unescaped \n
    // would break it at runtime. Parse it to be sure.
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
    expect(() => new Function(script)).not.toThrow();
  });
});

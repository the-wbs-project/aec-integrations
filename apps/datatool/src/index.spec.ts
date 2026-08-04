import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

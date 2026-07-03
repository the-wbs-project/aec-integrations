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
});

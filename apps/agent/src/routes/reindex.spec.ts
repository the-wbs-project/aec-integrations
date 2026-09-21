import { describe, expect, it } from 'vitest';

import { runReindex } from './reindex';
import app from '../app';
import { corpusKey } from '../lib/corpus';
import { addIntegration, IDS, seedCatalog } from '../test/catalog-fixture';
import type { Env } from '../env';
import { makeR2Stub } from '../test/r2';

const ENV = { TOOL_TOKEN: 'secret' } as Env;

describe('POST /admin/reindex — the gate', () => {
  it('403s with no credential', async () => {
    // Guards: the same registration-order property `app.spec.ts` asserts for the
    // agent mounts. `app.use('*', requireAccess())` runs ahead of every later
    // `app.route()`, so moving it below the mounts must fail a test rather than
    // open an operator endpoint that rewrites an index.
    const res = await app.request('/admin/reindex', { method: 'POST' }, ENV);
    expect(res.status).toBe(403);
  });

  it('403s with a WRONG token', async () => {
    const res = await app.request(
      '/admin/reindex',
      { method: 'POST', headers: { Authorization: 'Bearer wrong' } },
      ENV,
    );
    expect(res.status).toBe(403);
  });

  it('403s a GET too, rather than 404ing it', async () => {
    // Guards: a 404 on an unauthenticated request leaks which routes exist.
    const res = await app.request('/admin/reindex', {}, ENV);
    expect(res.status).toBe(403);
  });

  it('reaches the handler WITH the token, and reports the operator', async () => {
    // Guards: the control. Every negative above would pass just as well if the
    // route did not exist at all.
    const t = await seedCatalog();
    const r2 = makeR2Stub();
    const res = await app.request(
      '/admin/reindex',
      { method: 'POST', headers: { Authorization: 'Bearer secret' } },
      { ...ENV, DB: t.db, CORPUS: r2.bucket } as unknown as Env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { operator: string; documents_written: number };
    expect(body.operator).toBe('tool-token');
    expect(body.documents_written).toBe(8);
    t.dispose();
  });
});

describe('runReindex', () => {
  it('writes one markdown object per published product, with metadata', async () => {
    const t = await seedCatalog();
    const r2 = makeR2Stub();
    const summary = await runReindex({ DB: t.db, CORPUS: r2.bucket });

    expect(summary.ok).toBe(true);
    expect(summary.products_read).toBe(8);
    expect(summary.documents_written).toBe(8);
    expect(summary.skipped).toEqual([]);
    expect(summary.failed).toEqual([]);

    const stored = r2.objects.get(corpusKey('zoho'));
    expect(stored?.contentType).toBe('text/markdown');
    expect(stored?.customMetadata).toEqual({
      type: 'product',
      slug: 'zoho',
      vendor: 'acme',
      role: 'application',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    expect([...r2.objects.keys()]).not.toContain(corpusKey('hidden-product'));
    t.dispose();
  });

  it('RESPECTS the connection cap — peak in-flight puts never exceeds 6', async () => {
    // Guards: AECI-666, and it is asserted as an OBSERVED PEAK rather than as
    // "mapWithConcurrency was called". An unbounded `Promise.all` calls all the
    // same functions and still opens one connection per product; past the limit
    // the runtime cancels stalled work and a cancelled promise NEVER settles, so
    // the failure is silent in both directions.
    const t = await seedCatalog();
    const r2 = makeR2Stub();
    await runReindex({ DB: t.db, CORPUS: r2.bucket });
    expect(r2.peakInFlight()).toBeGreaterThan(1);
    expect(r2.peakInFlight()).toBeLessThanOrEqual(6);
    t.dispose();
  });

  it('reports a failed write instead of throwing, and stays ok: false', async () => {
    // Guards: `mapWithConcurrency` never rejects, so a per-object failure has to
    // be tallied. A run that threw would lose every successful write's report.
    const t = await seedCatalog();
    const r2 = makeR2Stub();
    r2.failOn(corpusKey('zoho'), 'R2 said no');

    const summary = await runReindex({ DB: t.db, CORPUS: r2.bucket });
    expect(summary.ok).toBe(false);
    expect(summary.documents_written).toBe(7);
    expect(summary.failed).toEqual([{ slug: 'zoho', reason: 'R2 said no' }]);
    t.dispose();
  });

  it('DELETES a stale object for a product that is no longer published', async () => {
    // Guards: convergence. A retracted product whose document survives keeps
    // being served as a retrieved passage, so the agent answers confidently from
    // a record the public site has removed.
    const t = await seedCatalog();
    const r2 = makeR2Stub();
    await r2.bucket.put('products/retracted-thing.md', '# Gone');

    const summary = await runReindex({ DB: t.db, CORPUS: r2.bucket });
    expect(summary.stale_deleted).toBe(1);
    expect(summary.stale_keys).toEqual(['products/retracted-thing.md']);
    expect(r2.deleted).toEqual(['products/retracted-thing.md']);
    expect(r2.objects.has('products/retracted-thing.md')).toBe(false);
    t.dispose();
  });

  it('SKIPS deletion entirely when any write failed', async () => {
    // Guards: the fence on a destructive operation. If a document could not be
    // rebuilt, the live key set is incomplete, and "delete everything not in the
    // live set" would delete a good document for a product this run could not
    // reach. Deletion waits for a clean run.
    const t = await seedCatalog();
    const r2 = makeR2Stub();
    await r2.bucket.put('products/retracted-thing.md', '# Gone');
    r2.failOn(corpusKey('zoho'), 'R2 said no');

    const summary = await runReindex({ DB: t.db, CORPUS: r2.bucket });
    expect(summary.stale_deleted).toBe(0);
    expect(r2.deleted).toEqual([]);
    expect(r2.objects.has('products/retracted-thing.md')).toBe(true);
    t.dispose();
  });

  it('never touches an object outside the corpus prefix', async () => {
    const t = await seedCatalog();
    const r2 = makeR2Stub();
    await r2.bucket.put('somewhere-else/keep-me.md', '# Keep');

    await runReindex({ DB: t.db, CORPUS: r2.bucket });
    expect(r2.deleted).toEqual([]);
    expect(r2.objects.has('somewhere-else/keep-me.md')).toBe(true);
    t.dispose();
  });

  it('writes NO audit_log row — this route changes no domain state', async () => {
    // Guards: §26.1 is about DOMAIN state. The corpus is a derived projection of
    // rows promote already wrote and already audited, in the same exempt class
    // as the Algolia index (ADR 0022). This Worker holds D1 read-only and opens
    // no batch, so an audit row here could only be a separate non-atomic INSERT
    // — the exact anti-pattern the invariant exists to prevent.
    const t = await seedCatalog();
    addIntegration(t, 'i1', IDS.zoho, IDS.esub, 'api');
    const r2 = makeR2Stub();
    await runReindex({ DB: t.db, CORPUS: r2.bucket });
    const rows = t.raw.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number };
    expect(rows.n).toBe(0);
    t.dispose();
  });

  it('is idempotent — a second run rewrites the same bytes and deletes nothing', async () => {
    const t = await seedCatalog();
    const r2 = makeR2Stub();
    const first = await runReindex({ DB: t.db, CORPUS: r2.bucket });
    const before = r2.objects.get(corpusKey('zoho'))?.body;
    const second = await runReindex({ DB: t.db, CORPUS: r2.bucket });

    expect(second.documents_written).toBe(first.documents_written);
    expect(second.stale_deleted).toBe(0);
    expect(r2.objects.get(corpusKey('zoho'))?.body).toBe(before);
    t.dispose();
  });
});

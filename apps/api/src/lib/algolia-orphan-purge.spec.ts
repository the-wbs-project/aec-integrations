/**
 * Unit tests for the AECI-267 targeted Algolia orphan purge (`STAGE_1_SPEC.md`
 * §23.1). Fully fake-driven: arg parsing, credential resolution (incl. the
 * `ALGOLIA_ADMIN_KEY_<ENV>` fallback), the production guard, the entity→index
 * plan, the fetch-based client contract (get/search/delete), and the
 * preflight→delete→verify orchestration via a recording fake client — no network.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  PROCORE_ORPHANS,
  assertEnvAllowed,
  buildDeletePlan,
  createOrphanPurgeClient,
  groupByIndex,
  parseIdsFlag,
  parsePurgeArgs,
  resolveAlgoliaCreds,
  runOrphanPurge,
  type OrphanPurgeClient,
  type OrphanTarget,
  type PurgeArgs,
} from './algolia-orphan-purge';

// ── parsePurgeArgs ─────────────────────────────────────────────────────────────

describe('parsePurgeArgs', () => {
  it('defaults to a staging dry-run with no overrides', () => {
    const args = parsePurgeArgs([]);
    expect(args).toEqual({
      env: 'staging',
      apply: false,
      allowProduction: false,
      ids: undefined,
    });
  });

  it('reads --apply, --allow-production, and --env (= form too)', () => {
    expect(parsePurgeArgs(['--apply']).apply).toBe(true);
    expect(parsePurgeArgs(['--allow-production']).allowProduction).toBe(true);
    expect(parsePurgeArgs(['--env', 'production']).env).toBe('production');
    expect(parsePurgeArgs(['--env=preview']).env).toBe('preview');
  });

  it('rejects an unknown --env', () => {
    expect(() => parsePurgeArgs(['--env', 'prod'])).toThrow(/Invalid --env/);
  });

  it('parses --ids into targets and rejects bad entries', () => {
    const args = parsePurgeArgs(['--ids', 'products:abc,vendors:def']);
    expect(args.ids).toEqual([
      { entity: 'products', objectID: 'abc', label: 'abc' },
      { entity: 'vendors', objectID: 'def', label: 'def' },
    ]);
    expect(() => parseIdsFlag('widgets:x')).toThrow(/Invalid --ids/);
    expect(() => parseIdsFlag('noColon')).toThrow(/Invalid --ids/);
  });
});

// ── resolveAlgoliaCreds ────────────────────────────────────────────────────────

describe('resolveAlgoliaCreds', () => {
  it('prefers the env-specific key name over the generic one when both are set', () => {
    const creds = resolveAlgoliaCreds('staging', {
      ALGOLIA_APP_ID: 'APP',
      ALGOLIA_ADMIN_KEY: 'generic',
      ALGOLIA_ADMIN_KEY_STAGING: 'env-specific',
    });
    expect(creds).toEqual({ appId: 'APP', apiKey: 'env-specific' });
  });

  it('falls back to the generic ALGOLIA_ADMIN_KEY when no env-specific key (the CI path)', () => {
    const creds = resolveAlgoliaCreds('staging', {
      ALGOLIA_APP_ID: 'APP',
      ALGOLIA_ADMIN_KEY: 'ci-mapped',
    });
    expect(creds).toEqual({ appId: 'APP', apiKey: 'ci-mapped' });
  });

  it('returns undefined creds when nothing is set', () => {
    expect(resolveAlgoliaCreds('staging', {})).toEqual({ appId: undefined, apiKey: undefined });
  });
});

// ── assertEnvAllowed ───────────────────────────────────────────────────────────

describe('assertEnvAllowed', () => {
  const base: PurgeArgs = { env: 'staging', apply: true, allowProduction: false, ids: undefined };

  it('blocks an apply to production without the guard', () => {
    expect(() => assertEnvAllowed({ ...base, env: 'production' })).toThrow(/PRODUCTION/);
  });

  it('allows production with --allow-production', () => {
    expect(() =>
      assertEnvAllowed({ ...base, env: 'production', allowProduction: true }),
    ).not.toThrow();
  });

  it('allows a production dry-run (read-only) without the guard', () => {
    expect(() => assertEnvAllowed({ ...base, env: 'production', apply: false })).not.toThrow();
  });

  it('allows a staging apply', () => {
    expect(() => assertEnvAllowed(base)).not.toThrow();
  });
});

// ── buildDeletePlan + groupByIndex ─────────────────────────────────────────────

describe('buildDeletePlan / groupByIndex', () => {
  it('resolves the Procore orphans to the staging primary indexes', () => {
    const plan = buildDeletePlan(PROCORE_ORPHANS, 'staging');
    expect(plan).toEqual([
      {
        entity: 'vendors',
        objectID: '00000000-0000-4000-8000-000000000061',
        label: 'Fixture Procore Technologies',
        indexName: 'staging_vendors',
      },
      {
        entity: 'products',
        objectID: '00000000-0000-4000-8000-000000000062',
        label: 'Fixture Procore',
        indexName: 'staging_products',
      },
      {
        entity: 'products',
        objectID: '00000000-0000-4000-8000-000000000063',
        label: 'Fixture Acme Connector',
        indexName: 'staging_products',
      },
      {
        entity: 'integrations',
        objectID: '00000000-0000-4000-8000-000000000065',
        label: 'Fixture Procore ↔ Acme Connector',
        indexName: 'staging_integrations',
      },
    ]);
  });

  it('groups multiple targets that share an index into one bucket', () => {
    const orphans: OrphanTarget[] = [
      { entity: 'products', objectID: 'p1', label: 'p1' },
      { entity: 'products', objectID: 'p2', label: 'p2' },
      { entity: 'vendors', objectID: 'v1', label: 'v1' },
    ];
    const grouped = groupByIndex(buildDeletePlan(orphans, 'staging'));
    expect(grouped.get('staging_products')?.map((p) => p.objectID)).toEqual(['p1', 'p2']);
    expect(grouped.get('staging_vendors')?.map((p) => p.objectID)).toEqual(['v1']);
  });
});

// ── createOrphanPurgeClient (fetch contract) ───────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const CREDS = { appId: 'APP', apiKey: 'KEY' };

describe('createOrphanPurgeClient', () => {
  it('getObject: 200 → found, 404 → not found, other → throws; default DSN host', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { objectID: 'x' }))
      .mockResolvedValueOnce(jsonResponse(404, { message: 'ObjectID does not exist' }))
      .mockResolvedValueOnce(jsonResponse(500, { message: 'boom' }));
    const client = createOrphanPurgeClient(CREDS, fetchImpl);

    expect(await client.getObject('staging_products', 'x')).toEqual({ found: true });
    expect(await client.getObject('staging_products', 'y')).toEqual({ found: false });
    await expect(client.getObject('staging_products', 'z')).rejects.toThrow(/HTTP 500/);

    const firstUrl = fetchImpl.mock.calls[0][0] as string;
    expect(firstUrl).toBe('https://APP-dsn.algolia.net/1/indexes/staging_products/x');
  });

  it('getObject: consistent reads from the write host (read-after-write)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(404, {}));
    const client = createOrphanPurgeClient(CREDS, fetchImpl);
    await client.getObject('staging_products', 'x', { consistent: true });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://APP.algolia.net/1/indexes/staging_products/x');
  });

  it('waitTask: polls the task endpoint until published', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { status: 'published' }));
    const client = createOrphanPurgeClient(CREDS, fetchImpl);
    await client.waitTask('staging_products', 42);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://APP.algolia.net/1/indexes/staging_products/task/42',
    );
  });

  it('search: maps hits to {objectID, display} with name/title/slug fallback', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        hits: [
          { objectID: 'a', name: 'Fixture Procore' },
          { objectID: 'b', slug: 'fixture-procore' },
          { objectID: 'c' },
        ],
      }),
    );
    const client = createOrphanPurgeClient(CREDS, fetchImpl);
    const hits = await client.search('staging_products', 'Procore');
    expect(hits).toEqual([
      { objectID: 'a', display: 'Fixture Procore' },
      { objectID: 'b', display: 'fixture-procore' },
      { objectID: 'c', display: '(no name)' },
    ]);
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      params: 'query=Procore&hitsPerPage=20&analytics=false',
    });
  });

  it('deleteObjects: posts deleteObject requests to the batch endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { taskID: 7 }));
    const client = createOrphanPurgeClient(CREDS, fetchImpl);
    const outcome = await client.deleteObjects('staging_products', ['p1', 'p2']);

    expect(outcome).toEqual({ ok: true, status: 200, taskID: 7 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://APP.algolia.net/1/indexes/staging_products/batch');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      requests: [
        { action: 'deleteObject', body: { objectID: 'p1' } },
        { action: 'deleteObject', body: { objectID: 'p2' } },
      ],
    });
  });
});

// ── runOrphanPurge orchestration ───────────────────────────────────────────────

function silentLog() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Recording fake client. `present` is the set of objectIDs that "exist" (mutated
 *  by deleteObjects when `deleteOk`). */
function fakeClient(opts: { present: Set<string>; deleteOk?: boolean }): OrphanPurgeClient & {
  deletes: string[][];
} {
  const deleteOk = opts.deleteOk ?? true;
  const deletes: string[][] = [];
  return {
    deletes,
    async getObject(_indexName, objectID) {
      return { found: opts.present.has(objectID) };
    },
    async search() {
      return [];
    },
    async deleteObjects(_indexName, objectIDs) {
      deletes.push(objectIDs);
      if (deleteOk) for (const id of objectIDs) opts.present.delete(id);
      return deleteOk
        ? { ok: true, status: 200, taskID: 1 }
        : { ok: false, status: 403, message: 'Index not allowed with this API key' };
    },
    async waitTask() {
      /* no-op in tests */
    },
  };
}

describe('runOrphanPurge', () => {
  const ids = PROCORE_ORPHANS.map((o) => o.objectID);

  it('dry-run: confirms targets, never deletes', async () => {
    const client = fakeClient({ present: new Set(ids) });
    const result = await runOrphanPurge(
      { client, log: silentLog() },
      { env: 'staging', orphans: PROCORE_ORPHANS, apply: false },
    );
    expect(result.applied).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.rows.every((r) => r.presentBefore)).toBe(true);
    expect(client.deletes).toEqual([]);
  });

  it('apply: deletes each index and verifies the targets are gone', async () => {
    const client = fakeClient({ present: new Set(ids) });
    const result = await runOrphanPurge(
      { client, log: silentLog() },
      { env: 'staging', orphans: PROCORE_ORPHANS, apply: true },
    );
    expect(result.applied).toBe(true);
    expect(result.ok).toBe(true);
    // one batch call per distinct index (4 orphans, but 2 products → 3 indexes)
    expect(client.deletes.length).toBe(3);
    // the two fixture products are deleted in a single staging_products batch
    expect(client.deletes.some((batch) => batch.length === 2)).toBe(true);
    expect(result.rows.length).toBe(4);
    expect(result.rows.every((r) => r.deleted && r.presentAfter === false)).toBe(true);
  });

  it('apply: ok=false when a delete fails', async () => {
    const client = fakeClient({ present: new Set(ids), deleteOk: false });
    const result = await runOrphanPurge(
      { client, log: silentLog() },
      { env: 'staging', orphans: PROCORE_ORPHANS, apply: true },
    );
    expect(result.ok).toBe(false);
  });

  it('apply: ok=false when a target survives verification', async () => {
    // deletes "succeed" but the object never leaves the index (present untouched).
    const survivor: OrphanPurgeClient = {
      async getObject(_i, objectID) {
        return { found: ids.includes(objectID) };
      },
      async search() {
        return [];
      },
      async deleteObjects() {
        return { ok: true, status: 200, taskID: 1 };
      },
      async waitTask() {
        /* no-op in tests */
      },
    };
    const result = await runOrphanPurge(
      { client: survivor, log: silentLog() },
      { env: 'staging', orphans: PROCORE_ORPHANS, apply: true },
    );
    expect(result.ok).toBe(false);
    expect(result.rows.every((r) => r.presentAfter)).toBe(true);
  });
});

// ─── AECI-666: connection hygiene ────────────────────────────────────────────

/**
 * A `Response` whose stream reports cancellation — the observable for "the
 * connection was released". An unread body keeps holding its connection, and a
 * Worker invocation that parks too many gets its stalled responses cancelled
 * into `fetch` promises that never settle. Distinct from `jsonResponse` above,
 * which is a plain object with no real body and so cannot show a drain.
 */
function trackedResponse(status: number, body = '{}'): { res: Response; drained: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { res: new Response(stream, { status }), drained: () => cancelled };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('createOrphanPurgeClient — response bodies are always released (AECI-666)', () => {
  it('releases the body on the getObject found path', async () => {
    const { res, drained } = trackedResponse(200, JSON.stringify({ objectID: 'x' }));
    const client = createOrphanPurgeClient(CREDS, vi.fn<typeof fetch>().mockResolvedValue(res));

    expect(await client.getObject('staging_products', 'x')).toEqual({ found: true });
    await settle();
    expect(drained()).toBe(true);
  });

  it('releases the body on the getObject 404 path', async () => {
    const { res, drained } = trackedResponse(404, JSON.stringify({ message: 'nope' }));
    const client = createOrphanPurgeClient(CREDS, vi.fn<typeof fetch>().mockResolvedValue(res));

    expect(await client.getObject('staging_products', 'y')).toEqual({ found: false });
    await settle();
    expect(drained()).toBe(true);
  });

  it('releases the body on every non-ok waitTask poll', async () => {
    // The worst of the three: this loop runs up to 20 times, so an erroring task
    // used to park 20 held connections in a single invocation.
    const tracked = Array.from({ length: 3 }, () => trackedResponse(500, 'upstream boom'));
    const fetchImpl = vi.fn<typeof fetch>();
    tracked.forEach((t) => fetchImpl.mockResolvedValueOnce(t.res));
    fetchImpl.mockResolvedValue(jsonResponse(200, { status: 'published' }));
    const client = createOrphanPurgeClient(CREDS, fetchImpl);

    await client.waitTask('staging_products', 42);
    await settle();
    expect(tracked.map((t) => t.drained())).toEqual([true, true, true]);
  });
});

/**
 * AECI-1945: both retraction CLIs mark the sitemap dirty on `--apply`, never on a dry
 * run, and end with the remaining follow-ups in run order. `wrangler` is faked: a
 * `d1 execute` answers from canned rows, and a `kv key put` is recorded. Nothing leaves
 * the process.
 */
import type { spawnSync as SpawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
}));

import { main as retractProduct } from '../../scripts/retract-product';
import { main as retractVendor } from '../../scripts/retract-vendor';
import { SITEMAP_DIRTY_KEY } from './sitemap-store';

type SpawnResult = ReturnType<typeof SpawnSync>;

const ok = (rows: unknown[]): SpawnResult =>
  ({
    status: 0,
    stdout: JSON.stringify([{ results: rows, success: true, meta: { changes: rows.length } }]),
    stderr: '',
  }) as unknown as SpawnResult;

const PRODUCT = { id: 'p-1', slug: 'box-2', name: 'Box 2', promotion_status: 'promoted' };
const VENDOR = {
  id: 'v-1',
  slug: 'acme',
  company_name: 'Acme',
  promotion_status: 'promoted',
  verified: 0,
};
const PRODUCT_FOOTPRINT = Object.fromEntries(
  [
    'connector_catalogs',
    'stub_mappings',
    'integrations',
    'powered_by',
    'evidenced_pairs',
    'evidenced_pairs_as_connector',
    'evidenced_pairs_as_a',
    'evidenced_pairs_as_b',
    'claims',
    'attestations',
    'field_challenges',
    'reviews',
    'product_versions',
    'page_views',
    'product_vendors',
    'product_categories',
    'product_audiences',
    'product_phases',
    'product_trades',
    'product_extensions',
  ].map((k) => [k, 0]),
);
const VENDOR_FOOTPRINT = Object.fromEntries(
  [
    'products',
    'integrations',
    'evidenced_pairs',
    'profiles',
    'seat_invites',
    'claims',
    'attestations',
    'page_views',
  ].map((k) => [k, 0]),
);

/** A fake `wrangler`. A `kv` call succeeds. A `d1 execute … --command <sql>` answers from
 *  the SQL's shape: a table probe, the identity lookup, or else the footprint row. The
 *  delete batch gets the footprint row too, which the CLI only counts. */
function fakeWrangler(footprint: object) {
  return (cmd: string, args: readonly string[]): SpawnResult => {
    expect(cmd).toBe('wrangler');
    if (args[0] === 'kv') return ok([]);
    const sql = args[args.indexOf('--command') + 1] ?? '';
    if (sql.includes('"sqlite_master"')) {
      return sql.startsWith('SELECT "sql"')
        ? ok([{ sql: 'CREATE TABLE "t" ("id" text)' }])
        : ok([]);
    }
    if (sql.startsWith('SELECT "id", "slug", "name"')) return ok([PRODUCT]);
    if (sql.startsWith('SELECT "id", "slug", "company_name"')) return ok([VENDOR]);
    return ok([footprint]);
  };
}

const kvPuts = () =>
  spawnSyncMock.mock.calls.map(([, args]) => args as string[]).filter((args) => args[0] === 'kv');

let log: string[];
beforeEach(() => {
  spawnSyncMock.mockReset();
  log = [];
  const capture = (...a: unknown[]) => void log.push(a.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});
afterEach(() => vi.restoreAllMocks());

describe.each([
  ['retract-product', retractProduct, ['--slug', 'box-2', '--local'], PRODUCT_FOOTPRINT],
  ['retract-vendor', retractVendor, ['--id', 'v-1', '--local'], VENDOR_FOOTPRINT],
] as const)('%s', (_name, main, baseArgs, footprint) => {
  const apply = [...baseArgs, '--apply', '--confirm-count', '1', '--skip-algolia'];
  beforeEach(() => spawnSyncMock.mockImplementation(fakeWrangler(footprint)));

  it('a dry run does not mark the sitemap dirty', async () => {
    expect(await main([...baseArgs])).toBe(0);
    expect(kvPuts()).toEqual([]);
    expect(log.join('\n')).toContain('mark the sitemap dirty');
  });

  it('--apply marks the sitemap dirty on the target tier, then lists the follow-ups', async () => {
    expect(await main(apply)).toBe(0);
    const puts = kvPuts();
    expect(puts).toHaveLength(1);
    expect(puts[0]?.slice(0, 4)).toEqual(['kv', 'key', 'put', SITEMAP_DIRTY_KEY]);
    expect(Number.isNaN(Date.parse(puts[0]?.[4] ?? ''))).toBe(false);
    expect(puts[0]?.slice(5)).toEqual(['--binding', 'TAXONOMY_KV', '--local']);
    const out = log.join('\n');
    expect(out).toContain('✓ D1:');
    expect(out).toContain('✓ Sitemap: marked dirty');
    expect(out).toContain('Remaining follow-ups, in run order:');
    expect(out).toContain('1. Purge the edge cache');
    expect(out).not.toContain('Mark the sitemap dirty. The CLI');
  });

  it('a failed put still exits 0 and puts the manual command first', async () => {
    spawnSyncMock.mockImplementation((cmd: string, args: readonly string[]) =>
      args[0] === 'kv'
        ? ({ status: 1, stdout: '', stderr: 'auth error' } as unknown as SpawnResult)
        : fakeWrangler(footprint)(cmd, args),
    );
    expect(await main(apply)).toBe(0);
    const out = log.join('\n');
    expect(out).toContain('✗ Sitemap: could not mark sitemap:dirty (exit 1). auth error');
    expect(out).toContain('1. Mark the sitemap dirty. The CLI');
    expect(out).toContain('pnpm exec wrangler kv key put sitemap:dirty');
  });
});

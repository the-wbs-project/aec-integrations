/**
 * The getObjects reader behind `algolia_unclaimed_logo` (AECI-1867): chunking, the
 * request shape, missing records, and a failed response.
 */

import { describe, expect, it } from 'vitest';

import {
  createAlgoliaLogoReader,
  createUnclaimedLogoReader,
  GET_OBJECTS_MAX,
} from './algolia-unclaimed-logo';
import type { Env } from '../env';

type Call = { url: string; body: { requests: Array<{ indexName: string; objectID: string }> } };

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const call = { url, body: JSON.parse(String(init?.body)) } as Call;
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('createAlgoliaLogoReader', () => {
  it('reads logo_url per id from the env index and leaves out ids with no record', async () => {
    const { impl, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            results: [{ objectID: 'a', logo_url: 'https://x/a.png' }, null, { objectID: 'c' }],
          }),
        ),
    );
    const reader = createAlgoliaLogoReader('APP', 'KEY', 'production', impl);

    expect(reader.indexName('vendors')).toBe('production_vendors');
    const out = await reader.logos('products', ['a', 'b', 'c']);
    expect(out).toEqual([
      { objectID: 'a', logoUrl: 'https://x/a.png' },
      { objectID: 'c', logoUrl: null },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://APP-dsn.algolia.net/1/indexes/*/objects');
    expect(calls[0]!.body.requests.map((r) => r.indexName)).toEqual([
      'production_products',
      'production_products',
      'production_products',
    ]);
  });

  it('sends one request per chunk of ids, one after another', async () => {
    const { impl, calls } = fakeFetch(() => new Response(JSON.stringify({ results: [] })));
    const reader = createAlgoliaLogoReader('APP', 'KEY', 'staging', impl);
    const ids = Array.from({ length: GET_OBJECTS_MAX + 5 }, (_, i) => `id-${i}`);

    await reader.logos('vendors', ids);
    expect(calls.map((c) => c.body.requests.length)).toEqual([GET_OBJECTS_MAX, 5]);
  });

  it('throws on a non-2xx response so the check reports an error, not clean', async () => {
    const { impl } = fakeFetch(() => new Response('{"message":"Invalid key"}', { status: 403 }));
    const reader = createAlgoliaLogoReader('APP', 'KEY', 'production', impl);
    await expect(reader.logos('products', ['a'])).rejects.toThrow(/HTTP 403/);
  });
});

describe('createUnclaimedLogoReader', () => {
  it('is undefined without Algolia creds', () => {
    expect(createUnclaimedLogoReader({} as Env)).toBeUndefined();
    expect(createUnclaimedLogoReader({ ALGOLIA_APP_ID: 'APP' } as Env)).toBeUndefined();
  });

  it('builds a reader when both creds are set', () => {
    const reader = createUnclaimedLogoReader({
      ALGOLIA_APP_ID: 'APP',
      ALGOLIA_ADMIN_KEY: 'KEY',
      ENV: 'production',
    } as Env);
    expect(reader?.indexName('products')).toBe('production_products');
  });
});

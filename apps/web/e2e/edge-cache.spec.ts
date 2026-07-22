import { expect, test, type APIResponse } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';
const BASE_HOSTNAME = new URL(BASE_URL).hostname;
const IS_LOCAL = BASE_HOSTNAME === 'localhost' || BASE_HOSTNAME === '127.0.0.1';

function accessHeaders(): Record<string, string> {
  const clientId = process.env['CF_ACCESS_CLIENT_ID'];
  const clientSecret = process.env['CF_ACCESS_CLIENT_SECRET'];
  if (!clientId || !clientSecret) return {};
  return {
    'CF-Access-Client-Id': clientId,
    'CF-Access-Client-Secret': clientSecret,
  };
}

test.describe('native Workers Cache (AECI-323 / WC-9)', () => {
  test('a unique cacheable URL progresses from MISS to HIT on a deployed preview', async ({
    request,
  }) => {
    test.skip(IS_LOCAL, 'native Workers Cache is not emulated by local Wrangler/Miniflare');

    // `view` is a display-only /products cache-key parameter (AECI-190): it is on
    // the route's cacheKeyParams allowlist, so a unique value forks the native
    // cache key (guaranteeing a cold MISS regardless of prior preview traffic),
    // yet the index maps any non-`table` value to the default card grid — so the
    // response is a normal 200 carrying the standard /products cache headers, and
    // `view` is never forwarded to the API. (A unique `page=` was unusable: `page`
    // has no upper bound, so a timestamp is an out-of-range page that renders 404.)
    const path = `/products?view=${Date.now()}`;
    const headers = accessHeaders();
    const miss = await request.get(path, { headers });

    expect(miss.status()).toBe(200);
    expect(miss.headers()['cf-cache-status']).toBe('MISS');
    expect(miss.headers()['cache-control']).toContain('public');
    expect(miss.headers()['cache-control']).toContain('s-maxage=300');
    expect(miss.headers()['cache-tag']).toContain('route:index');
    expect(miss.headers()['cache-tag']).toContain('index:products');
    expect(miss.headers()['x-robots-tag']).toBe('noindex, nofollow');

    let hit: APIResponse | undefined;
    await expect
      .poll(
        async () => {
          hit = await request.get(path, { headers });
          expect(hit.status()).toBe(200);
          return hit.headers()['cf-cache-status'];
        },
        {
          message: `expected ${path} to enter native Workers Cache`,
          timeout: 5_000,
          intervals: [250, 500, 1_000],
        },
      )
      .toBe('HIT');

    expect(hit).toBeDefined();
    expect(hit!.headers()['cache-control']).toBe(miss.headers()['cache-control']);
    expect(hit!.headers()['cache-tag']).toBe(miss.headers()['cache-tag']);
    expect(hit!.headers()['x-robots-tag']).toBe(miss.headers()['x-robots-tag']);
  });
});

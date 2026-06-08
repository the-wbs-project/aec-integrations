import { describe, expect, it } from 'vitest';

import {
  buildAlgoliaBootstrapScript,
  buildAlgoliaPublicConfig,
  injectAlgoliaBootstrap,
} from './algolia-bootstrap-inject';
import type { WebEnv } from './env';

function makeEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    ASSETS: {} as Fetcher,
    API: {} as Fetcher,
    ALGOLIA_APP_ID: 'app-abc',
    ALGOLIA_SEARCH_KEY: 'search-only-key-123',
    ENV: 'staging',
    ...overrides,
  };
}

describe('buildAlgoliaPublicConfig', () => {
  it('returns null when ALGOLIA_APP_ID is missing', () => {
    expect(buildAlgoliaPublicConfig(makeEnv({ ALGOLIA_APP_ID: undefined }))).toBeNull();
  });

  it('returns null when ALGOLIA_SEARCH_KEY is missing', () => {
    expect(buildAlgoliaPublicConfig(makeEnv({ ALGOLIA_SEARCH_KEY: undefined }))).toBeNull();
  });

  it('carries appId, the search key, and the env index names', () => {
    expect(buildAlgoliaPublicConfig(makeEnv())).toEqual({
      appId: 'app-abc',
      searchKey: 'search-only-key-123',
      indexes: {
        products: 'staging_products',
        vendors: 'staging_vendors',
        integrations: 'staging_integrations',
      },
    });
  });

  it('folds an absent ENV onto the preview index set', () => {
    expect(buildAlgoliaPublicConfig(makeEnv({ ENV: undefined }))?.indexes).toEqual({
      products: 'preview_products',
      vendors: 'preview_vendors',
      integrations: 'preview_integrations',
    });
  });
});

describe('buildAlgoliaBootstrapScript', () => {
  it('emits a script tag assigning the config to window.__AECI_ALGOLIA__', () => {
    expect(buildAlgoliaBootstrapScript(makeEnv())).toBe(
      '<script>window.__AECI_ALGOLIA__={"appId":"app-abc","searchKey":"search-only-key-123",' +
        '"indexes":{"products":"staging_products","vendors":"staging_vendors","integrations":"staging_integrations"}};</script>',
    );
  });

  it('returns null when public config is incomplete', () => {
    expect(buildAlgoliaBootstrapScript(makeEnv({ ALGOLIA_SEARCH_KEY: '' }))).toBeNull();
  });

  it('escapes "<" so a stray key value cannot break out of the script', () => {
    const script = buildAlgoliaBootstrapScript(makeEnv({ ALGOLIA_APP_ID: 'a</script>b' }));
    expect(script).not.toBeNull();
    expect(script).not.toContain('</script>b');
    expect(script).toContain('\\u003c/script>b');
  });
});

describe('injectAlgoliaBootstrap', () => {
  function htmlResponse(body: string, status = 200): Response {
    return new Response(body, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  it('splices the script tag immediately before </head>', async () => {
    const res = htmlResponse('<html><head><title>x</title></head><body>hi</body></html>');
    const out = await injectAlgoliaBootstrap(res, makeEnv());
    expect(await out.text()).toBe(
      '<html><head><title>x</title>' +
        '<script>window.__AECI_ALGOLIA__={"appId":"app-abc","searchKey":"search-only-key-123",' +
        '"indexes":{"products":"staging_products","vendors":"staging_vendors","integrations":"staging_integrations"}};</script>' +
        '</head><body>hi</body></html>',
    );
  });

  // ── Review gate (AECI-134 acceptance criterion) ──────────────────────────
  // The admin/management key must NEVER reach the browser. Even if a misguided
  // deploy were to place an admin key on the SSR Worker's env, the injected
  // HTML must surface only the public search key + appId, never the admin value.
  it('never injects an admin key value, even when one is present on env', async () => {
    const ADMIN_KEY = 'ADMIN-KEY-MUST-NOT-LEAK-9f8e7d';
    const env = {
      ...makeEnv(),
      // ALGOLIA_ADMIN_KEY is intentionally not part of WebEnv — the cast models
      // a hostile/misconfigured env to prove the injector can't read it.
      ALGOLIA_ADMIN_KEY: ADMIN_KEY,
    } as WebEnv & { ALGOLIA_ADMIN_KEY: string };

    const res = htmlResponse('<html><head></head><body/></html>');
    const out = await injectAlgoliaBootstrap(res, env);
    const text = await out.text();

    expect(text).toContain('search-only-key-123');
    expect(text).toContain('app-abc');
    expect(text).not.toContain(ADMIN_KEY);
  });

  it('returns the original response when config is incomplete (no-op when absent)', async () => {
    const res = htmlResponse('<html><head></head><body/></html>');
    const out = await injectAlgoliaBootstrap(res, makeEnv({ ALGOLIA_APP_ID: '' }));
    expect(out).toBe(res);
    expect(await out.text()).not.toContain('__AECI_ALGOLIA__');
  });

  it('returns the original response for non-HTML content types', async () => {
    const json = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const out = await injectAlgoliaBootstrap(json, makeEnv());
    expect(out).toBe(json);
  });

  it('returns the original response for non-2xx status', async () => {
    const res = htmlResponse('<html><head></head></html>', 500);
    const out = await injectAlgoliaBootstrap(res, makeEnv());
    expect(out).toBe(res);
  });

  it('returns the original response when the HTML has no </head> sentinel', async () => {
    const res = htmlResponse('not really html');
    const out = await injectAlgoliaBootstrap(res, makeEnv());
    expect(out).toBe(res);
  });

  it('strips content-length so the runtime recomputes after splicing', async () => {
    const res = new Response('<html><head></head><body/></html>', {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'content-length': '34',
      },
    });
    const out = await injectAlgoliaBootstrap(res, makeEnv());
    expect(out.headers.get('content-length')).toBeNull();
  });
});

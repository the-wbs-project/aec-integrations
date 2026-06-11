import { describe, expect, it } from 'vitest';

import type { WebEnv } from './env';
import {
  buildSupabaseBootstrapScript,
  buildSupabasePublicConfig,
  injectSupabaseBootstrap,
} from './supabase-bootstrap-inject';

function makeEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    ASSETS: {} as Fetcher,
    API: {} as Fetcher,
    SUPABASE_URL: 'https://abc.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key-123',
    ENV: 'staging',
    ...overrides,
  };
}

describe('buildSupabasePublicConfig', () => {
  it('returns null when SUPABASE_URL is missing', () => {
    expect(buildSupabasePublicConfig(makeEnv({ SUPABASE_URL: undefined }))).toBeNull();
  });

  it('returns null when SUPABASE_ANON_KEY is missing', () => {
    expect(buildSupabasePublicConfig(makeEnv({ SUPABASE_ANON_KEY: undefined }))).toBeNull();
  });

  it('carries the project url and the anon key', () => {
    expect(buildSupabasePublicConfig(makeEnv())).toEqual({
      url: 'https://abc.supabase.co',
      anonKey: 'anon-key-123',
    });
  });
});

describe('buildSupabaseBootstrapScript', () => {
  it('emits a script tag assigning the config to window.__AECI_SUPABASE__', () => {
    expect(buildSupabaseBootstrapScript(makeEnv())).toBe(
      '<script>window.__AECI_SUPABASE__={"url":"https://abc.supabase.co","anonKey":"anon-key-123"};</script>',
    );
  });

  it('returns null when public config is incomplete', () => {
    expect(buildSupabaseBootstrapScript(makeEnv({ SUPABASE_ANON_KEY: '' }))).toBeNull();
  });

  it('escapes "<" so a stray value cannot break out of the script', () => {
    const script = buildSupabaseBootstrapScript(makeEnv({ SUPABASE_ANON_KEY: 'a</script>b' }));
    expect(script).not.toBeNull();
    expect(script).not.toContain('</script>b');
    expect(script).toContain('\\u003c/script>b');
  });
});

describe('injectSupabaseBootstrap', () => {
  function htmlResponse(body: string, status = 200): Response {
    return new Response(body, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  it('splices the script tag immediately before </head>', async () => {
    const res = htmlResponse('<html><head><title>x</title></head><body>hi</body></html>');
    const out = await injectSupabaseBootstrap(res, makeEnv());
    expect(await out.text()).toBe(
      '<html><head><title>x</title>' +
        '<script>window.__AECI_SUPABASE__={"url":"https://abc.supabase.co","anonKey":"anon-key-123"};</script>' +
        '</head><body>hi</body></html>',
    );
  });

  // ── Review gate (AUTH_AND_RLS.md §3) ──────────────────────────────────────
  // The service-role key must NEVER reach the browser. Even if a misguided
  // deploy were to place a service-role key on the SSR Worker's env, the
  // injected HTML must surface only the public url + anon key, never the
  // service-role value. Mirrors the Algolia admin-key leak test.
  it('never injects a service-role key value, even when one is present on env', async () => {
    const SERVICE_ROLE_KEY = 'SERVICE-ROLE-MUST-NOT-LEAK-9f8e7d';
    const env = {
      ...makeEnv(),
      // SUPABASE_SERVICE_ROLE_KEY is intentionally not part of WebEnv — the
      // cast models a hostile/misconfigured env to prove the injector can't
      // read it.
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    } as WebEnv & { SUPABASE_SERVICE_ROLE_KEY: string };

    const res = htmlResponse('<html><head></head><body/></html>');
    const out = await injectSupabaseBootstrap(res, env);
    const text = await out.text();

    expect(text).toContain('anon-key-123');
    expect(text).toContain('https://abc.supabase.co');
    expect(text).not.toContain(SERVICE_ROLE_KEY);
  });

  it('returns the original response when config is incomplete (no-op when absent)', async () => {
    const res = htmlResponse('<html><head></head><body/></html>');
    const out = await injectSupabaseBootstrap(res, makeEnv({ SUPABASE_URL: '' }));
    expect(out).toBe(res);
    expect(await out.text()).not.toContain('__AECI_SUPABASE__');
  });

  it('returns the original response for non-HTML content types', async () => {
    const json = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const out = await injectSupabaseBootstrap(json, makeEnv());
    expect(out).toBe(json);
  });

  it('returns the original response for non-2xx status', async () => {
    const res = htmlResponse('<html><head></head></html>', 500);
    const out = await injectSupabaseBootstrap(res, makeEnv());
    expect(out).toBe(res);
  });

  it('returns the original response when the HTML has no </head> sentinel', async () => {
    const res = htmlResponse('not really html');
    const out = await injectSupabaseBootstrap(res, makeEnv());
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
    const out = await injectSupabaseBootstrap(res, makeEnv());
    expect(out.headers.get('content-length')).toBeNull();
  });
});

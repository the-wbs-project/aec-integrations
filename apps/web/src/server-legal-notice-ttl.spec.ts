/**
 * AECI-1592 — the full handler with a notice in `notices.json`, which ships empty.
 * The cap's unit cases are in `server.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp, type Bindings, type SsrRenderer } from './server-runtime';

vi.mock('./app/legal/legal-notices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./app/legal/legal-notices')>()),
  LEGAL_NOTICES: [
    {
      slug: 'privacy',
      title: 'Privacy Policy',
      version: '1.2',
      effectiveDate: '2027-03-31',
      effectiveDateLabel: 'March 31, 2027',
      summary: 'We change how long we keep visit records.',
    },
  ],
}));

const OPENS = Date.UTC(2027, 2, 1);

function context(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
    exports: {},
  } as unknown as ExecutionContext;
}

function bindings(): Bindings {
  return { API: { fetch: vi.fn() }, ASSETS: {} } as unknown as Bindings;
}

const page: SsrRenderer = async () =>
  new Response('<!doctype html><title>x</title>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });

async function cacheControl(renderer: SsrRenderer, path = '/about'): Promise<string | null> {
  const res = await createApp({ ssrRenderer: renderer }).fetch(
    new Request(`https://www.aecintegrations.com${path}`),
    bindings(),
    context(),
  );
  return res.headers.get('Cache-Control');
}

describe('createApp with a legal notice boundary near', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('caps a static page on both sides of the cache', async () => {
    vi.setSystemTime(OPENS - 600_000);
    expect(await cacheControl(page)).toBe('public, max-age=600, s-maxage=600');
  });

  it('leaves the route TTL alone when the boundary is past it', async () => {
    vi.setSystemTime(OPENS - 2 * 86_400_000);
    expect(await cacheControl(page)).toBe('public, max-age=3600, s-maxage=86400');
  });

  it('keeps the resilience directives on a data route', async () => {
    vi.setSystemTime(OPENS - 60_000);
    expect(await cacheControl(page, '/products/acme')).toBe(
      'public, max-age=0, s-maxage=60, stale-while-revalidate=60, stale-if-error=86400',
    );
  });

  it('reads the clock before the render, so a slow render cannot outlive the boundary', async () => {
    vi.setSystemTime(OPENS - 10_000);
    const slow: SsrRenderer = async (...args) => {
      vi.setSystemTime(OPENS + 10_000);
      return page(...args);
    };
    expect(await cacheControl(slow)).toBe('public, max-age=10, s-maxage=10');
  });
});

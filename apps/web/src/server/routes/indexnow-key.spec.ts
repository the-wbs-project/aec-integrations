import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { WebEnv } from '../../env';
import { createIndexNowKeyHandler } from './indexnow-key';

const KEY = 'a1b2c3d4e5f6a7b8';

function makeEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    ASSETS: {} as Fetcher,
    API: {} as Fetcher,
    ENV: 'preview',
    ...overrides,
  };
}

/**
 * Mirrors the `server-runtime.ts` wiring order: the literal `/robots.txt` route
 * first, then the IndexNow param route, then an SSR catch-all sentinel so the
 * fall-through path is observable.
 */
function makeApp() {
  const app = new Hono<{ Bindings: WebEnv }>();
  app.get('/robots.txt', () => new Response('ROBOTS', { status: 200 }));
  app.get('/:file{[^/]+\\.txt}', createIndexNowKeyHandler());
  app.all('*', () => new Response('SSR-404', { status: 404 }));
  return app;
}

describe('GET /{INDEXNOW_KEY}.txt — IndexNow verification file (AECI-236)', () => {
  it('serves the key as text/plain when the file matches the configured key', async () => {
    const res = await makeApp().request(`/${KEY}.txt`, {}, makeEnv({ INDEXNOW_KEY: KEY }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('cache-control')).toContain('max-age=86400');
    expect(await res.text()).toBe(KEY);
  });

  it('does not intercept /robots.txt', async () => {
    const res = await makeApp().request('/robots.txt', {}, makeEnv({ INDEXNOW_KEY: KEY }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ROBOTS');
  });

  it('falls through to the SSR 404 for a different .txt file', async () => {
    const res = await makeApp().request('/not-the-key.txt', {}, makeEnv({ INDEXNOW_KEY: KEY }));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('SSR-404');
  });

  it('falls through to the SSR 404 when the key file is requested but INDEXNOW_KEY is unset', async () => {
    const res = await makeApp().request(`/${KEY}.txt`, {}, makeEnv());
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('SSR-404');
  });

  it('never echoes a malformed INDEXNOW_KEY — falls through to the SSR 404', async () => {
    const bad = 'short'; // < 8 chars — fails the key pattern
    const res = await makeApp().request(`/${bad}.txt`, {}, makeEnv({ INDEXNOW_KEY: bad }));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('SSR-404');
  });
});

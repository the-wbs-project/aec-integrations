import { describe, expect, it } from 'vitest';

import { buildBuildStampMeta, injectBuildStamp } from './build-stamp-inject';
import type { WebEnv } from './env';

function makeEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    ASSETS: {} as Fetcher,
    API: {} as Fetcher,
    COMMIT_SHA: 'abc123',
    ENV: 'staging',
    ...overrides,
  };
}

function html(
  body = '<html><head><title>x</title></head><body></body></html>',
  init?: ResponseInit,
) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': '999' },
    ...init,
  });
}

describe('buildBuildStampMeta', () => {
  it('returns null when COMMIT_SHA is missing or the unknown sentinel', () => {
    expect(buildBuildStampMeta(makeEnv({ COMMIT_SHA: undefined }))).toBeNull();
    expect(buildBuildStampMeta(makeEnv({ COMMIT_SHA: '' }))).toBeNull();
    expect(buildBuildStampMeta(makeEnv({ COMMIT_SHA: 'unknown' }))).toBeNull();
  });

  it('builds the meta tag', () => {
    expect(buildBuildStampMeta(makeEnv())).toBe('<meta name="aeci-build" content="abc123">');
  });

  it('escapes the value so it cannot break out of the attribute', () => {
    expect(buildBuildStampMeta(makeEnv({ COMMIT_SHA: '"><script>' }))).toBe(
      '<meta name="aeci-build" content="&quot;&gt;&lt;script&gt;">',
    );
  });
});

describe('injectBuildStamp', () => {
  it('inserts the meta tag before </head> and drops content-length', async () => {
    const res = await injectBuildStamp(html(), makeEnv());
    const text = await res.text();
    expect(text).toContain('<meta name="aeci-build" content="abc123"></head>');
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.status).toBe(200);
  });

  it('returns the same response when COMMIT_SHA is absent', async () => {
    const input = html();
    expect(await injectBuildStamp(input, makeEnv({ COMMIT_SHA: undefined }))).toBe(input);
  });

  it('skips non-2xx, non-HTML, and head-less responses', async () => {
    const notFound = html(undefined, { status: 404 });
    expect(await injectBuildStamp(notFound, makeEnv())).toBe(notFound);

    const json = new Response('{}', { headers: { 'content-type': 'application/json' } });
    expect(await injectBuildStamp(json, makeEnv())).toBe(json);

    const headless = html('<p>no head</p>');
    expect(await injectBuildStamp(headless, makeEnv())).toBe(headless);
  });
});

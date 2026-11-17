import { describe, expect, it } from 'vitest';

import {
  buildBrowserEvidenceBootstrapScript,
  buildBrowserEvidencePublicConfig,
  injectBrowserEvidenceBootstrap,
} from './browser-evidence-bootstrap-inject';
import type { WebEnv } from './env';

function makeEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    ASSETS: {} as Fetcher,
    API: {} as Fetcher,
    BROWSER_EVIDENCE_ENABLED: 'true',
    ENV: 'staging',
    ...overrides,
  };
}

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  });
}

const SCRIPT = '<script>window.__AECI_BROWSER_EVIDENCE__={"enabled":true};</script>';

describe('buildBrowserEvidencePublicConfig (AECI-1714)', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', 'yes'])('is off for %j', (value) => {
    expect(buildBrowserEvidencePublicConfig(makeEnv({ BROWSER_EVIDENCE_ENABLED: value }))).toBe(
      null,
    );
  });

  it('is on only for the literal "true", and carries nothing else', () => {
    expect(buildBrowserEvidencePublicConfig(makeEnv())).toEqual({ enabled: true });
  });
});

describe('buildBrowserEvidenceBootstrapScript', () => {
  it('assigns the config to window.__AECI_BROWSER_EVIDENCE__', () => {
    expect(buildBrowserEvidenceBootstrapScript(makeEnv())).toBe(SCRIPT);
  });

  it('emits nothing when off', () => {
    expect(
      buildBrowserEvidenceBootstrapScript(makeEnv({ BROWSER_EVIDENCE_ENABLED: 'false' })),
    ).toBeNull();
  });
});

describe('injectBrowserEvidenceBootstrap', () => {
  it('splices the script before </head> and drops content-length', async () => {
    const res = html('<html><head><title>x</title></head><body></body></html>', {
      headers: { 'content-type': 'text/html', 'content-length': '55' },
    });
    const out = await injectBrowserEvidenceBootstrap(res, makeEnv());
    expect(await out.text()).toBe(
      `<html><head><title>x</title>${SCRIPT}</head><body></body></html>`,
    );
    expect(out.headers.get('content-length')).toBeNull();
  });

  it('returns the response untouched when the tier has it off', async () => {
    const res = html('<html><head></head></html>');
    expect(
      await injectBrowserEvidenceBootstrap(res, makeEnv({ BROWSER_EVIDENCE_ENABLED: 'false' })),
    ).toBe(res);
  });

  it('skips non-HTML, non-2xx and head-less responses', async () => {
    const env = makeEnv();
    const json = new Response('{}', { headers: { 'content-type': 'application/json' } });
    expect(await injectBrowserEvidenceBootstrap(json, env)).toBe(json);
    const notFound = html('<html><head></head></html>', { status: 404 });
    expect(await injectBrowserEvidenceBootstrap(notFound, env)).toBe(notFound);
    const headless = html('<p>no head</p>');
    expect(await injectBrowserEvidenceBootstrap(headless, env)).toBe(headless);
  });
});

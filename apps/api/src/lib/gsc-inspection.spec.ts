/**
 * URL Inspection transport + decision (AECI-1236).
 *
 * The decision is the load-bearing part: a wrong `close` deletes a worklist row
 * nobody can re-derive, so every branch that must NOT close has its own case.
 */

import { generateKeyPairSync } from 'node:crypto';

import { importSPKI, jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import {
  decideInspection,
  getGoogleAccessToken,
  GOOGLE_TOKEN_ENDPOINT,
  inspectUrl,
  parseServiceAccount,
  URL_INSPECTION_SCOPE,
} from './gsc-inspection';

const CHANGED = '2026-09-28T00:00:00.000Z';
const BEFORE = '2026-09-25T00:00:00Z';
const AFTER = '2026-09-30T00:00:00Z';

describe('decideInspection', () => {
  it('closes only when PASS and crawled strictly after the last change', () => {
    expect(decideInspection({ verdict: 'PASS', lastCrawlTime: AFTER }, CHANGED)).toEqual({
      action: 'close',
    });
  });

  it('does NOT close when the crawl equals the change time', () => {
    expect(decideInspection({ verdict: 'PASS', lastCrawlTime: CHANGED }, CHANGED)).toEqual({
      action: 'tag',
      reason: 'crawl_predates_change',
    });
  });

  it('does NOT close when indexed but crawled before the change', () => {
    expect(decideInspection({ verdict: 'PASS', lastCrawlTime: BEFORE }, CHANGED)).toEqual({
      action: 'tag',
      reason: 'crawl_predates_change',
    });
  });

  it('does NOT close an indexed page with no crawl time', () => {
    expect(decideInspection({ verdict: 'PASS' }, CHANGED).action).toBe('tag');
  });

  it('does NOT close a recent crawl that is not indexed', () => {
    expect(
      decideInspection(
        {
          verdict: 'NEUTRAL',
          lastCrawlTime: AFTER,
          coverageState: 'Crawled - currently not indexed',
        },
        CHANGED,
      ),
    ).toEqual({ action: 'tag', reason: 'crawled_not_indexed' });
  });

  it('tags a failed fetch and never closes it, even with a recent crawl (ADR 0030)', () => {
    for (const pageFetchState of ['NOT_FOUND', 'SOFT_404', 'SERVER_ERROR']) {
      expect(
        decideInspection({ verdict: 'FAIL', pageFetchState, lastCrawlTime: AFTER }, CHANGED),
      ).toEqual({ action: 'tag', reason: 'page_fetch_failed' });
    }
  });

  it.each([
    ['URL is unknown to Google', 'unknown_to_google'],
    ['Discovered - currently not indexed', 'discovered_not_indexed'],
    ['Crawled - currently not indexed', 'crawled_not_indexed'],
    ['Page with redirect', 'page_with_redirect'],
    ['Excluded by ‘noindex’ tag', 'excluded_noindex'],
    ['Something new Google invents', 'not_indexed_other'],
  ])('maps coverage "%s" to %s', (coverageState, reason) => {
    expect(decideInspection({ verdict: 'NEUTRAL', coverageState }, CHANGED)).toEqual({
      action: 'tag',
      reason,
    });
  });

  it('reads a noindex from indexingState', () => {
    expect(
      decideInspection({ verdict: 'NEUTRAL', indexingState: 'BLOCKED_BY_META_TAG' }, CHANGED),
    ).toEqual({ action: 'tag', reason: 'excluded_noindex' });
  });
});

describe('parseServiceAccount', () => {
  it('reads client_email and private_key', () => {
    expect(parseServiceAccount('{"client_email":"a@b","private_key":"k"}')).toEqual({
      clientEmail: 'a@b',
      privateKey: 'k',
    });
  });

  it.each([undefined, '', 'not json', '{"client_email":"a@b"}'])('returns null for %j', (v) => {
    expect(parseServiceAccount(v)).toBeNull();
  });
});

describe('getGoogleAccessToken', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = {
    clientEmail: 'inspector@example.iam.gserviceaccount.com',
    // Stored single-line, as a secret would be.
    privateKey: (privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).replace(
      /\n/g,
      '\\n',
    ),
  };

  it('signs an RS256 assertion for the read-only scope and returns the token', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const assertion = new URLSearchParams(init.body as string).get('assertion')!;
      const spki = await importSPKI(
        publicKey.export({ type: 'spki', format: 'pem' }) as string,
        'RS256',
      );
      const { payload } = await jwtVerify(assertion, spki, {
        issuer: account.clientEmail,
        audience: GOOGLE_TOKEN_ENDPOINT,
      });
      expect(payload.scope).toBe(URL_INSPECTION_SCOPE);
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    });
    expect(await getGoogleAccessToken(fetchImpl as never, account)).toEqual({
      ok: true,
      token: 'tok',
    });
  });

  it('returns a structured failure on a rejected exchange', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('no', { status: 400 }));
    expect(await getGoogleAccessToken(fetchImpl, account)).toEqual({
      ok: false,
      message: 'token_http_400',
    });
  });

  it('returns a structured failure on a bad key instead of throwing', async () => {
    const result = await getGoogleAccessToken(vi.fn(), { ...account, privateKey: 'garbage' });
    expect(result.ok).toBe(false);
  });
});

describe('inspectUrl', () => {
  const sleep = vi.fn().mockResolvedValue(undefined);
  const ok = (status: object) =>
    new Response(JSON.stringify({ inspectionResult: { indexStatusResult: status } }), {
      status: 200,
    });

  it('returns indexStatusResult', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ verdict: 'PASS' }));
    expect(await inspectUrl(fetchImpl, 't', 'https://x/a', { sleep })).toEqual({
      ok: true,
      status: { verdict: 'PASS' },
    });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toEqual({
      inspectionUrl: 'https://x/a',
      siteUrl: 'sc-domain:aecintegrations.com',
    });
  });

  it('does not retry a 429 and reports quota', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 429 }));
    expect(await inspectUrl(fetchImpl, 't', 'u', { sleep })).toMatchObject({ kind: 'quota' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports auth on a 403', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }));
    expect(await inspectUrl(fetchImpl, 't', 'u', { sleep })).toMatchObject({ kind: 'auth' });
  });

  it('retries a 5xx and a dropped connection, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('<html>', { status: 500 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ok({ verdict: 'NEUTRAL' }));
    expect(await inspectUrl(fetchImpl, 't', 'u', { sleep })).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('gives up as transient after three failed attempts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    expect(await inspectUrl(fetchImpl, 't', 'u', { sleep })).toMatchObject({
      ok: false,
      kind: 'transient',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

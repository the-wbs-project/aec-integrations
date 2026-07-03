/**
 * `callGoogleIndexing` (AECI-263) — Google Indexing API submission transport.
 * Mirrors `indexnow.spec.ts`: asserts the OAuth-then-publish request shape and
 * that a signing / token / publish failure is tolerated (the §20.2 acceptance
 * criterion — never throws). A real RS256 keypair is minted with `jose` so the
 * signer runs end-to-end.
 */

import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  callGoogleIndexing,
  GOOGLE_INDEXING_MAX_URLS,
  GOOGLE_PUBLISH_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
} from './google-indexing';

let privateKeyPem: string;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  privateKeyPem = await exportPKCS8(privateKey);
});

const sa = () => ({
  clientEmail: 'svc@aeci.iam.gserviceaccount.com',
  privateKey: privateKeyPem,
});
const URLS = ['https://aecintegrations.com/products/revit', 'https://aecintegrations.com/products'];

function tokenOk(token = 'ya29.test-token'): Response {
  return new Response(
    JSON.stringify({ access_token: token, expires_in: 3600, token_type: 'Bearer' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
function ok(status = 200): Response {
  return new Response('', { status });
}

describe('callGoogleIndexing', () => {
  it('signs an assertion, exchanges it for a token, and publishes each URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenOk()) // token exchange
      .mockResolvedValue(ok()); // each publish

    const outcome = await callGoogleIndexing(fetchMock as unknown as typeof fetch, {
      serviceAccount: sa(),
      urlList: URLS,
    });

    expect(outcome).toEqual({ ok: true, submitted: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 token + 2 publishes

    // Token exchange: form-encoded jwt-bearer grant carrying a signed JWT.
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]!;
    expect(tokenUrl).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(tokenInit.method).toBe('POST');
    expect((tokenInit.headers as Record<string, string>)['content-type']).toContain(
      'x-www-form-urlencoded',
    );
    const tokenBody = new URLSearchParams(tokenInit.body as string);
    expect(tokenBody.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(tokenBody.get('assertion')).toMatch(/^eyJ/); // compact JWS

    // Publish: Bearer-auth JSON URL_UPDATED notification to the indexing endpoint.
    const [pubUrl, pubInit] = fetchMock.mock.calls[1]!;
    expect(pubUrl).toBe(GOOGLE_PUBLISH_ENDPOINT);
    expect(pubInit.method).toBe('POST');
    expect((pubInit.headers as Record<string, string>).authorization).toBe(
      'Bearer ya29.test-token',
    );
    expect(JSON.parse(pubInit.body as string)).toEqual({ url: URLS[0], type: 'URL_UPDATED' });
  });

  it('imports a \\n-escaped single-line private key', async () => {
    const escaped = privateKeyPem.replace(/\n/g, '\\n');
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenOk()).mockResolvedValue(ok());
    const outcome = await callGoogleIndexing(fetchMock as unknown as typeof fetch, {
      serviceAccount: { clientEmail: 'svc@aeci.iam.gserviceaccount.com', privateKey: escaped },
      urlList: [URLS[0]!],
    });
    expect(outcome).toEqual({ ok: true, submitted: 1, failed: 0 });
  });

  it('no-ops to a structured outcome (no fetch) when the service-account email is absent', async () => {
    const fetchMock = vi.fn();
    const outcome = await callGoogleIndexing(fetchMock as unknown as typeof fetch, {
      serviceAccount: { clientEmail: '', privateKey: privateKeyPem },
      urlList: URLS,
    });
    expect(outcome).toEqual({ ok: false, status: 0, message: 'google_indexing_config_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops to a structured outcome (no fetch) when the private key is absent', async () => {
    const fetchMock = vi.fn();
    const outcome = await callGoogleIndexing(fetchMock as unknown as typeof fetch, {
      serviceAccount: { clientEmail: 'svc@aeci.iam.gserviceaccount.com', privateKey: '' },
      urlList: URLS,
    });
    expect(outcome).toEqual({ ok: false, status: 0, message: 'google_indexing_config_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops to a structured outcome (no fetch) when the url list is empty', async () => {
    const fetchMock = vi.fn();
    const outcome = await callGoogleIndexing(fetchMock as unknown as typeof fetch, {
      serviceAccount: sa(),
      urlList: [],
    });
    expect(outcome).toEqual({ ok: false, status: 0, message: 'google_indexing_no_urls' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the status + body message on a token-exchange failure and never publishes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('invalid_grant: bad key', { status: 400 }));
    const outcome = await callGoogleIndexing(fetchMock as unknown as typeof fetch, {
      serviceAccount: sa(),
      urlList: URLS,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ status: 400 });
    expect((outcome as { message: string }).message).toContain('invalid_grant');
    expect(fetchMock).toHaveBeenCalledTimes(1); // token only — no publishes after a failed exchange
  });

  it('returns a structured failure when the token response carries no access_token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const outcome = await callGoogleIndexing(fetchMock as unknown as typeof fetch, {
      serviceAccount: sa(),
      urlList: URLS,
    });
    expect(outcome).toEqual({ ok: false, status: 200, message: 'google_token_no_access_token' });
  });

  it('tallies a partial publish failure without throwing (token still succeeded)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(ok(200)) // url[0] accepted
      .mockResolvedValueOnce(ok(429)); // url[1] rate-limited
    const outcome = await callGoogleIndexing(fetchMock as unknown as typeof fetch, {
      serviceAccount: sa(),
      urlList: URLS,
    });
    expect(outcome).toEqual({ ok: true, submitted: 1, failed: 1 });
  });

  it('counts a publish network rejection as failed (never throws)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenOk())
      .mockRejectedValue(new Error('publish boom'));
    const outcome = await callGoogleIndexing(fetchMock as unknown as typeof fetch, {
      serviceAccount: sa(),
      urlList: URLS,
    });
    expect(outcome).toEqual({ ok: true, submitted: 0, failed: 2 });
  });

  it('never throws when the token exchange rejects — returns a structured outcome', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const outcome = await callGoogleIndexing(fetchMock as unknown as typeof fetch, {
      serviceAccount: sa(),
      urlList: URLS,
    });
    expect(outcome).toEqual({ ok: false, status: 0, message: 'network down' });
  });

  it('returns a structured failure (never throws) when the private key is not valid PKCS#8', async () => {
    const fetchMock = vi.fn();
    const outcome = await callGoogleIndexing(fetchMock as unknown as typeof fetch, {
      serviceAccount: {
        clientEmail: 'svc@aeci.iam.gserviceaccount.com',
        privateKey: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----',
      },
      urlList: URLS,
    });
    expect(outcome.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled(); // signing failed before the token POST
  });

  it('exposes the per-request URL ceiling', () => {
    expect(GOOGLE_INDEXING_MAX_URLS).toBe(100);
  });
});

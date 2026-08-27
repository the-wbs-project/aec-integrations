/**
 * Google Indexing API submission transport (AECI-263).
 *
 * The best-effort Google half of §20.2 (the IndexNow half is `lib/indexnow.ts`,
 * AECI-236). Unlike IndexNow's single keyed POST, Google's Indexing API needs an
 * OAuth2 two-legged flow: sign a short-lived RS256 JWT with the service account's
 * private key, exchange it for an access token at the Google OAuth token endpoint,
 * then POST each affected URL to `urlNotifications:publish` as a `URL_UPDATED`
 * notification.
 *
 * Shaped like `callIndexNow` / `callCloudflarePurge`: *pure transport*, never
 * throws — a signing error, a token-exchange failure, or a per-URL publish error
 * is folded into a structured outcome so the post-promote caller can record it
 * without a try/catch and the committed write is never blocked (§20.2 acceptance
 * criterion). It lives in the API Worker (one call site — the promote post-commit
 * block).
 *
 * `jose` does the RS256 signing on WebCrypto (Workers-clean; already the JWT
 * library used for Supabase token verification). Google service-account keys are
 * RSA-2048 PKCS#8 PEMs, which `importPKCS8` parses directly.
 *
 * `fetchImpl` is injected (defaults to the global `fetch`) so tests can supply a
 * mock without monkey-patching the global.
 */

import { mapWithConcurrency, WORKER_CONNECTION_LIMIT } from '@aeci/shared/concurrency';
import { discardResponseBody } from '@aeci/shared/response-drain';
import { SignJWT, importPKCS8 } from 'jose';

/** Google OAuth2 token endpoint — exchanges the signed JWT for an access token. */
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
/** Google Indexing API publish endpoint — one notification per URL. */
export const GOOGLE_PUBLISH_ENDPOINT =
  'https://indexing.googleapis.com/v3/urlNotifications:publish';
/** OAuth scope the Indexing API requires. */
export const GOOGLE_INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';

/**
 * Defensive per-promote URL ceiling. A single promote produces a handful of URLs
 * and Google's default Indexing API quota is 200 requests/day, so we never
 * approach this — the slice is a guard, never a real truncation.
 */
export const GOOGLE_INDEXING_MAX_URLS = 100;

/**
 * Publish requests in flight at once (AECI-666) — the Cloudflare per-invocation
 * connection limit, so anything above it is queued by the runtime anyway. Keeps
 * the pipe full without parking the whole URL list on the invocation's
 * connection budget alongside the other post-commit hooks.
 */
export const GOOGLE_INDEXING_CONCURRENCY = WORKER_CONNECTION_LIMIT;

export type GoogleServiceAccount = {
  /** Service-account email (`client_email` in the SA JSON) — the JWT `iss`. */
  clientEmail: string;
  /**
   * Service-account private key (`private_key` in the SA JSON): a PKCS#8 PEM
   * (`-----BEGIN PRIVATE KEY-----`). `\n`-escaped keys (stored as single-line
   * secrets) are normalized to real newlines before import.
   */
  privateKey: string;
};

export type GoogleIndexingOutcome =
  /** Access token acquired; `submitted`/`failed` tally the per-URL publishes. */
  | { ok: true; submitted: number; failed: number }
  /** Config / signing / token-exchange failed — nothing was submitted. */
  | { ok: false; status: number; message: string };

export type GoogleIndexingSubmission = {
  serviceAccount: GoogleServiceAccount;
  /** The affected URLs to notify Google about. */
  urlList: string[];
  /** Override the OAuth token endpoint (tests). */
  tokenEndpoint?: string;
  /** Override the publish endpoint (tests). */
  publishEndpoint?: string;
};

/**
 * Submit `urlList` to the Google Indexing API. Never throws; returns a structured
 * outcome. No-ops to a structured `{ ok: false }` (without calling fetch) when the
 * service-account creds are absent or the URL list is empty.
 */
export async function callGoogleIndexing(
  fetchImpl: typeof fetch,
  submission: GoogleIndexingSubmission,
): Promise<GoogleIndexingOutcome> {
  const {
    serviceAccount,
    urlList,
    tokenEndpoint = GOOGLE_TOKEN_ENDPOINT,
    publishEndpoint = GOOGLE_PUBLISH_ENDPOINT,
  } = submission;

  if (!serviceAccount.clientEmail || !serviceAccount.privateKey) {
    return { ok: false, status: 0, message: 'google_indexing_config_missing' };
  }
  if (urlList.length === 0) {
    return { ok: false, status: 0, message: 'google_indexing_no_urls' };
  }

  // 1. Sign the assertion + exchange it for an access token. A signing error (bad
  //    PEM), a network failure, or a non-2xx token response is returned as a
  //    structured outcome — never thrown.
  let accessToken: string;
  try {
    const assertion = await signServiceAccountAssertion(serviceAccount, tokenEndpoint);
    const tokenRes = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!tokenRes.ok) {
      return {
        ok: false,
        status: tokenRes.status,
        message: await readError(tokenRes, 'google_token_failed'),
      };
    }
    const body = (await tokenRes.json()) as { access_token?: string };
    if (!body.access_token) {
      return { ok: false, status: tokenRes.status, message: 'google_token_no_access_token' };
    }
    accessToken = body.access_token;
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : 'google_token_error',
    };
  }

  // 2. Publish each URL independently. A per-URL non-2xx (or a network rejection)
  //    counts as `failed` but never aborts the rest or throws.
  //
  //    Published in bounded waves rather than all at once (AECI-666): the API is
  //    one-notification-per-URL with no batch endpoint, so this is the only hook
  //    whose request count scales with the payload. A single `Promise.allSettled`
  //    over the whole list would open up to `GOOGLE_INDEXING_MAX_URLS` (100)
  //    connections from one invocation, which on its own can exhaust the
  //    invocation's connection budget and get responses cancelled into `fetch`
  //    promises that never settle.
  const publish = (url: string): Promise<boolean> =>
    fetchImpl(publishEndpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url, type: 'URL_UPDATED' }),
    }).then((res) => {
      // Neither path reads the body — release it or the connection stays held.
      discardResponseBody(res);
      return res.ok;
    });

  const results = await mapWithConcurrency(
    urlList.slice(0, GOOGLE_INDEXING_MAX_URLS),
    GOOGLE_INDEXING_CONCURRENCY,
    publish,
  );

  let submitted = 0;
  let failed = 0;
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) submitted++;
    else failed++;
  }
  return { ok: true, submitted, failed };
}

/**
 * Build the short-lived RS256 JWT the OAuth token exchange consumes (two-legged
 * service-account flow: `iss` = the SA email, `aud` = the token endpoint, `scope`
 * = the Indexing scope, 1h lifetime). `jose` signs it on WebCrypto.
 */
async function signServiceAccountAssertion(
  serviceAccount: GoogleServiceAccount,
  audience: string,
): Promise<string> {
  const key = await importPKCS8(serviceAccount.privateKey.replace(/\\n/g, '\n'), 'RS256');
  return new SignJWT({ scope: GOOGLE_INDEXING_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(serviceAccount.clientEmail)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

/** Read a non-2xx response body as the failure message, with a fallback. */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.text()).trim();
    if (body) return body;
  } catch {
    // Body unreadable; statusText / fallback is good enough.
  }
  return res.statusText || fallback;
}

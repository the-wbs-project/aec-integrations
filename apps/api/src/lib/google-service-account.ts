/**
 * The Search Console service account: key parsing and the OAuth token exchange
 * (AECI-1236, shared since AECI-820).
 *
 * Two jobs read Search Console with this one credential, `GSC_SA_KEY_JSON`: the
 * daily URL Inspection run (`gsc-inspect-job.ts`) and the weekly search ingest
 * (`search-ingest.ts`). Both use the read-only scope below. It covers URL
 * Inspection, Search Analytics and the Sitemaps reads, so the account can read the
 * property and never change it.
 *
 * Pure apart from the injected `fetchImpl`, and never throws: a bad key or a
 * refused exchange is a structured result.
 */

import { discardResponseBody } from '@aeci/shared/response-drain';
import { SignJWT, importPKCS8 } from 'jose';

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
/** Read-only. Covers `urlInspection.index.inspect`, `searchanalytics.query` and
 *  `sitemaps.list` (Google's per-method scope lists). */
export const SEARCH_CONSOLE_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
/** The Domain property. It spans `www.`, the apex and `demo.`. */
export const SEARCH_CONSOLE_SITE = 'sc-domain:aecintegrations.com';

export interface GoogleServiceAccount {
  clientEmail: string;
  /** PKCS#8 PEM. `\n`-escaped keys (single-line secrets) are normalized. */
  privateKey: string;
}

/**
 * Parse the service-account key file JSON held in `GSC_SA_KEY_JSON`. Returns
 * null on anything unusable, so a malformed secret reads as "not configured"
 * rather than a crash.
 */
export function parseServiceAccount(json: string | undefined): GoogleServiceAccount | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { client_email?: unknown; private_key?: unknown };
    if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
      return null;
    }
    return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
  } catch {
    return null;
  }
}

/**
 * Why an exchange failed. `refused`: Google rejected the credential (a 4xx other
 * than 429), or the key itself is unusable. An operator must act. `transient`: a
 * 5xx, a 429, a dropped connection or a 200 with no token. Trying later may work.
 */
export type TokenFailureKind = 'refused' | 'transient';

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; kind: TokenFailureKind; message: string };

/** Sign an RS256 assertion and exchange it for a one-hour access token. */
export async function getGoogleAccessToken(
  fetchImpl: typeof fetch,
  account: GoogleServiceAccount,
  tokenEndpoint: string = GOOGLE_TOKEN_ENDPOINT,
): Promise<TokenResult> {
  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(account.privateKey.replace(/\\n/g, '\n'), 'RS256');
  } catch (error) {
    return {
      ok: false,
      kind: 'refused',
      message: error instanceof Error ? error.message : 'key_unusable',
    };
  }
  try {
    const assertion = await new SignJWT({ scope: SEARCH_CONSOLE_READONLY_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(account.clientEmail)
      .setAudience(tokenEndpoint)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    const res = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!res.ok) {
      discardResponseBody(res);
      const transient = res.status >= 500 || res.status === 429;
      return {
        ok: false,
        kind: transient ? 'transient' : 'refused',
        message: `token_http_${res.status}`,
      };
    }
    const body = (await res.json()) as { access_token?: unknown };
    if (typeof body.access_token !== 'string') {
      return { ok: false, kind: 'transient', message: 'token_missing' };
    }
    return { ok: true, token: body.access_token };
  } catch (error) {
    // The key imported, so this is the network or an unreadable body.
    return {
      ok: false,
      kind: 'transient',
      message: error instanceof Error ? error.message : 'token_error',
    };
  }
}

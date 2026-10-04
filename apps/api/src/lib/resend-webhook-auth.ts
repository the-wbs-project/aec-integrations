/**
 * Signature verification for the inbound Resend delivery webhook (`POST /api/webhooks/
 * resend`, AECI-1222).
 *
 * Resend signs webhooks with Svix. The manual check, from
 * `https://docs.svix.com/receiving/verifying-payloads/how-manual` (read 2026-10-02):
 *
 *   - The secret is `whsec_<base64>`. The HMAC key is the base64-DECODED part after the prefix.
 *   - The signed content is `${svix-id}.${svix-timestamp}.${raw body}`.
 *   - The signature is HMAC-SHA256 over it, base64-encoded.
 *   - `svix-signature` holds one or more space-separated `v1,<base64>` entries. Any match passes,
 *     which is how Svix rotates a secret without a gap.
 *   - `svix-timestamp` is unix seconds. We reject one more than five minutes from our clock in
 *     either direction, so a captured request cannot be replayed later.
 *
 * WebCrypto only, no dependency. The compare is constant-time (`timingSafeEqual`).
 *
 * **Fail closed.** No secret, a malformed secret, or a missing header returns a failure
 * reason, never `ok`. The route maps every failure to a 401 before reading the body as JSON.
 */

import { timingSafeEqual } from '@aeci/shared';

/** How far `svix-timestamp` may be from our clock, either way. */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export type SvixFailureReason =
  | 'missing_secret'
  | 'bad_secret'
  | 'missing_headers'
  | 'stale'
  | 'mismatch';

export type SvixVerification = { ok: true } | { ok: false; reason: SvixFailureReason };

export interface SvixInput {
  /** `svix-id` header. */
  id: string | undefined;
  /** `svix-timestamp` header, unix seconds. */
  timestamp: string | undefined;
  /** `svix-signature` header. */
  signature: string | undefined;
  /** The exact request body bytes, as text. */
  rawBody: string;
  /** `RESEND_WEBHOOK_SECRET`, `whsec_…`. */
  secret: string | undefined;
  /** Injectable clock for tests. Defaults to `Date.now()`. */
  nowMs?: number;
}

const SECRET_PREFIX = 'whsec_';

/** Verify one Svix-signed request. Never throws. */
export async function verifySvixSignature(input: SvixInput): Promise<SvixVerification> {
  if (!input.secret) return { ok: false, reason: 'missing_secret' };
  if (!input.id || !input.timestamp || !input.signature) {
    return { ok: false, reason: 'missing_headers' };
  }

  if (!/^\d{1,12}$/.test(input.timestamp)) return { ok: false, reason: 'stale' };
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(input.timestamp)) > SVIX_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale' };
  }

  const keyBytes = decodeSecret(input.secret);
  if (!keyBytes) return { ok: false, reason: 'bad_secret' };

  let expected: string;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signed = new TextEncoder().encode(`${input.id}.${input.timestamp}.${input.rawBody}`);
    expected = bytesToBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, signed)));
  } catch {
    return { ok: false, reason: 'bad_secret' };
  }

  // Compare against every v1 entry, and do not stop at the first match, so the time taken
  // does not say which entry matched.
  let matched = false;
  for (const entry of input.signature.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma < 0 || entry.slice(0, comma) !== 'v1') continue;
    if (timingSafeEqual(entry.slice(comma + 1), expected)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** `whsec_<base64>` → key bytes, or null when the value is not that shape. The prefix is
 *  optional, as in the Svix libraries. */
function decodeSecret(secret: string): Uint8Array<ArrayBuffer> | null {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

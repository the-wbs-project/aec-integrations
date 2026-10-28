/**
 * Signature verification for the inbound Stripe webhook (`POST /api/webhooks/stripe`,
 * AECI-1500, E9.2 of the AECI-1339 epic).
 *
 * The manual check, from `https://docs.stripe.com/webhooks#verify-manually`:
 *
 *   - `Stripe-Signature` is a comma-separated list of `key=value` pairs: one `t=` (unix
 *     seconds) and one or more `v1=` (hex HMAC-SHA256). Other schemes (`v0=`) are
 *     ignored. Several `v1=` entries appear while a secret is being rolled.
 *   - The signed payload is `${t}.${raw body}`.
 *   - The key is the endpoint secret string `whsec_…` itself, used as UTF-8 bytes. Unlike
 *     Svix (`lib/resend-webhook-auth.ts`), Stripe does not base64-decode it.
 *   - `t` more than five minutes from our clock, either way, is refused, so a captured
 *     request cannot be replayed later. Stripe's libraries use the same default.
 *
 * WebCrypto only, no dependency. The compare is constant-time (`timingSafeEqual`), and
 * every `v1=` entry is compared, so the time taken does not say which one matched.
 *
 * **Never throws, fails closed.** No secret, no header, a malformed header, a stale
 * timestamp or no matching signature each return a reason, never `ok`. The route maps
 * every failure to a 401 before the body is parsed as JSON.
 */

import { timingSafeEqual } from '@aeci/shared';

/** How far `t=` may be from our clock, either way. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export type StripeSignatureFailureReason =
  /** `STRIPE_WEBHOOK_SECRET` is unset or blank. */
  | 'missing_secret'
  /** No `Stripe-Signature` header. */
  | 'missing_header'
  /** The header has no usable `t=` or no `v1=`. */
  | 'malformed_header'
  /** `t=` is outside the tolerance. */
  | 'stale'
  /** No `v1=` entry matches. */
  | 'mismatch';

export type StripeSignatureVerification =
  | { ok: true; timestamp: number }
  | { ok: false; reason: StripeSignatureFailureReason };

export interface StripeSignatureInput {
  /** The `Stripe-Signature` header. */
  header: string | undefined | null;
  /** The exact request body bytes, as text. */
  rawBody: string;
  /** `STRIPE_WEBHOOK_SECRET`, `whsec_…`. */
  secret: string | undefined | null;
  /** Injectable clock for tests. Defaults to `Date.now()`. */
  nowMs?: number;
  /** Defaults to {@link STRIPE_SIGNATURE_TOLERANCE_SECONDS}. */
  toleranceSeconds?: number;
}

/** The parsed header: the timestamp and every `v1` signature. */
export function parseStripeSignatureHeader(header: string): {
  timestamp: string | null;
  signatures: string[];
} {
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && timestamp === null) timestamp = value;
    else if (key === 'v1' && value) signatures.push(value.toLowerCase());
  }
  return { timestamp, signatures };
}

/** Verify one Stripe-signed request. Never throws. */
export async function verifyStripeSignature(
  input: StripeSignatureInput,
): Promise<StripeSignatureVerification> {
  const secret = input.secret?.trim();
  if (!secret) return { ok: false, reason: 'missing_secret' };
  if (!input.header) return { ok: false, reason: 'missing_header' };

  const { timestamp, signatures } = parseStripeSignatureHeader(input.header);
  if (timestamp === null || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) {
    return { ok: false, reason: 'malformed_header' };
  }
  const tolerance = input.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const t = Number(timestamp);
  if (Math.abs(nowSeconds - t) > tolerance) return { ok: false, reason: 'stale' };

  let expected: string;
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${timestamp}.${input.rawBody}`),
    );
    expected = toHex(new Uint8Array(mac));
  } catch {
    // WebCrypto refusing a UTF-8 key is not expected. Fail closed as a mismatch.
    return { ok: false, reason: 'mismatch' };
  }

  let matched = false;
  for (const signature of signatures) {
    if (timingSafeEqual(signature, expected)) matched = true;
  }
  return matched ? { ok: true, timestamp: t } : { ok: false, reason: 'mismatch' };
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

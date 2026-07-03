/**
 * Signature verification for the inbound Linear webhook (`POST /api/webhooks/
 * linear`, AECI-212 / Phase 6.5).
 *
 * Linear signs each delivery with an HMAC-SHA256 of the **raw request body**,
 * hex-encoded, sent in the `Linear-Signature` header and keyed by the per-
 * webhook signing secret (`LINEAR_WEBHOOK_SIGNING_SECRET`). We recompute the
 * digest over the exact bytes received and compare constant-time, mirroring the
 * M2M-token approach in `lib/review-auth.ts`.
 *
 * **Fail closed:** a missing header OR an unset secret returns `false` (the
 * handler maps that to `401`). An unconfigured secret must never let an
 * unauthenticated payload mutate `vendor_requests` — the verification gate is
 * the only thing standing between the public-internet webhook URL and a write.
 *
 * The compare is constant-time so a timing side-channel can't recover the digest
 * byte-by-byte. A length mismatch returns early — that leaks only the digest
 * length (constant: 64 hex chars), which is not sensitive.
 *
 * Replay protection (rejecting a stale `webhookTimestamp`) is intentionally left
 * out of v1: it adds clock-skew failure modes for a low-volume internal webhook,
 * and the HMAC already prevents forgery. Revisit if replay becomes a concern.
 */

import { timingSafeEqual } from '@aeci/shared';

/** Hex-encode an ArrayBuffer. Matches `routes/page-views.ts:sha256Hex`. */
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Recompute the HMAC-SHA256 of `rawBody` under `secret` and constant-time
 * compare it to the presented `Linear-Signature` value. Returns `false` (never
 * throws) when the header or secret is absent — the caller renders the 401.
 */
export async function verifyLinearSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string | undefined,
): Promise<boolean> {
  if (!signature || !secret) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));

  return timingSafeEqual(toHex(digest), signature);
}

/**
 * Shared hashing helpers for the API Worker (Web Crypto, no dependencies).
 *
 * `sha256Hex` was private to `routes/page-views.ts`, and `lib/linear-webhook-auth.ts`
 * carried its own hex encoder. Both now import from here.
 */

/** Hex-encode bytes, two lowercase hex digits per byte. */
export function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** SHA-256 of the UTF-8 encoding of `input`, as 64 lowercase hex chars. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(digest);
}

/**
 * A stable, unsalted hash of an email address for logs (AECI-1198). The address is
 * trimmed and lowercased first, so `A@B.com ` and `a@b.com` hash the same. It lets an
 * operator match a suppressed send to a known address without the log holding the
 * address itself.
 */
export function recipientHash(address: string): Promise<string> {
  return sha256Hex(address.trim().toLowerCase());
}

/** HMAC-SHA256 of the UTF-8 `message` under raw `key` bytes, as raw bytes. */
async function hmacSha256(key: BufferSource, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

/**
 * A client IP as a keyed hash for the raw page-view store (AECI-1384, ADR 0041).
 *
 * The key rotates monthly: `monthKey = HMAC(secret, 'YYYY-MM')` in UTC, then
 * `HMAC(monthKey, ip)`. The same visitor hashes the same within a month and
 * differently across months, so the store cannot follow one address for its whole
 * 400-day life. Returns null when the secret or the IP is absent. There is no
 * unkeyed fallback: a bare SHA-256 of an IPv4 address is reversible by enumeration.
 */
export async function monthlyIpHash(
  secret: string | undefined,
  ip: string | null,
  at: Date,
): Promise<string | null> {
  if (!secret || !ip) return null;
  const month = at.toISOString().slice(0, 7);
  const monthKey = await hmacSha256(new TextEncoder().encode(secret), month);
  return bytesToHex(await hmacSha256(monthKey, ip.trim()));
}

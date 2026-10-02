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

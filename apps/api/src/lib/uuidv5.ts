/**
 * RFC 9562 §5.5 UUIDv5 (SHA-1, name-based), on Web Crypto so it runs in Node and in a
 * Worker alike. The construction `seed/trades.sql` documents and `d1.spec.ts` pins.
 *
 * As built (AECI-1358, 2026-10-17): moved here from `lib/backfill-licenses.ts` when
 * that one-off back-fill was deleted. The admin license grant (`routes/admin-licenses.ts`)
 * mints its ids with it.
 */

/** RFC 9562 URL namespace. */
export const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

export async function uuidv5(name: string, namespace: string): Promise<string> {
  const hex = namespace.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new RangeError(`not a UUID: ${namespace}`);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  for (let i = 0; i < 16; i++) input[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  input.set(nameBytes, 16);
  const b = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).slice(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50; // version 5
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const out = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

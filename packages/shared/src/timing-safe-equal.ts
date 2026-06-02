/**
 * Constant-time string equality over UTF-8 bytes. The single audited comparator
 * shared by every M2M auth boundary (review-app push token, admin-purge token),
 * so the security primitive lives in exactly one place rather than drifting
 * across hand-rolled copies.
 *
 * Encodes both inputs with `TextEncoder` and XOR-accumulates the byte diff: the
 * comparison time does not depend on *where* the first mismatch is, so a timing
 * side-channel can't be used to recover the secret byte-by-byte.
 *
 * A length mismatch returns early — this leaks only the secret's length, which
 * is not sensitive for the high-entropy tokens this guards.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let mismatch = 0;
  for (let i = 0; i < ab.length; i += 1) mismatch |= ab[i] ^ bb[i];
  return mismatch === 0;
}

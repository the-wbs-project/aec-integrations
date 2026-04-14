// ---------------------------------------------------------------------------
// KV-backed cache with configurable TTL (default 60 s).
// ---------------------------------------------------------------------------

const DEFAULT_TTL_S = 60;

/**
 * Get-or-fetch helper. Returns the KV-cached value when fresh, otherwise
 * calls `fetcher`, writes the result to KV with an expiration, and returns it.
 */
export async function cacheFetch<T>(
  kv: KVNamespace,
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds = DEFAULT_TTL_S,
): Promise<T> {
  const cached = await kv.get<T>(key, 'json');
  if (cached !== null) return cached;

  const data = await fetcher();
  await kv.put(key, JSON.stringify(data), { expirationTtl: ttlSeconds });
  return data;
}

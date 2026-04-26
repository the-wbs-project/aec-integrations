// ---------------------------------------------------------------------------
// Generic KV get-or-fetch wrapper. Mirrors apps/review-app/server/cache.ts.
// ---------------------------------------------------------------------------

const DEFAULT_TTL_S = 60;

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

export async function cacheInvalidate(kv: KVNamespace, key: string): Promise<void> {
  await kv.delete(key);
}

// ---------------------------------------------------------------------------
// SerpAPI provider — ported from apps/n8n-utils/src/providers/serpapi.ts.
// Returns a plain object instead of a Response, with KV caching against
// the new worker's KV_CACHE binding.
// ---------------------------------------------------------------------------
import type { Env } from '../../env';
import { CACHE_TTL_S } from '../../env';
import { paramsToQueryString, stripFavicons } from './common';
import type { SerpResult } from './index';

const SERP_API_BASE = 'https://serpapi.com/search';

export async function searchSerpApi(env: Env, params: Record<string, string>): Promise<SerpResult> {
  const query = paramsToQueryString(params);
  if (!query) {
    return { status: 400, body: { error: 'No query parameters provided' }, cached: false };
  }

  const cacheKey = `serp:serpapi:${query}`;
  const cached = await env.KV_CACHE.get(cacheKey, 'json');
  if (cached !== null) {
    return { status: 200, body: cached as Record<string, unknown>, cached: true };
  }

  const serpUrl = new URL(SERP_API_BASE);
  serpUrl.search = query;
  serpUrl.searchParams.set('api_key', env.SERP_API_KEY);

  const response = await fetch(serpUrl.toString());

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '<unreadable>');
    console.error(`serpapi: request failed status=${response.status} query=${query} body=${errorBody}`);
    return {
      status: 502,
      body: { error: 'SerpApi request failed', status: response.status, upstream: errorBody },
      cached: false,
    };
  }

  const raw = (await response.json()) as Record<string, unknown>;
  stripFavicons(raw);

  if (Object.keys(raw).length > 0) {
    await env.KV_CACHE.put(cacheKey, JSON.stringify(raw), { expirationTtl: CACHE_TTL_S });
  }

  return { status: 200, body: raw, cached: false };
}

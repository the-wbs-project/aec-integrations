// ---------------------------------------------------------------------------
// SearchAPI.io provider — ported from apps/n8n-utils/src/providers/searchapi.ts.
// ---------------------------------------------------------------------------
import type { Env } from '../../env';
import { CACHE_TTL_S } from '../../env';
import { paramsToQueryString, stripFavicons } from './common';
import type { SerpResult } from './index';

const SEARCHAPI_BASE = 'https://www.searchapi.io/api/v1/search';

export async function searchSearchApi(env: Env, params: Record<string, string>): Promise<SerpResult> {
  const query = paramsToQueryString(params);
  if (!query) {
    return { status: 400, body: { error: 'No query parameters provided' }, cached: false };
  }

  const cacheKey = `serp:searchapi:${query}`;
  const cached = await env.KV_CACHE.get(cacheKey, 'json');
  if (cached !== null) {
    return { status: 200, body: cached as Record<string, unknown>, cached: true };
  }

  const searchUrl = new URL(SEARCHAPI_BASE);
  searchUrl.search = query;
  searchUrl.searchParams.set('engine', searchUrl.searchParams.get('engine') ?? 'google');
  searchUrl.searchParams.set('api_key', env.SEARCHAPI_API_KEY);

  const response = await fetch(searchUrl.toString());

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '<unreadable>');
    console.error(`searchapi: request failed status=${response.status} query=${query} body=${errorBody}`);
    return {
      status: 502,
      body: { error: 'SearchAPI.io request failed', status: response.status, upstream: errorBody },
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

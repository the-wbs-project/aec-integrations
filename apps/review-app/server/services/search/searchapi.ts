// ---------------------------------------------------------------------------
// SearchAPI.io provider — ported from apps/n8n-utils/src/providers/searchapi.ts.
// ---------------------------------------------------------------------------
import type { Env } from '../../env';
import { CACHE_TTL_S } from '../../env';
import { paramsToQueryString, stripFavicons } from './common';
import type { SerpAttribution, SerpResult } from './index';
import { recordSearch } from '../reports/searchapiUsage';

const SEARCHAPI_BASE = 'https://www.searchapi.io/api/v1/search';

export async function searchSearchApi(
  env: Env,
  params: Record<string, string>,
  attribution?: SerpAttribution,
): Promise<SerpResult> {
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
  const engine = searchUrl.searchParams.get('engine') ?? 'google';
  searchUrl.searchParams.set('engine', engine);
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

  // Persist a search_id → workflow mapping so the weekly cost report can
  // attribute SearchAPI charges back to the workflow that issued them.
  if (attribution) {
    const meta = raw['search_metadata'] as { id?: unknown; query?: unknown } | undefined;
    const searchId = typeof meta?.id === 'string' ? meta.id : undefined;
    if (searchId) {
      const queryStr = typeof meta?.query === 'string' ? meta.query : (params['q'] ?? '');
      // Fire-and-forget: don't block the search response on KV.
      await recordSearch(env, {
        searchId,
        runId: attribution.runId,
        workflow: attribution.workflow,
        engine,
        query: queryStr,
      });
    }
  }

  if (Object.keys(raw).length > 0) {
    await env.KV_CACHE.put(cacheKey, JSON.stringify(raw), { expirationTtl: CACHE_TTL_S });
  }

  return { status: 200, body: raw, cached: false };
}

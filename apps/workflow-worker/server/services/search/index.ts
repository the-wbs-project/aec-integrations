// ---------------------------------------------------------------------------
// SERP service — dispatch on env.SEARCH_PROVIDER.
// ---------------------------------------------------------------------------
import type { Env, SearchProvider } from '../../env';
import { searchSerpApi } from './serpapi';
import { searchSearchApi } from './searchapi';

export interface SerpResult {
  status: number;
  body: Record<string, unknown>;
  cached: boolean;
}

export async function runSerpSearch(
  env: Env,
  params: Record<string, string>,
  providerOverride?: SearchProvider,
): Promise<SerpResult> {
  const provider = providerOverride ?? env.SEARCH_PROVIDER ?? 'searchapi';
  switch (provider) {
    case 'searchapi':
      return searchSearchApi(env, params);
    case 'serpapi':
      return searchSerpApi(env, params);
    default:
      console.error(`runSerpSearch: unknown provider=${provider}`);
      return { status: 500, body: { error: `Unknown SEARCH_PROVIDER: ${provider}` }, cached: false };
  }
}

/**
 * Convenience: extract organic results as a compact array suitable for
 * feeding back to Claude as a tool_result.
 */
export interface OrganicResult {
  position?: number;
  title?: string;
  link?: string;
  snippet?: string;
}

export function pickOrganicResults(serpBody: Record<string, unknown>, limit = 5): OrganicResult[] {
  const organic = serpBody['organic_results'];
  if (!Array.isArray(organic)) return [];
  return organic.slice(0, limit).map((r) => {
    const item = r as Record<string, unknown>;
    return {
      position: item['position'] as number | undefined,
      title: item['title'] as string | undefined,
      link: item['link'] as string | undefined,
      snippet: item['snippet'] as string | undefined,
    };
  });
}

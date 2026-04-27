// ---------------------------------------------------------------------------
// SERP service — single-provider wrapper around SearchAPI.io.
//
// SerpAPI was removed; SearchAPI is the only provider. The function name
// stays `runSerpSearch` because callers (workflows) use it as the generic
// "run a Google search" entry point.
// ---------------------------------------------------------------------------
import type { Env } from '../../env';
import { searchSearchApi } from './searchapi';

export interface SerpResult {
  status: number;
  body: Record<string, unknown>;
  cached: boolean;
}

/** Optional attribution for usage tracking (workflow + runId). */
export interface SerpAttribution {
  runId: string;
  workflow: string;
}

export async function runSerpSearch(
  env: Env,
  params: Record<string, string>,
  attribution?: SerpAttribution,
): Promise<SerpResult> {
  return searchSearchApi(env, params, attribution);
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

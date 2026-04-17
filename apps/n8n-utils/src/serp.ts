import type { Env } from "./index";
import { json } from "./index";
import { searchProvider as serpapiProvider } from "./providers/serpapi";
import { searchProvider as searchapiProvider } from "./providers/searchapi";

export async function handleSerp(url: URL, env: Env): Promise<Response> {
  switch (env.SEARCH_PROVIDER) {
    case "searchapi":
      return searchapiProvider(url, env);
    case "serpapi":
    case undefined:
      return serpapiProvider(url, env);
    default:
      console.error(`serp: unknown SEARCH_PROVIDER=${env.SEARCH_PROVIDER}`);
      return json(
        { error: `Unknown SEARCH_PROVIDER: ${env.SEARCH_PROVIDER}` },
        500
      );
  }
}

export function stripFavicons(raw: Record<string, unknown>): void {
  const organic = raw.organic_results;
  if (!Array.isArray(organic)) return;
  for (const result of organic) {
    if (result && typeof result === "object") {
      delete (result as Record<string, unknown>).favicon;
    }
  }
}

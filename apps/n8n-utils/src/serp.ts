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
      return json(
        { error: `Unknown SEARCH_PROVIDER: ${env.SEARCH_PROVIDER}` },
        500
      );
  }
}

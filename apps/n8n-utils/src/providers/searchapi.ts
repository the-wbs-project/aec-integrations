import type { Env } from "../index";
import { json, CACHE_TTL } from "../index";

const SEARCHAPI_BASE = "https://www.searchapi.io/api/v1/search";

export async function searchProvider(url: URL, env: Env): Promise<Response> {
  const query = url.searchParams.toString();

  if (!query) {
    return json({ error: "No query parameters provided" }, 400);
  }

  const cacheKey = `serp:searchapi:${query}`;

  const cached = await env.KV_CACHE.get(cacheKey);
  if (cached !== null) {
    return new Response(cached, {
      headers: {
        "Content-Type": "application/json",
        "X-Cache": "HIT",
      },
    });
  }

  const searchUrl = new URL(SEARCHAPI_BASE);
  searchUrl.search = query;
  searchUrl.searchParams.set("engine", "google");
  searchUrl.searchParams.set("api_key", env.SEARCHAPI_API_KEY);

  const searchResponse = await fetch(searchUrl.toString());

  if (!searchResponse.ok) {
    return json(
      { error: "SearchAPI.io request failed", status: searchResponse.status },
      502
    );
  }

  const raw = (await searchResponse.json()) as Record<string, unknown>;
  const body = JSON.stringify({
    organic_results: raw.organic_results,
    knowledge_graph: raw.knowledge_graph,
  });

  await env.KV_CACHE.put(cacheKey, body, { expirationTtl: CACHE_TTL });

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "X-Cache": "MISS",
    },
  });
}

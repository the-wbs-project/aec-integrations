import type { Env } from "../index";
import { json, CACHE_TTL } from "../index";
import { stripFavicons } from "../serp";

const SERP_API_BASE = "https://serpapi.com/search";

export async function searchProvider(url: URL, env: Env): Promise<Response> {
  const query = url.searchParams.toString();

  if (!query) {
    return json({ error: "No query parameters provided" }, 400);
  }

  const cacheKey = `serp:serpapi:${query}`;

  const cached = await env.KV_CACHE.get(cacheKey);
  if (cached !== null) {
    return new Response(cached, {
      headers: {
        "Content-Type": "application/json",
        "X-Cache": "HIT",
      },
    });
  }

  const serpUrl = new URL(SERP_API_BASE);
  serpUrl.search = query;
  serpUrl.searchParams.set("api_key", env.SERP_API_KEY);

  const serpResponse = await fetch(serpUrl.toString());

  if (!serpResponse.ok) {
    const errorBody = await serpResponse.text().catch(() => "<unreadable>");
    console.error(
      `serpapi: request failed status=${serpResponse.status} query=${query} body=${errorBody}`
    );
    return json(
      {
        error: "SerpApi request failed",
        status: serpResponse.status,
        upstream: errorBody,
      },
      502
    );
  }

  const raw = (await serpResponse.json()) as Record<string, unknown>;
  stripFavicons(raw);
  const body = JSON.stringify(raw);

  if (body !== "{}") {
    await env.KV_CACHE.put(cacheKey, body, { expirationTtl: CACHE_TTL });
  }

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "X-Cache": "MISS",
    },
  });
}

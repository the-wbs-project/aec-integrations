interface Env {
  SERP_CACHE: KVNamespace;
  AUTH_TOKEN: string;
  SERP_API_KEY: string;
}

const CACHE_TTL = 60 * 60 * 24; // 1 day in seconds
const SERP_API_BASE = "https://serpapi.com/search";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only allow GET requests
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    // Authenticate via bearer token
    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (token !== env.AUTH_TOKEN) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Build cache key from the incoming query string (no API key)
    const url = new URL(request.url);
    const cacheKey = url.search; // e.g. "?q=test&engine=google"

    if (!cacheKey) {
      return json({ error: "No query parameters provided" }, 400);
    }

    // Check KV cache
    const cached = await env.SERP_CACHE.get(cacheKey);
    if (cached !== null) {
      return new Response(cached, {
        headers: {
          "Content-Type": "application/json",
          "X-Cache": "HIT",
        },
      });
    }

    // Cache miss — fetch from SerpApi with the API key appended
    const serpUrl = new URL(SERP_API_BASE);
    serpUrl.search = cacheKey;
    serpUrl.searchParams.set("api_key", env.SERP_API_KEY);

    const serpResponse = await fetch(serpUrl.toString());

    if (!serpResponse.ok) {
      return json(
        { error: "SerpApi request failed", status: serpResponse.status },
        502
      );
    }

    const body = await serpResponse.text();

    // Store in KV with 1-day expiration
    await env.SERP_CACHE.put(cacheKey, body, { expirationTtl: CACHE_TTL });

    return new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "X-Cache": "MISS",
      },
    });
  },
} satisfies ExportedHandler<Env>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

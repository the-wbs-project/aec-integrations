import puppeteer from "@cloudflare/puppeteer";
import { handleSerp } from "./serp";
import { handleRender } from "./render";

export interface Env {
  KV_CACHE: KVNamespace;
  AUTH_TOKEN: string;
  SERP_API_KEY: string;
  SEARCHAPI_API_KEY: string;
  SEARCH_PROVIDER: "serpapi" | "searchapi";
  BROWSER: puppeteer.BrowserWorker;
}

export const CACHE_TTL = 60 * 60 * 24; // 1 day in seconds

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (token !== env.AUTH_TOKEN) {
      return json({ error: "Unauthorized" }, 401);
    }

    const url = new URL(request.url);
    switch (url.pathname) {
      case "/serp":
        return handleSerp(url, env);
      case "/render":
        return handleRender(url, env);
      default:
        return json({ error: "Not found" }, 404);
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Scrapfly proxy service. Fetches Crunchbase organization pages with anti-bot
// bypass and JS rendering.
//
// Cloudflare blocks our worker IPs from reaching crunchbase.com directly
// (verified Apr 2026 — see plan in /Users/chris/.claude/plans/ok-i-want-the-soft-puppy.md).
// Scrapfly's `asp=true` setting routes through residential proxies and solves
// JS challenges for us; `render_js=true` runs the page in a real browser so
// the rehydrated DOM (which holds the Phone/Email/Lists blocks) is captured.
//
// Caches the rendered HTML in KV under `cb:<slug>` for 30 days. Crunchbase
// data doesn't churn faster than that, and `crunchbase_checked_at` on the
// vendor record drives orchestrator-level re-scrape decisions independently.
// ---------------------------------------------------------------------------
import type { Env } from '../env';

// Crunchbase pages typically resolve in 60-120s through Scrapfly's anti-bot
// + JS-render pipeline. Scrapfly's documented default sync read timeout is
// 155s, so we ask Scrapfly for 150s of work and give ourselves a 180s
// AbortSignal cushion to receive the response. Don't drop these without
// re-checking https://scrapfly.io/docs/scrape-api/getting-started.
const SCRAPE_TIMEOUT_MS = 180_000;
const SCRAPFLY_TIMEOUT_MS = 150_000;
const CACHE_TTL_S = 30 * 24 * 60 * 60; // 30 days
const MAX_HTML_SIZE = 5 * 1024 * 1024; // 5 MB; matches services/render.ts

const CRUNCHBASE_ORG_URL = /^https?:\/\/(www\.)?crunchbase\.com\/organization\/([a-z0-9-]+)\/?/i;
const CLOUDFLARE_BLOCK = /Sorry, you have been blocked|Attention Required! \| Cloudflare/;

export interface ScrapeResult {
  successful: boolean;
  html: string | null;
  /** Scrapfly credits charged (from x-scrapfly-api-cost header). */
  cost: number;
  /** Crunchbase response status (`result.status_code` from the wrapper). */
  targetStatus: number | null;
  error: string | null;
}

/**
 * Fetch a Crunchbase organization page via Scrapfly. Returns the rendered
 * HTML on success. On failure (Scrapfly outage, target 5xx, Cloudflare block,
 * or our key being missing/invalid) returns `successful: false` with an
 * `error` describing what happened — never throws, so the caller can fall
 * through to its backup path.
 */
export async function scrapeCrunchbaseOrg(
  env: Env,
  url: string,
): Promise<ScrapeResult> {
  if (!env.SCRAPFLY_API_KEY) {
    return {
      successful: false,
      html: null,
      cost: 0,
      targetStatus: null,
      error: 'SCRAPFLY_API_KEY is not set',
    };
  }

  const slugMatch = url.match(CRUNCHBASE_ORG_URL);
  if (!slugMatch) {
    return {
      successful: false,
      html: null,
      cost: 0,
      targetStatus: null,
      error: `URL is not a Crunchbase organization page: ${url}`,
    };
  }
  const slug = slugMatch[2];
  const cacheKey = `cb:${slug}`;

  const cached = await env.KV_CACHE.get(cacheKey);
  if (cached !== null) {
    return {
      successful: true,
      html: cached,
      cost: 0,
      targetStatus: 200,
      error: null,
    };
  }

  // Scrapfly request. asp=true is the anti-scraping protection (~25-100
  // credits per call); render_js=true runs the page through a headless
  // browser so the rehydrated DOM is captured.
  const params = new URLSearchParams({
    url,
    key: env.SCRAPFLY_API_KEY,
    asp: 'true',
    render_js: 'true',
    country: 'us',
    timeout: String(SCRAPFLY_TIMEOUT_MS),
  });

  let res: Response;
  try {
    res = await fetch(`https://api.scrapfly.io/scrape?${params.toString()}`, {
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      successful: false,
      html: null,
      cost: 0,
      targetStatus: null,
      error: `Scrapfly fetch threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const cost = Number(res.headers.get('x-scrapfly-api-cost') ?? '0');

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      successful: false,
      html: null,
      cost,
      targetStatus: null,
      error: `Scrapfly HTTP ${res.status}: ${text.slice(0, 300)}`,
    };
  }

  let body: { result?: { status_code?: number; content?: string; error?: { message?: string } | null } };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    return {
      successful: false,
      html: null,
      cost,
      targetStatus: null,
      error: `Scrapfly JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const inner = body.result;
  if (!inner) {
    return {
      successful: false,
      html: null,
      cost,
      targetStatus: null,
      error: 'Scrapfly response missing result wrapper',
    };
  }

  const targetStatus = typeof inner.status_code === 'number' ? inner.status_code : null;
  const html = typeof inner.content === 'string' ? inner.content : '';

  if (inner.error?.message) {
    return {
      successful: false,
      html: null,
      cost,
      targetStatus,
      error: `Scrapfly target error: ${inner.error.message}`,
    };
  }

  if (targetStatus !== null && (targetStatus < 200 || targetStatus >= 300)) {
    return {
      successful: false,
      html: null,
      cost,
      targetStatus,
      error: `Crunchbase returned HTTP ${targetStatus}`,
    };
  }

  if (!html || html.length === 0) {
    return {
      successful: false,
      html: null,
      cost,
      targetStatus,
      error: 'Scrapfly returned empty content',
    };
  }

  if (CLOUDFLARE_BLOCK.test(html)) {
    return {
      successful: false,
      html: null,
      cost,
      targetStatus,
      error: 'Cloudflare block page detected despite asp=true',
    };
  }

  // Don't cache absurdly large pages — Crunchbase pages stay around 1.5 MB
  // and anything bigger usually means something else got served.
  if (html.length > MAX_HTML_SIZE) {
    return {
      successful: false,
      html: null,
      cost,
      targetStatus,
      error: `Rendered page exceeds ${MAX_HTML_SIZE} bytes (${html.length})`,
    };
  }

  await env.KV_CACHE.put(cacheKey, html, { expirationTtl: CACHE_TTL_S });

  return {
    successful: true,
    html,
    cost,
    targetStatus,
    error: null,
  };
}

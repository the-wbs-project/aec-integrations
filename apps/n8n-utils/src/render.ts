import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./index";
import { CACHE_TTL } from "./index";

const MAX_HTML_SIZE = 5 * 1024 * 1024; // 5 MB

interface RenderResponse {
  successful: boolean;
  results: string | null;
  error: string | null;
}

function renderJson(payload: RenderResponse): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleRender(url: URL, env: Env): Promise<Response> {
  const targetUrl = url.searchParams.get("url");

  if (!targetUrl) {
    return renderJson({
      successful: false,
      results: null,
      error: "Missing required 'url' parameter",
    });
  }

  if (!targetUrl.startsWith("https://")) {
    return renderJson({
      successful: false,
      results: null,
      error: "Only https:// URLs are accepted",
    });
  }

  const mode = url.searchParams.get("mode");
  const maxChars = parseInt(url.searchParams.get("maxChars") || "0", 10);
  const cacheSuffix = mode === "text" ? `:text:${maxChars || "full"}` : "";
  const cacheKey = `render:${targetUrl}${cacheSuffix}`;

  const cached = await env.KV_CACHE.get(cacheKey);
  if (cached !== null) {
    return renderJson({ successful: true, results: cached, error: null });
  }

  let browser: puppeteer.Browser | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    // Look like a real browser to avoid bot detection / stalls
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const response = await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    const status = response?.status() ?? 502;

    if (status < 200 || status >= 300) {
      console.error(
        `render: target ${targetUrl} returned HTTP ${status}`
      );
      return renderJson({
        successful: false,
        results: null,
        error: `Target page returned HTTP ${status}`,
      });
    }

    let body: string;

    if (mode === "text") {
      // Strip non-content elements, then extract text
      body = await page.evaluate(() => {
        document
          .querySelectorAll(
            "script, style, nav, footer, header, aside, svg, noscript, iframe, [role='navigation'], [role='banner'], [role='contentinfo']"
          )
          .forEach((el) => el.remove());

        // Prefer <article> or <main> content if available
        const article =
          document.querySelector("article") ||
          document.querySelector("main") ||
          document.body;
        return article.innerText;
      });
    } else {
      body = await page.content();
    }

    if (body.length > MAX_HTML_SIZE) {
      console.error(
        `render: ${targetUrl} body size ${body.length} exceeds ${MAX_HTML_SIZE}`
      );
      return renderJson({
        successful: false,
        results: null,
        error: "Rendered page exceeds 5 MB limit",
      });
    }

    if (maxChars > 0 && body.length > maxChars) {
      body = body.substring(0, maxChars);
    }

    await env.KV_CACHE.put(cacheKey, body, {
      expirationTtl: CACHE_TTL,
    });

    return renderJson({ successful: true, results: body, error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`render: browser rendering ${targetUrl} failed:`, err);
    return renderJson({
      successful: false,
      results: null,
      error: `Browser rendering failed: ${message}`,
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

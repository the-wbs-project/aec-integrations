import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./index";
import { json, CACHE_TTL } from "./index";

const MAX_HTML_SIZE = 5 * 1024 * 1024; // 5 MB

export async function handleRender(url: URL, env: Env): Promise<Response> {
  const targetUrl = url.searchParams.get("url");

  if (!targetUrl) {
    return json({ error: "Missing required 'url' parameter" }, 400);
  }

  if (!targetUrl.startsWith("https://")) {
    return json({ error: "Only https:// URLs are accepted" }, 400);
  }

  const mode = url.searchParams.get("mode");
  const maxChars = parseInt(url.searchParams.get("maxChars") || "0", 10);
  const cacheSuffix = mode === "text" ? `:text:${maxChars || "full"}` : "";
  const cacheKey = `render:${targetUrl}${cacheSuffix}`;

  const cached = await env.KV_CACHE.get(cacheKey);
  if (cached !== null) {
    const contentType =
      mode === "text" ? "text/plain; charset=utf-8" : "text/html; charset=utf-8";
    return new Response(cached, {
      headers: {
        "Content-Type": contentType,
        "X-Cache": "HIT",
      },
    });
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

    // Return a 200 with an error message so downstream tools don't hard-fail
    if (status < 200 || status >= 300) {
      return json(
        { error: `Target page returned HTTP ${status}`, status, url: targetUrl },
        200
      );
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
      return json({ error: "Rendered page exceeds 5 MB limit" }, 413);
    }

    if (maxChars > 0 && body.length > maxChars) {
      body = body.substring(0, maxChars);
    }

    await env.KV_CACHE.put(cacheKey, body, {
      expirationTtl: CACHE_TTL,
    });

    return new Response(body, {
      headers: {
        "Content-Type":
          mode === "text"
            ? "text/plain; charset=utf-8"
            : "text/html; charset=utf-8",
        "X-Cache": "MISS",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return json({ error: "Browser rendering failed", detail: message }, 502);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

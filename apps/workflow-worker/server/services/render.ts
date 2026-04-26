// ---------------------------------------------------------------------------
// Browser render service — ported from apps/n8n-utils/src/render.ts.
// Returns a plain object instead of a Response.
// ---------------------------------------------------------------------------
import puppeteer from '@cloudflare/puppeteer';
import type { Env } from '../env';
import { CACHE_TTL_S } from '../env';

const MAX_HTML_SIZE = 5 * 1024 * 1024; // 5 MB

export interface RenderResult {
  successful: boolean;
  results: string | null;
  error: string | null;
}

export interface RenderOptions {
  mode?: 'html' | 'text';
  maxChars?: number;
}

export async function renderPage(
  env: Env,
  targetUrl: string,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  if (!targetUrl.startsWith('https://')) {
    return { successful: false, results: null, error: 'Only https:// URLs are accepted' };
  }

  const mode = opts.mode ?? 'html';
  const maxChars = opts.maxChars ?? 0;
  const cacheSuffix = mode === 'text' ? `:text:${maxChars || 'full'}` : '';
  const cacheKey = `render:${targetUrl}${cacheSuffix}`;

  const cached = await env.KV_CACHE.get(cacheKey);
  if (cached !== null) {
    return { successful: true, results: cached, error: null };
  }

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    );
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });

    const status = response?.status() ?? 502;
    if (status < 200 || status >= 300) {
      console.error(`render: target ${targetUrl} returned HTTP ${status}`);
      return { successful: false, results: null, error: `Target page returned HTTP ${status}` };
    }

    let body: string;
    if (mode === 'text') {
      body = await page.evaluate(() => {
        document
          .querySelectorAll(
            "script, style, nav, footer, header, aside, svg, noscript, iframe, [role='navigation'], [role='banner'], [role='contentinfo']",
          )
          .forEach((el) => el.remove());
        const article = document.querySelector('article') || document.querySelector('main') || document.body;
        return (article as HTMLElement).innerText;
      });
    } else {
      body = await page.content();
    }

    if (body.length > MAX_HTML_SIZE) {
      console.error(`render: ${targetUrl} body size ${body.length} exceeds ${MAX_HTML_SIZE}`);
      return { successful: false, results: null, error: 'Rendered page exceeds 5 MB limit' };
    }

    if (maxChars > 0 && body.length > maxChars) {
      body = body.substring(0, maxChars);
    }

    await env.KV_CACHE.put(cacheKey, body, { expirationTtl: CACHE_TTL_S });

    return { successful: true, results: body, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`render: browser rendering ${targetUrl} failed:`, err);
    return { successful: false, results: null, error: `Browser rendering failed: ${message}` };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

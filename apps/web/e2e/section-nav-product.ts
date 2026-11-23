import { devices, expect, type Browser, type Page } from '@playwright/test';

import { E2E_BASE_URL } from './base-url';

/**
 * AECI-2027: the seeded product that the section-nav specs open, looked up once per worker.
 *
 * `section-nav.spec.ts` and `scroll-restoration.spec.ts` each walked `/products` and up to
 * ten product pages in every test to find this product. The walk now runs once per worker
 * process, in its own browser context, and the specs reuse the path it found.
 *
 * The rule is the stricter of the two the specs used. Take a product from the first ten
 * listing rows whose page has an Integrations link and is more than 1.6 times the viewport
 * tall. Prefer one with four or more section links, so the row can overflow on a phone.
 * Otherwise take the first tall one. The thin local seed puts short products first, so
 * the walk matters.
 *
 * "Tall" is judged at the widest and tallest viewport any caller uses. A page is shorter at
 * a wider width, and a taller window needs a taller page, so a product tall enough there is
 * tall enough at every viewport the callers set.
 */
const LOOKUP_VIEWPORT = { width: 1300, height: 900 };
const CANDIDATES = 10;

export interface SectionNavProduct {
  /** False when `/products` lists no product at all. */
  seeded: boolean;
  /** The product path, or null when no listed product meets the rule. */
  path: string | null;
}

let cached: Promise<SectionNavProduct> | null = null;

async function lookUp(browser: Browser): Promise<SectionNavProduct> {
  const context = await browser.newContext({
    ...devices['Desktop Chrome'],
    baseURL: E2E_BASE_URL,
    viewport: LOOKUP_VIEWPORT,
  });
  try {
    const page = await context.newPage();
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();
    const rows = page.locator('#main a[href^="/products/"]');
    await rows
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 })
      .catch(() => {});
    if ((await rows.count()) === 0) return { seeded: false, path: null };
    const hrefs = (
      await rows.evaluateAll((els) =>
        els
          .map((el) => el.getAttribute('href'))
          .filter((h): h is string => !!h && !h.includes('#')),
      )
    ).slice(0, CANDIDATES);
    let fallback: string | null = null;
    for (const href of [...new Set(hrefs)]) {
      await page.goto(href);
      await expect(page.locator('aec-product-detail')).toBeVisible();
      const jump = page.locator(
        'aec-section-nav a[data-section-id="integrations"][href$="#integrations"]',
      );
      if ((await jump.count()) === 0) continue;
      const tall = await page.evaluate(
        () => document.documentElement.scrollHeight > window.innerHeight * 1.6,
      );
      if (!tall) continue;
      if ((await page.locator('aec-section-nav nav a').count()) >= 4) {
        return { seeded: true, path: href };
      }
      fallback ??= href;
    }
    return { seeded: true, path: fallback };
  } finally {
    await context.close();
  }
}

/**
 * The cached product for this worker. The first caller runs the walk. A walk that throws
 * is not cached, so the next test walks again and fails with its own error.
 */
export function sectionNavProduct(page: Page): Promise<SectionNavProduct> {
  if (!cached) {
    const browser = page.context().browser();
    if (!browser) throw new Error('section-nav product lookup needs a non-persistent context');
    cached = lookUp(browser).catch((error: unknown) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

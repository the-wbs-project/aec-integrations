/**
 * AECI-1283 — `/vendor-program` end-to-end smoke (`docs/VENDOR_PROGRAM_PAGE_SPEC.md` §2).
 *
 * Pins the real HTTP 200, the /about static-page cache headers
 * (`s-maxage=86400`, `Cache-Tag: route:index`), indexable meta with the absolute
 * share card, the SSR-rendered hero, the sitemap entry, the footer link in, and
 * that `/vendors` still 301s to `/products` (§1.1 decision 6).
 *
 * AECI-1284 to 1287 add the page body: the heading order (§3), the phone bar's
 * visibility rules (§4.1, asked for by AECI-1285), Find your product leading to a
 * claim form (§6, AECI-1287, against a mocked search index), and axe on the full
 * page at desktop and phone widths.
 */
import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';

import { waitForHydrationSettle } from './console-capture';

test.describe('/vendor-program — AECI-1283 to 1287', () => {
  test('GET /vendor-program returns 200 with the static-page cache headers + route:index tag', async ({
    request,
  }) => {
    const res = await request.get('/vendor-program', { maxRedirects: 0 });
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=86400');
    expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=3600');

    expect(res.headers()['cache-tag'] ?? '').toContain('route:index');
  });

  test('SSR-renders the hero and the find-your-product anchor, indexable with the share card', async ({
    request,
  }) => {
    const html = await (await request.get('/vendor-program')).text();
    expect(html).toContain('Contractors compare your integrations here');
    expect(html).toContain('id="find-your-product"');
    expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
    expect(html).toMatch(/<link[^>]+rel="canonical"[^>]+href="https?:\/\/[^"]+\/vendor-program"/);
    expect(html).toMatch(
      /<meta[^>]+property="og:image"[^>]+content="https?:\/\/[^"]+\/branding\/vendor-program-og\.png"/,
    );
    expect(html).toMatch(/<meta[^>]+property="og:image:alt"/);

    const card = await request.get('/branding/vendor-program-og.png');
    expect(card.status()).toBe(200);
    expect(card.headers()['content-type']).toContain('image/png');
  });

  test('is listed in sitemap.xml', async ({ request }) => {
    const xml = await (await request.get('/sitemap.xml')).text();
    expect(xml).toMatch(/<loc>https?:\/\/[^<]+\/vendor-program<\/loc>/);
  });

  test('is reachable from the footer Company nav', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();

    const company = page.getByRole('navigation', { name: 'Company' });
    await company.getByRole('link', { name: 'For vendors' }).click();

    await expect(page).toHaveURL(/\/vendor-program$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Contractors compare your integrations here',
    );
  });

  for (const width of [1280, 375]) {
    test(`has zero axe violations at WCAG 2.2 AA at ${width}px, FAQ open`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 667 : 900 });
      await page.goto('/vendor-program');
      await expect(page.locator('app-root')).toBeAttached();
      await waitForHydrationSettle(page);
      // Open every answer so axe reads them too.
      await page
        .locator('#vp-faq details')
        .evaluateAll((all) => all.forEach((d) => ((d as HTMLDetailsElement).open = true)));

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();

      expect(results.violations).toEqual([]);
    });
  }

  test('/vendors still 301s to /products', async ({ request }) => {
    const res = await request.get('/vendors', { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers()['location'] ?? '').toMatch(/\/products$/);
  });

  test('one h1, then one h2 per section in the section 3 order', async ({ page }) => {
    await page.goto('/vendor-program');
    const headings = await page
      .locator('main h1, main h2')
      .evaluateAll((all) => all.map((h) => `${h.tagName}:${h.textContent?.trim()}`));
    expect(headings).toEqual([
      'H1:Contractors compare your integrations here',
      'H2:What buyers read about you',
      'H2:Find your product',
      'H2:What Free gives you',
      'H2:What Managed adds',
      'H2:Free and Managed',
      'H2:How listings are sorted',
      'H2:Coming soon',
      'H2:Questions vendors ask',
      'H2:Tell the full story of your product',
    ]);
  });

  test('the hero pair sits on the first screen at 375px and at desktop', async ({ page }) => {
    for (const size of [
      { width: 375, height: 667 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(size);
      await page.goto('/vendor-program');
      const hero = page.locator('aec-plan-cta-actions');
      await expect(hero.getByRole('link', { name: 'Talk to us about Managed' })).toBeInViewport({
        ratio: 1,
      });
      await expect(hero.getByRole('link', { name: 'Claim your listing free' })).toBeInViewport({
        ratio: 1,
      });
    }
  });

  test('the hero claim link scrolls to Find your product', async ({ page }) => {
    await page.goto('/vendor-program');
    await waitForHydrationSettle(page);
    await page
      .locator('aec-plan-cta-actions')
      .getByRole('link', { name: 'Claim your listing free' })
      .click();
    await expect(page).toHaveURL(/\/vendor-program#find-your-product$/);
    await expect(page.getByLabel('Your product or company')).toBeInViewport();
  });

  // AECI-1285's e2e: the phone bar hides while a full call to action is on screen
  // and never covers the closing panel.
  test('phone bar: hidden by the hero and the panel, shown between them', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/vendor-program');
    await waitForHydrationSettle(page);
    const bar = page.getByRole('region', { name: 'Managed plan' });
    const scrollTo = (selector: string) =>
      page.locator(selector).evaluate((el) => el.scrollIntoView({ block: 'start' }));

    // The hero pair is on screen.
    await expect(bar).toBeHidden();

    // Past the hero, no full call to action on screen.
    await scrollTo('#vp-managed');
    await expect(bar).toBeVisible();

    // The plan cards are a full call to action.
    await scrollTo('#vp-plans');
    await expect(bar).toBeHidden();

    await scrollTo('#vp-faq');
    await expect(bar).toBeVisible();

    // The closing panel, and the very end of the page.
    await scrollTo('aec-plan-cta-panel');
    await expect(bar).toBeHidden();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(bar).toBeHidden();
    await expect(page.locator('aec-plan-cta-panel')).toBeInViewport();
  });

  test('the rail shows on desktop once the hero has scrolled away', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/vendor-program');
    await waitForHydrationSettle(page);
    const rail = page.locator('[data-testid="vp-rail"]');
    await expect(rail).toBeHidden();
    await page.locator('#vp-managed').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await expect(rail).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Talk to us' })).toBeVisible();
  });

  test('Find your product: the no-JS form goes to /search', async ({ request }) => {
    const html = await (await request.get('/vendor-program')).text();
    expect(html).toMatch(/<form[^>]+action="\/search"[^>]*method="get"/);
    expect(html).toContain('id="vendor-program-search"');
  });
});

/**
 * Find your product against a mocked search index. No environment ships Algolia
 * to local or CI runs, so the page gets a stand-in public config and the search
 * request is answered here. Nothing leaves the machine.
 */
async function mockSearch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __AECI_ALGOLIA__: unknown }).__AECI_ALGOLIA__ = {
      appId: 'E2ETEST',
      searchKey: 'e2e',
      indexes: { products: 'products', vendors: 'vendors', integrations: 'integrations' },
    };
  });
  await page.route('**/1/indexes/*/queries**', async (route) => {
    const body = route.request().postDataJSON() as { requests: { query?: string }[] };
    const query = body.requests[0]?.query ?? '';
    const product = {
      objectID: 'p1',
      name: 'Procore',
      slug: 'fixture-procore',
      vendor_name: 'Procore Technologies',
    };
    const hit = query.toLowerCase().startsWith('proc');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          { hits: hit ? [product] : [], nbHits: hit ? 1 : 0, query, params: '', index: 'products' },
          { hits: [], nbHits: 0, query, params: '', index: 'vendors' },
        ],
      }),
    });
  });
}

test.describe('/vendor-program Find your product (AECI-1287)', () => {
  test('pick a hit and land on its claim form', async ({ page }) => {
    await mockSearch(page);
    await page.goto('/vendor-program');
    await waitForHydrationSettle(page);

    const box = page.getByLabel('Your product or company');
    await box.fill('Proc');
    await page.getByRole('option', { name: /Procore/ }).click();

    const card = page.locator('[data-testid="vp-find-result"]');
    await expect(card).toContainText('Procore');
    await expect(card.getByRole('link', { name: 'View the listing' })).toHaveAttribute(
      'href',
      '/products/fixture-procore',
    );
    await card.getByRole('link', { name: 'Claim this listing' }).click();

    await expect(page).toHaveURL(/\/products\/fixture-procore\/claim$/);
    await expect(page.getByRole('heading', { name: 'Claim this listing' })).toBeVisible();
  });

  test('a miss says the products may already be listed, and links to contact', async ({ page }) => {
    await mockSearch(page);
    await page.goto('/vendor-program');
    await waitForHydrationSettle(page);

    await page.getByLabel('Your product or company').fill('zzz nothing');
    const miss = page.locator('[data-testid="vp-find-miss"]');
    await expect(miss).toContainText('Your products may already be listed');
    await expect(miss.getByRole('link', { name: 'tell us' })).toHaveAttribute('href', '/contact');
  });
});

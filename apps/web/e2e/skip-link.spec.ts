import { expect, test, type APIRequestContext } from '@playwright/test';
import { untilHydrated } from './hydration';

// AECI-1839: with `<base href="/">` a bare `href="#main"` resolved to `/#main`, so the skip
// link loaded the home page on every route except `/`. These specs pin the path-preserving
// href in the server HTML (pre-hydration) and the hydrated Tab + Enter behaviour.

const PAGES = ['/docs', '/legal/terms'];

async function firstProductPath(request: APIRequestContext): Promise<string | null> {
  const html = await (await request.get('/products')).text();
  return html.match(/href="(\/products\/[a-z0-9-]+)"/)?.[1] ?? null;
}

test.describe('skip link (AECI-1839)', () => {
  test('server HTML carries a path-preserving href, never a bare fragment', async ({ request }) => {
    const product = await firstProductPath(request);
    test.skip(product === null, 'no products seeded in this environment');
    for (const path of [product as string, ...PAGES]) {
      const html = await (await request.get(`${path}?utm_source=x`)).text();
      const href = html.match(/<a[^>]*href="([^"]*)"[^>]*>\s*Skip to main content/)?.[1];
      expect(href, `skip link href on ${path}`).toBe(`${path}#main`);
    }
  });

  for (const target of ['product', ...PAGES]) {
    test(`Tab then Enter on ${target} stays on the page and focuses main`, async ({
      page,
      request,
    }) => {
      const path = target === 'product' ? await firstProductPath(request) : target;
      test.skip(path === null, 'no products seeded in this environment');
      await page.goto(`${path}?probe=1`);
      const link = page.getByRole('link', { name: 'Skip to main content' });
      await untilHydrated(link);

      let documentLoads = 0;
      page.on('request', (r) => {
        if (r.resourceType() === 'document') documentLoads++;
      });
      const pathname = new URL(page.url()).pathname;

      await page.keyboard.press('Tab');
      await expect(link).toBeFocused();
      await page.keyboard.press('Enter');

      await expect(page.locator('main#main')).toBeFocused();
      const after = new URL(page.url());
      expect(after.pathname).toBe(pathname);
      expect(after.search).toBe('?probe=1');
      expect(after.hash).toBe('#main');
      expect(documentLoads).toBe(0);
    });
  }

  test('still correct after a client-side navigation', async ({ page, request }) => {
    const product = await firstProductPath(request);
    test.skip(product === null, 'no products seeded in this environment');
    await page.goto('/products');
    const row = page.locator(`#main a[href="${product}"]`).first();
    await untilHydrated(row);
    await row.click();
    await expect(page).toHaveURL(new RegExp(`${product}$`));
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      `${product}#main`,
    );
  });
});

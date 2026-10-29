/**
 * AECI-1474: `/vendor-program/list-your-product` end to end
 * (`docs/VENDOR_PROGRAM_PAGE_SPEC.md` §2.5).
 *
 * The page shows the listing request form inline, opened on the typed-in step. The
 * submit endpoints are mocked, so nothing leaves the machine and no row is written.
 * Pins the static-page cache headers and `route:index`, the SSR canonical and
 * indexable meta, the sitemap entry, focus in the first field after hydration, a
 * submit that reaches the receipt with no "Done", Back to the Find step, the two
 * inbound links, and axe on the whole page at 375 and 1280.
 */
import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';

import { waitForHydrationSettle } from './console-capture';

const PATH = '/vendor-program/list-your-product';

/** Answers both submit endpoints with a 201 and records what was sent (the
 *  `vendor-program-claim-dialog.spec.ts` pattern). */
async function mockSubmits(page: Page): Promise<{ claim: unknown[]; listing: unknown[] }> {
  const sent = { claim: [] as unknown[], listing: [] as unknown[] };
  for (const kind of ['claim', 'listing'] as const) {
    await page.route(`**/api/requests/${kind}`, async (route) => {
      sent[kind].push(route.request().postDataJSON());
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          request_id: '11111111-2222-4333-8444-555555555555',
          message: 'ok',
          confirmation_required: false,
        }),
      });
    });
  }
  return sent;
}

/** The form panel, named by its h2. */
const panel = (page: Page) => page.getByRole('region', { name: 'Request a listing' });

test.describe('/vendor-program/list-your-product (AECI-1474)', () => {
  test('returns 200 with the static-page cache headers and route:index', async ({ request }) => {
    const res = await request.get(PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=86400');
    expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=3600');
    expect(res.headers()['cache-tag'] ?? '').toContain('route:index');
  });

  test('SSR-renders the explainer and the empty form, indexable with a canonical', async ({
    request,
  }) => {
    const html = await (await request.get(PATH)).text();
    expect(html).toContain('Ask us to list your product');
    expect(html).toContain('Request a listing');
    expect(html).toContain('id="claim-dialog-listing-name"');
    expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
    expect(html).toMatch(
      /<link[^>]+rel="canonical"[^>]+href="https?:\/\/[^"]+\/vendor-program\/list-your-product"/,
    );
    expect(html).toMatch(
      /<meta[^>]+property="og:image"[^>]+content="https?:\/\/[^"]+\/branding\/vendor-program-og\.png"/,
    );
  });

  test('is listed in sitemap.xml', async ({ request }) => {
    const xml = await (await request.get('/sitemap.xml')).text();
    expect(xml).toMatch(/<loc>https?:\/\/[^<]+\/vendor-program\/list-your-product<\/loc>/);
  });

  test('focuses the first field, then sends a listing request to the receipt', async ({ page }) => {
    const sent = await mockSubmits(page);
    await page.goto(PATH);
    await waitForHydrationSettle(page);

    const form = panel(page);
    const name = form.getByLabel('Product or company name');
    await expect(name).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Opened on the typed-in step, Find is a detour: two counted steps.
    const progress = form.getByTestId('claim-dialog-progress');
    await expect(progress).toContainText('Step 1 of 2');

    await name.fill('Site Diary Pro');
    await form.getByLabel('Website').fill('https://sitediary.example.com');
    await form.getByLabel('Your name').fill('Dana Reyes');
    await form.getByLabel('Your role at the company').fill('Head of Partnerships');
    await form.getByLabel('Your work email').fill('dana@sitediary.example');
    await form.getByRole('checkbox', { name: /I represent this company/ }).check();
    await form.getByRole('button', { name: 'Continue' }).click();
    await expect(progress).toContainText('Step 2 of 2');
    await form.getByRole('button', { name: 'Send request' }).click();

    await expect(form.getByRole('heading', { name: 'Request sent' })).toBeVisible();
    await expect(form.getByRole('button', { name: 'Done' })).toHaveCount(0);
    expect(sent.claim).toEqual([]);
    expect(sent.listing).toEqual([
      {
        submitter_name: 'Dana Reyes',
        submitter_email: 'dana@sitediary.example',
        submitter_role: 'Head of Partnerships',
        submitter_linkedin_url: '',
        body: '',
        accepted_terms: true,
        found_via: '',
        found_via_detail: '',
        listing_name: 'Site Diary Pro',
        website: 'https://sitediary.example.com',
      },
    ]);
    await expect(page).toHaveURL(new RegExp(`${PATH}$`));
  });

  test('Back goes to the Find step, inline', async ({ page }) => {
    await page.goto(PATH);
    await waitForHydrationSettle(page);
    const form = panel(page);
    await expect(form.getByLabel('Product or company name')).toBeFocused();
    await form.getByRole('button', { name: 'Back' }).click();
    await expect(form.getByRole('heading', { name: 'Find your listing' })).toBeVisible();
    await expect(form.getByLabel('Your product or company')).toBeVisible();
    await expect(form.getByTestId('claim-dialog-progress')).toHaveCount(0);
  });

  test('is linked from the vendor program FAQ and the add-product contact panel', async ({
    page,
  }) => {
    await page.goto('/vendor-program');
    await expect(
      page.locator('#vp-faq').getByRole('link', { name: 'Ask us to list your product' }),
    ).toHaveAttribute('href', PATH);

    await page.goto('/contact?topic=add-product');
    await expect(
      page.getByTestId('contact-add-product').getByRole('link', { name: 'Request a listing' }),
    ).toHaveAttribute('href', PATH);
  });

  for (const width of [1280, 375]) {
    test(`has zero axe violations at WCAG 2.2 AA at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 667 : 900 });
      await page.goto(PATH);
      await waitForHydrationSettle(page);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();

      expect(results.violations).toEqual([]);
    });
  }
});

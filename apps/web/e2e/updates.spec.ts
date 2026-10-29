/**
 * AECI-536 — `/updates` end-to-end coverage.
 *
 * The mailing-list signup page is a static, indexable, CACHEABLE content page
 * (24h edge / 1h browser, `Cache-Tag: route:index`), SSR-rendered as a static
 * form island whose POST only fires from a user action against the non-cached
 * `/api/subscribe`. This pins the real HTTP 200, the static-page cache headers,
 * that the form body actually SSR-renders (heading + visible email label + submit
 * button), the self-referential canonical with no noindex, reachability from the
 * header nav, a clean axe pass, and clean hydration. The subscription flow's UI
 * states are covered hermetically in `updates.component.spec.ts`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';

const PATH = '/updates';
const TITLE = 'Get updates · AEC Integrations';
const HEADING = 'Get AEC Integrations updates';

test.describe(`${PATH} — AECI-536`, () => {
  test('returns 200 with the 24h-edge static-page cache headers + route:index tag', async ({
    request,
  }) => {
    const res = await request.get(PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=86400');
    expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=3600');

    expect(res.headers()['cache-tag'] ?? '').toContain('route:index');
  });

  test('SSR-renders the signup form (no empty hydration shell)', async ({ request }) => {
    const html = await (await request.get(PATH)).text();
    expect(html).toContain(HEADING);
    // The visible email label and the submit button ship in the SSR HTML.
    expect(html).toContain('Email address');
    expect(html).toContain('Join the mailing list');
    // A real, associated email input (visible label + describedby wiring).
    expect(html).toContain('id="updates-email"');
  });

  test('is indexable — self-referential canonical, no noindex robots meta', async ({
    page,
    request,
  }) => {
    const html = await (await request.get(PATH)).text();
    expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);

    await page.goto(PATH);
    await expect(page).toHaveTitle(TITLE);
    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveCount(1);
    await expect(canonical).toHaveAttribute('href', new RegExp(`${PATH}$`));
    await expect(page.locator('head meta[property="og:type"]')).toHaveAttribute(
      'content',
      'website',
    );
  });

  test('is reachable from the footer Company column', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();

    // Updates left the primary row for the "More" overflow menu, and left that
    // for the footer when the menu was retired. The footer is now its only
    // site-wide entry point, so this is the link that has to keep working.
    const company = page.getByRole('navigation', { name: 'Company' });
    await company.getByRole('link', { name: 'Updates', exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`${PATH}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(HEADING);
  });

  // AECI-1063: one answered signup. The POST is mocked, so no row is written.
  test('sends the "How did you find us?" answer and follow-up with the signup', async ({
    page,
  }) => {
    const sent: unknown[] = [];
    await page.route('**/api/subscribe', async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ created: true }),
      });
    });
    await page.goto(PATH);
    await waitForHydrationSettle(page);

    await page.getByLabel('Email address').fill('pm@example.com');
    const question = page.getByRole('combobox', { name: /How did you find AEC Integrations/ });
    // The first click can land before hydration finishes; retry until the list opens.
    const option = page.getByRole('option', { name: 'Google or another search engine' });
    await expect(async () => {
      await question.click();
      await expect(option).toBeVisible({ timeout: 2000 });
    }).toPass();
    await option.click();
    await page.getByLabel('What did you search for?').fill('aec integrations directory');
    await expect(page.getByRole('status').filter({ hasText: 'follow-up' })).toHaveText(
      'A follow-up question appeared: What did you search for?',
    );
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    await page.getByRole('button', { name: 'Join the mailing list' }).click();
    await expect(page.getByRole('heading', { name: "You're on the list." })).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      email: 'pm@example.com',
      found_via: 'search',
      found_via_detail: 'aec integrations directory',
    });
  });

  test('has zero axe violations at WCAG AA', async ({ page }) => {
    await page.goto(PATH);
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('renders with no console errors or page errors', async ({ page }) => {
    const capture = attachConsoleCapture(page);
    const res = await page.goto(PATH);
    expect(res?.status()).toBe(200);
    await expect(page.locator('app-root')).toBeAttached();
    await waitForHydrationSettle(page);
    expectConsoleClean(capture, `GET ${PATH}`);
  });
});

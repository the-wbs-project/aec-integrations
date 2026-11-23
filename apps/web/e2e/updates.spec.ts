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
import { untilHydrated } from './hydration';
import { expectNoSidewaysScroll } from './no-sideways-scroll';

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

  // One page load for both checks (AECI-2027). Console capture is attached before
  // the load, and the console check runs last, after hydration.
  test('is indexable and renders console-clean', async ({ page, request }) => {
    const capture = attachConsoleCapture(page);

    await test.step('is indexable — self-referential canonical, no noindex robots meta', async () => {
      const html = await (await request.get(PATH)).text();
      expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);

      const res = await page.goto(PATH);
      expect(res?.status()).toBe(200);
      await expect(page).toHaveTitle(TITLE);
      const canonical = page.locator('head link[rel="canonical"]');
      await expect(canonical).toHaveCount(1);
      await expect(canonical).toHaveAttribute('href', new RegExp(`${PATH}$`));
      await expect(page.locator('head meta[property="og:type"]')).toHaveAttribute(
        'content',
        'website',
      );
    });

    await test.step('renders with no console errors or page errors', async () => {
      await expect(page.locator('app-root')).toBeAttached();
      await waitForHydrationSettle(page);
      expectConsoleClean(capture, `GET ${PATH}`);
    });
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
    // One click, after hydration. An earlier click is queued and replayed, not
    // dropped (AECI-1655), so a retry would toggle the list shut again.
    const option = page.getByRole('option', { name: 'Google or another search engine' });
    await untilHydrated(question);
    await question.click();
    await expect(option).toBeVisible();
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

  // AECI-1801: one Bone band, a 44px field with its 3:1 edge, and at 390px a field wide
  // enough to read (it was squeezed to about 70px beside the button before).
  for (const width of [1440, 390]) {
    test(`the field is 44px tall and usable, on the one Bone band, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PATH);
      await expect(page.locator('.aec-bone-band')).toHaveCount(1);
      const input = page.locator('#updates-email');
      const box = (await input.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(240);
      const edge = await input.evaluate((el) => getComputedStyle(el).borderTopColor);
      const fieldEdge = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.color = 'var(--border-field)';
        document.body.appendChild(probe);
        const colour = getComputedStyle(probe).color;
        probe.remove();
        return colour;
      });
      expect(edge).toBe(fieldEdge);
      await expectNoSidewaysScroll(page);
    });
  }

  test('has zero axe violations at WCAG AA', async ({ page }) => {
    await page.goto(PATH);
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});

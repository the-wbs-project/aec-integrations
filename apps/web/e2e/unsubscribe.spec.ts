/**
 * AECI-537 — `/unsubscribe` end-to-end coverage.
 *
 * The mailing-list opt-out page is a tokenized, NON-cacheable, noindex content
 * page: absent from `ROUTE_CACHE_PATTERNS`, so the SSR Worker emits the
 * fail-closed `private, no-store` default and no `Cache-Tag`, and the component
 * sets `robots: noindex`. It never mutates on load — it renders a confirm button
 * and only POSTs to the non-cached `/api/unsubscribe` from the click. This pins the
 * 200 + non-cacheable headers, the noindex + self-referential canonical, the
 * SSR-rendered confirm prompt, the confirm → success state (with `/api/unsubscribe`
 * mocked) on a clean console, and a clean axe pass. The invalid-link and token-less
 * states are pinned in `unsubscribe.component.spec.ts`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';

const TOKEN_PATH = '/unsubscribe?token=e2e-token';

/** Mock the same-origin opt-out endpoint so the flow is hermetic. */
async function mockUnsubscribe(page: Page, ok: boolean) {
  await page.route('**/api/unsubscribe', (route) => route.fulfill({ status: 200, json: { ok } }));
}

test.describe('/unsubscribe — AECI-537', () => {
  test('GET /unsubscribe returns 200 and is non-cacheable (private, no-store, no Cache-Tag)', async ({
    request,
  }) => {
    const res = await request.get(TOKEN_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('private, no-store');
    expect(res.headers()['cache-tag']).toBeUndefined();
  });

  test('SSR-renders the confirm prompt (no auto-unsubscribe) when a token is present', async ({
    request,
  }) => {
    const html = await (await request.get(TOKEN_PATH)).text();
    expect(html).toContain('Unsubscribe from updates?');
    expect(html).toContain('Unsubscribe');
  });

  test('noindex, a clean console, then confirming shows the success state', async ({
    page,
    request,
  }) => {
    const capture = attachConsoleCapture(page);
    await mockUnsubscribe(page, true);
    const res = await page.goto(TOKEN_PATH);

    await test.step('is noindex with a self-referential (token-stripped) canonical', async () => {
      const html = await (await request.get(TOKEN_PATH)).text();
      expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);

      await expect(page).toHaveTitle('Unsubscribe · AEC Integrations');
      const canonical = page.locator('head link[rel="canonical"]');
      await expect(canonical).toHaveCount(1);
      // Canonical drops the per-subscriber token (stripQueryParams).
      await expect(canonical).toHaveAttribute('href', /\/unsubscribe$/);
    });

    await test.step('renders with no console errors or page errors', async () => {
      expect(res?.status()).toBe(200);
      await expect(page.locator('app-root')).toBeAttached();
      await waitForHydrationSettle(page);
      expectConsoleClean(capture, `GET ${TOKEN_PATH}`);
    });

    await test.step('confirming shows the success state on { ok: true }', async () => {
      await page.getByRole('button', { name: 'Unsubscribe' }).click();

      await expect(page.getByRole('heading', { level: 1 })).toHaveText(/You've been unsubscribed/);
      await expect(page.getByRole('button', { name: 'Unsubscribe' })).toHaveCount(0);
    });
  });

  test('has zero axe violations at WCAG AA', async ({ page }) => {
    await page.goto(TOKEN_PATH);
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});

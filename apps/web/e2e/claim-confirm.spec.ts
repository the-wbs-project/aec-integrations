/**
 * AECI-1435 — `/claims/confirm`, the page behind the claim-confirm email. Same contract
 * as `/unsubscribe` and `/notifications/mute`: 200, non-cacheable, noindex, a confirm
 * prompt in the SSR HTML (never an auto-confirm), and the click POSTs to the mocked
 * `/api/requests/confirm`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const TOKEN_PATH = '/claims/confirm?token=e2e-token';

const axe = (page: import('@playwright/test').Page) =>
  new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();

test.describe('/claims/confirm — AECI-1435', () => {
  test('is non-cacheable and noindex, and SSR-renders the confirm prompt', async ({ request }) => {
    const res = await request.get(TOKEN_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('private, no-store');
    expect(res.headers()['cache-tag']).toBeUndefined();
    const html = await res.text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
    expect(html).toContain('Confirm your claim');
  });

  test('confirms on the click only, posts the token, and passes axe', async ({ page }) => {
    const bodies: unknown[] = [];
    await page.route('**/api/requests/confirm', async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        json: {
          status: 'confirmed',
          kind: 'claim',
          request_id: '11111111-2222-4333-8444-555555555555',
          routed: false,
          company_name: 'Procore Technologies',
        },
      });
    });
    await page.goto(TOKEN_PATH);
    expect(
      (await axe(page)).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([]);
    // Rendering never confirms: a mail scanner's prefetch changes nothing.
    expect(bodies).toEqual([]);

    const button = page.getByRole('button', { name: 'Confirm and send' });
    await expect(async () => {
      await button.click();
      await expect(page.getByRole('heading', { name: 'Claim sent' })).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 15_000 });
    expect(bodies).toEqual([{ token: 'e2e-token' }]);
    // The token left the address bar.
    expect(page.url()).not.toContain('token=');

    const result = await axe(page);
    expect(
      result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious'),
    ).toEqual([]);
  });

  test('an expired link says so and offers to start again', async ({ page }) => {
    await page.route('**/api/requests/confirm', async (route) => {
      await route.fulfill({
        status: 422,
        json: {
          error: {
            code: 'INVALID_STATE_TRANSITION',
            message: 'This link has expired',
            details: { reason: 'expired' },
          },
        },
      });
    });
    await page.goto(TOKEN_PATH);
    const button = page.getByRole('button', { name: 'Confirm and send' });
    await expect(async () => {
      await button.click();
      await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'Start again' })).toHaveAttribute(
      'href',
      '/vendor-program',
    );
  });
});

/**
 * AECI-1204 — `/notifications/mute`, the confirm page behind the digest footer's
 * mute link. Same contract as `/unsubscribe`: 200, non-cacheable, noindex, a
 * confirm prompt in the SSR HTML (never an auto-mute), and the click POSTs to the
 * mocked `/api/notifications/nudges/mute`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const TOKEN_PATH = '/notifications/mute?token=e2e-token';

test.describe('/notifications/mute — AECI-1204', () => {
  test('is non-cacheable and noindex, and SSR-renders the confirm prompt', async ({ request }) => {
    const res = await request.get(TOKEN_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('private, no-store');
    expect(res.headers()['cache-tag']).toBeUndefined();
    const html = await res.text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
    expect(html).toContain('Mute the daily reminder email?');
  });

  test('confirms, posts the token, and passes axe', async ({ page }) => {
    let body: unknown = null;
    await page.route('**/api/notifications/nudges/mute', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, json: { ok: true } });
    });
    await page.goto(TOKEN_PATH);

    const button = page.getByRole('button', { name: 'Mute daily reminder email' });
    await expect(async () => {
      await button.click();
      await expect(page.getByRole('heading', { name: 'Daily reminder email muted' })).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 15_000 });
    expect(body).toEqual({ token: 'e2e-token' });

    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious'),
    ).toEqual([]);
  });
});

/**
 * AECI-200 / Phase 5.9 — the authenticated review-submission form at
 * `/products/:slug/review` (Signal Forms + Angular Aria). Runs against the
 * bound dev stack (`pnpm dev:agent` / CI preview).
 *
 * Coverage:
 *   - SSR auth gate: a logged-out visitor (no `sb-…-auth-token` cookie) is
 *     303-redirected to `/auth/login?return=<path>` (`private, no-store`). This
 *     case needs NO fixture — the gate fires before the SSR resolver.
 *   - Authenticated render + a11y: with a session cookie present the form
 *     renders; axe (WCAG-AA) is clean.
 *   - Keyboard-only: the star-rating Aria listbox is roving-focus + arrow-key
 *     navigable and selects on Space (`aria-selected`).
 *   - Happy path: keyboard/pointer fill + a stubbed `POST /api/reviews` (201)
 *     flips to the moderation confirmation.
 *
 * Auth model: the gate is a cheap session-cookie *presence* check, so a dummy
 * `sb-…-auth-token` cookie satisfies it. The product detail the resolver fetches
 * is a public GET, so it renders without a real session. The actual
 * `POST /api/reviews` is auth-enforced on the API Worker, so the happy-path
 * submit is stubbed via `page.route` rather than hitting the real endpoint.
 *
 * Fixture gating: the form needs `product.id`, so the render/a11y/submit cases
 * 404 without the seed product. A `beforeAll` probe gates them (mirrors
 * `phase2-a11y.spec.ts`); the redirect case always runs.
 */
import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  request as playwrightRequest,
  test,
  type BrowserContext,
  type Page,
} from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';
const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// Shared seed product (`supabase/fixtures/phase2-fixtures.sql`).
const PRODUCT_SLUG = 'fixture-procore';
const REVIEW_PATH = `/products/${PRODUCT_SLUG}/review`;

let fixturesPresent = false;

test.beforeAll(async () => {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    const res = await ctx.get(`/products/${PRODUCT_SLUG}`, { maxRedirects: 0 });
    fixturesPresent = res.status() === 200;
    if (!fixturesPresent) {
      console.warn(
        `[reviews-submission] Fixtures absent: GET /products/${PRODUCT_SLUG} -> ${res.status()}. ` +
          'Render / a11y / submit cases will be SKIPPED (the redirect case still runs). ' +
          'Seed supabase/fixtures/phase2-fixtures.sql into the dev DB to enable them.',
      );
    }
  } finally {
    await ctx.dispose();
  }
});

/** Add a dummy Supabase session cookie so the SSR presence-gate passes. */
async function addAuthCookie(context: BrowserContext): Promise<void> {
  const url = new URL(BASE_URL);
  await context.addCookies([
    {
      name: 'sb-localdev-auth-token',
      value: 'base64-e2e-review-fixture',
      domain: url.hostname,
      path: '/',
      secure: url.protocol === 'https:',
      sameSite: 'Lax',
    },
  ]);
}

async function aaViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
  return results.violations;
}

test.describe('/products/:slug/review — SSR auth gate (AECI-200)', () => {
  test('redirects a logged-out visitor to /auth/login with the return path', async ({
    request,
  }) => {
    const res = await request.get(REVIEW_PATH, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe(`/auth/login?return=${encodeURIComponent(REVIEW_PATH)}`);
    expect(res.headers()['cache-control']).toBe('private, no-store');
  });

  test('does not gate the public product detail page', async ({ request }) => {
    const res = await request.get(`/products/${PRODUCT_SLUG}`, { maxRedirects: 0 });
    // 200 (fixture present) or 404 (absent) — never a 303 to the login page.
    expect([200, 404]).toContain(res.status());
  });
});

test.describe('/products/:slug/review — authenticated form (AECI-200)', () => {
  test.beforeEach(() => {
    test.skip(!fixturesPresent, 'fixtures not seeded — see beforeAll warning');
  });

  test('renders the dual-rating form with two star listboxes', async ({ page, context }) => {
    await addAuthCookie(context);
    await page.goto(REVIEW_PATH);
    await expect(page.locator('app-root')).toBeAttached();

    await expect(page.locator('ul[aria-labelledby="overall-label"]')).toBeVisible();
    await expect(page.locator('ul[aria-labelledby="onboarding-label"]')).toBeVisible();
    await expect(page.locator('ul[aria-labelledby="overall-label"] [role="option"]')).toHaveCount(
      5,
    );
    await expect(page.locator('#review-title-input')).toBeVisible();
    await expect(page.locator('#review-body')).toBeVisible();
  });

  test('has zero axe (WCAG-AA) violations', async ({ page, context }) => {
    await addAuthCookie(context);
    await page.goto(REVIEW_PATH);
    await expect(page.locator('form[novalidate]')).toBeVisible();
    const violations = await aaViolations(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  test('star rating is keyboard-navigable and selects on Space', async ({ page, context }) => {
    await addAuthCookie(context);
    await page.goto(REVIEW_PATH);
    const overall = page.locator('ul[aria-labelledby="overall-label"]');
    const options = overall.locator('[role="option"]');

    // Roving focus: focus the first option, arrow to the 4th, select with Space.
    await options.first().focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');

    await expect(options.nth(3)).toHaveAttribute('aria-selected', 'true');
  });

  test('a filled form submits and shows the moderation confirmation', async ({ page, context }) => {
    await addAuthCookie(context);
    // Stub the auth-enforced write so the happy path is exercised end-to-end.
    await page.route('**/api/reviews', async (route) => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'rev-e2e', status: 'pending', message: 'ok' }),
      });
    });

    await page.goto(REVIEW_PATH);

    // Ratings via pointer (reliable); text via fill.
    await page.locator('ul[aria-labelledby="overall-label"] [role="option"]').nth(3).click();
    await page.locator('ul[aria-labelledby="onboarding-label"] [role="option"]').nth(4).click();
    await page.locator('#review-title-input').fill('Reliable Revit connector');
    await page
      .locator('#review-body')
      .fill(
        'We rolled this out across three offices and the model sync held up under heavy load. ' +
          'Onboarding took a couple of calls but support was responsive.',
      );

    await page.locator('button[type="submit"]').click();

    await expect(page.getByText(/once moderated/i)).toBeVisible();
  });
});

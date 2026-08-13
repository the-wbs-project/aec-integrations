/**
 * AECI-235 — console-health coverage for the auth-gated Phase 5 pages: the
 * analogue of the AECI-162 crawler's per-page console gate (Spec §15.15 /
 * STAGE_1_PHASE_5_SPEC.md: "No console errors (AECI-162 crawler extends to the
 * new pages)").
 *
 * The crawler (`internal-link-graph.spec.ts`) can't BFS-reach these, and a
 * *hydrated* render of their real content needs a valid Supabase session: the
 * /admin* pages authorize server-side inside the SSR Worker
 * (`adminSummaryResolver` -> `GET /api/admin/summary`, `requireAdmin()`), which
 * `page.route()` can't stub. So this spec mints ONE real admin session
 * (`auth-session.ts`) and visits every gated page with it, asserting zero console
 * `error` / `pageerror` via the shared, single-sourced `console-capture.ts`
 * helpers (warnings stay reported-not-gated — AC #2).
 *
 * Skips when the session can't be minted (no anon key / no `SUPABASE_TEST_USER_*`
 * creds / sign-in fails) — same posture as `auth-whoami.spec.ts`. The pages
 * authorize only when `test@thewbsproject.com` exists in the shared Supabase project
 * AND its D1 profile (`apps/api/seed/auth-fixtures.sql`, `role='admin'`) is
 * present (seeded automatically by `dev:bound` -> `db:seed:local`).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, request as playwrightRequest, test } from '@playwright/test';
import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';
import { mintSessionCookies } from './auth-session';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';
// Shared seed product (`apps/api/seed/phase2-fixtures.sql`), same as `reviews-submission.spec.ts`.
const PRODUCT_SLUG = 'fixture-procore';

let sessionCookies: Awaited<ReturnType<typeof mintSessionCookies>> = null;
let reviewFixturePresent = false;

test.beforeAll(async () => {
  sessionCookies = await mintSessionCookies(BASE_URL);
  // Probe for the seed product so the review-page case skips (rather than fails)
  // when the catalog fixtures are absent — mirrors `reviews-submission.spec.ts`.
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    const res = await ctx.get(`/products/${PRODUCT_SLUG}`, { maxRedirects: 0 });
    reviewFixturePresent = res.status() === 200;
  } finally {
    await ctx.dispose();
  }
});

test.describe('authed console health — Phase 5 gated pages (AECI-235)', () => {
  test.beforeEach(async ({ context }) => {
    test.skip(
      !sessionCookies,
      'No minted Supabase session (SUPABASE_TEST_USER_* / anon key unset, or sign-in failed) — see docs/environments.md.',
    );
    await context.addCookies(sessionCookies!);
  });

  test('/account hydrates with no console errors', async ({ page }) => {
    const capture = attachConsoleCapture(page);
    const res = await page.goto('/account');
    expect(res?.status()).toBe(200);
    // Real authed content — not the /auth/login redirect or the not-found shell.
    await expect(page.locator('aec-account-page')).toBeAttached();
    await expect(page.locator('#account-display-name')).toBeVisible();
    await waitForHydrationSettle(page);
    expectConsoleClean(capture, 'GET /account');
  });

  test('/admin redirects to the Overview and hydrates with no console errors', async ({ page }) => {
    const capture = attachConsoleCapture(page);
    const res = await page.goto('/admin');
    expect(res?.status()).toBe(200);
    // `aec-admin-shell` renders only for an authorized admin; a non-admin (401/403)
    // 404s to the not-found shell, failing loudly if the D1 admin profile is missing.
    await expect(page.locator('aec-admin-shell')).toBeAttached();
    // AECI-576: `/admin` now lands on the console Overview, not the review queue.
    await expect(page).toHaveURL(/\/admin\/overview$/);
    await waitForHydrationSettle(page);
    expectConsoleClean(capture, 'GET /admin');
  });

  test('/admin/overview hydrates with no console errors', async ({ page }) => {
    const capture = attachConsoleCapture(page);
    const res = await page.goto('/admin/overview');
    expect(res?.status()).toBe(200);
    await expect(page.locator('aec-admin-shell')).toBeAttached();
    await expect(page.locator('aec-admin-overview')).toBeAttached();
    // The bundle resolved client-side: the status strip only renders once
    // `GET /api/admin/overview` came back, so this asserts the authed read too.
    await expect(page.locator('aec-status-strip')).toBeAttached();
    await waitForHydrationSettle(page);
    expectConsoleClean(capture, 'GET /admin/overview');
  });

  test('/admin/reviews hydrates with no console errors', async ({ page }) => {
    const capture = attachConsoleCapture(page);
    const res = await page.goto('/admin/reviews');
    expect(res?.status()).toBe(200);
    await expect(page.locator('aec-admin-shell')).toBeAttached();
    await expect(page.locator('aec-review-queue')).toBeAttached();
    await waitForHydrationSettle(page);
    expectConsoleClean(capture, 'GET /admin/reviews');
  });

  // AECI-578 / Phase 8.3 P1.4. This is where the Traffic section's LIVE axe pass
  // runs: it is the only place with a real admin session, and the charts render
  // nothing until the authorized `afterNextRender` reads resolve — so an axe run
  // on the unauthenticated route would only ever audit the loading state.
  test('/admin/traffic hydrates with no console errors and zero axe violations', async ({
    page,
  }) => {
    const capture = attachConsoleCapture(page);
    const res = await page.goto('/admin/traffic');
    expect(res?.status()).toBe(200);
    await expect(page.locator('aec-admin-shell')).toBeAttached();
    await expect(page.locator('aec-admin-traffic')).toBeAttached();
    // Wait for the charts themselves, not just the shell: the a11y contract
    // under test (role="img" + the sibling data table) does not exist until the
    // eight reads land and the loading state is replaced.
    await expect(page.locator('aec-stat-tile').first()).toBeVisible();
    await waitForHydrationSettle(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .exclude('aec-site-header')
      .analyze();
    expect(
      results.violations,
      results.violations
        .map((v) => `[${v.impact ?? '?'}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`)
        .join('\n'),
    ).toEqual([]);

    expectConsoleClean(capture, 'GET /admin/traffic');
  });

  test('/products/:slug/review hydrates with no console errors', async ({ page }) => {
    test.skip(
      !reviewFixturePresent,
      `seed product ${PRODUCT_SLUG} absent — run \`pnpm --filter @aeci/api db:seed:fixtures:local\``,
    );
    const capture = attachConsoleCapture(page);
    const res = await page.goto(`/products/${PRODUCT_SLUG}/review`);
    expect(res?.status()).toBe(200);
    // The real review form (signed-in) — both rating listboxes present.
    await expect(page.locator('form[novalidate]')).toBeVisible();
    await expect(page.locator('ul[aria-labelledby="overall-label"]')).toBeVisible();
    await waitForHydrationSettle(page);
    expectConsoleClean(capture, `GET /products/${PRODUCT_SLUG}/review`);
  });
});

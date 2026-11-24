/**
 * AECI-2111: `/admin/claims`, `/admin/claims/:id`, `/admin/requests`,
 * `/admin/threads` and `/admin/threads/:id` on the console recipe.
 *
 * Two halves, as in `admin-review-updates.spec.ts`.
 *
 * 1. The SSR auth gate. No session needed, always runs.
 *
 * 2. As a minted admin (`auth-session.ts`), each page with its list rows from
 *    `admin-claims-requests-threads.fixtures.ts`: axe (WCAG 2.2 AA) at 1440, 390 and
 *    320 with a row open, and no sideways page scroll at 320 (the tables scroll
 *    inside their own region). The local seed has no claims, requests or threads,
 *    so the fixtures answer the pages' browser-side reads. Every write is refused by
 *    the stub, so nothing here can approve, decline or change a local D1 row. It
 *    SKIPS (never red) when a session cannot be minted.
 *
 * Locally: `pnpm dev:agent`, then
 * `AECI_WEB_PORT=<web port> pnpm --filter web exec playwright test admin-claims-requests-threads`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { mintSessionCookies } from './auth-session';
import {
  CLAIM_CONFLICT_ID,
  CLAIM_OPEN_ID,
  THREAD_ID,
  stubAdminA1bApi,
} from './admin-claims-requests-threads.fixtures';

/** Each page, and a word that shows once its browser-side fetch has rendered. */
const PAGES = [
  { path: '/admin/claims', ready: 'Procore' },
  { path: `/admin/claims/${CLAIM_OPEN_ID}`, ready: 'Procore' },
  { path: `/admin/claims/${CLAIM_CONFLICT_ID}`, ready: 'Fieldline Software' },
  { path: '/admin/requests', ready: 'Trimble Connect' },
  { path: '/admin/threads', ready: 'Submittal' },
  { path: `/admin/threads/${THREAD_ID}`, ready: 'Do yours come back to us?' },
] as const;

test.describe('claims, requests and threads — SSR auth gate (AECI-2111)', () => {
  for (const path of ['/admin/claims', '/admin/requests', '/admin/threads']) {
    test(`${path} redirects a logged-out visitor to sign in`, async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(303);
      expect(res.headers()['location']).toBe(`/auth/login?return=${encodeURIComponent(path)}`);
      expect(res.headers()['cache-control']).toBe('private, no-store');
    });
  }
});

/** Why the session half did not run. Shown in the report, never silent. */
const NO_SESSION =
  'No admin session could be minted: SUPABASE_URL, SUPABASE_ANON_KEY or SUPABASE_TEST_USER_EMAIL/PASSWORD is unset, or sign-in failed. The axe, reflow and focus checks for these pages did NOT run.';

/** Open every expandable row on the page, so axe sees the detail rows too. */
async function openEveryRow(page: Page): Promise<void> {
  const toggles = page.locator('aec-admin-disclosure-button button[aria-expanded="false"]');
  const count = await toggles.count();
  for (let i = 0; i < count; i++) {
    await toggles.first().click();
  }
}

test.describe('claims, requests and threads — console recipe as an admin (AECI-2111)', () => {
  let cookies: Awaited<ReturnType<typeof mintSessionCookies>> = null;

  test.beforeAll(async () => {
    const baseURL = test.info().project.use.baseURL;
    if (baseURL) cookies = await mintSessionCookies(baseURL);
    // Loud, once: a run without credentials must not read as a pass.
    if (!cookies) console.warn(`\n[admin-claims-requests-threads] SKIPPED: ${NO_SESSION}\n`);
  });

  // The one skip for this block. Every case below needs the session, so a run without
  // one shows each case as skipped with this reason and a warning annotation.
  test.beforeEach(async () => {
    if (!cookies) test.info().annotations.push({ type: 'warning', description: NO_SESSION });
    test.skip(!cookies, NO_SESSION);
  });

  for (const width of [1440, 390, 320]) {
    for (const { path, ready } of PAGES) {
      test(`${path} at ${width}: zero axe violations with rows open, no sideways scroll`, async ({
        page,
        context,
      }) => {
        await context.addCookies(cookies!);
        await page.setViewportSize({ width, height: 900 });
        await stubAdminA1bApi(page);
        await page.goto(path);
        await expect(page.locator('h2').first()).toBeVisible();
        // The lists and the detail fetch in the browser; wait for the fixture rows.
        await expect(page.getByText(ready).first()).toBeVisible();
        await openEveryRow(page);

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(
          results.violations.map(
            (v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
          ),
        ).toEqual([]);

        if (width === 320) {
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
        }
      });
    }
  }

  test('a claim row opens, moves focus into Reject, and Escape returns it', async ({
    page,
    context,
  }) => {
    await context.addCookies(cookies!);
    await stubAdminA1bApi(page);
    await page.goto('/admin/claims');
    const toggle = page.getByRole('button', { name: /^Claim on Procore by Sam Rivera$/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.locator(`#claim-${CLAIM_OPEN_ID}-reject`).click();
    await expect(page.locator(`#claim-reason-${CLAIM_OPEN_ID}`)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator(`#claim-reason-${CLAIM_OPEN_ID}`)).toHaveCount(0);
    await expect(page.locator(`#claim-${CLAIM_OPEN_ID}-reject`)).toBeFocused();
  });
});

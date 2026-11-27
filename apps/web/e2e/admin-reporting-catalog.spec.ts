/**
 * AECI-2125: `/admin/activity`, `/admin/traffic`, `/admin/audience`,
 * `/admin/subscribers`, `/admin/catalog`, `/admin/connectors`,
 * `/admin/connectors/:id` and `/admin/reindex` on the console recipe.
 *
 * As a minted admin (`auth-session.ts`), each page with its browser-side reads
 * answered by the `admin-a3a-*.fixtures.ts` stubs: axe (WCAG 2.2 AA) at 1440, 390
 * and 320 with every row and inline form open, and no sideways page scroll at 320
 * (tables scroll inside their own region). The local seed has little or none of
 * this data, so the fixtures stand in. Every write is refused by the stubs, so
 * nothing here can re-index, write to Algolia, promote, email or change a local D1
 * row. It SKIPS (never red) when a session cannot be minted.
 *
 * Locally: `pnpm dev:agent`, then
 * `AECI_WEB_PORT=<web port> pnpm --filter web exec playwright test admin-reporting-catalog`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { mintSessionCookies } from './auth-session';
import {
  A3A_CATALOG_OPS_PAGES,
  openA3aForms,
  stubA3aCatalogOps,
} from './admin-a3a-catalog-ops.fixtures';
import { A3A_INSIGHTS_PAGES, stubA3aInsights } from './admin-a3a-insights.fixtures';
import { A3A_ROSTER_PAGES, stubA3aRoster } from './admin-a3a-roster.fixtures';

const PAGES = [...A3A_ROSTER_PAGES, ...A3A_INSIGHTS_PAGES, ...A3A_CATALOG_OPS_PAGES];

/** Why the session half did not run. Shown in the report, never silent. */
const NO_SESSION =
  'No admin session could be minted: SUPABASE_URL, SUPABASE_ANON_KEY or SUPABASE_TEST_USER_EMAIL/PASSWORD is unset, or sign-in failed. The axe and reflow checks for these pages did NOT run.';

async function stubAll(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('aeci_analytics_consent', 'denied'));
  await stubA3aRoster(page);
  await stubA3aInsights(page);
  await stubA3aCatalogOps(page);
}

/**
 * Open every expandable row and every inline form opener, so axe sees them open.
 * Openers are the console's disclosure buttons and any collapsed `aria-expanded`
 * button inside the page's `main`, outside the shell's nav.
 */
async function openEverything(page: Page): Promise<void> {
  const closed = page.locator(
    'main aec-admin-disclosure-button button[aria-expanded="false"], main section button[aria-expanded="false"]',
  );
  for (let guard = 0; guard < 40; guard++) {
    const count = await closed.count();
    if (count === 0) break;
    await closed.first().click();
  }
}

test.describe('reporting and catalog pages — console recipe as an admin (AECI-2125)', () => {
  let cookies: Awaited<ReturnType<typeof mintSessionCookies>> = null;

  test.beforeAll(async () => {
    const baseURL = test.info().project.use.baseURL;
    if (baseURL) cookies = await mintSessionCookies(baseURL);
    if (!cookies) console.warn(`\n[admin-reporting-catalog] SKIPPED: ${NO_SESSION}\n`);
  });

  test.beforeEach(async () => {
    if (!cookies) test.info().annotations.push({ type: 'warning', description: NO_SESSION });
    test.skip(!cookies, NO_SESSION);
  });

  // AECI-2127: in Chromium the date input's last Tab stop is its calendar-picker
  // button, and there the input matches only :focus-within. Shift+Tab from the
  // "to" field lands on the "from" field's picker, the stop that drew no ring.
  for (const { path, from, to } of [
    { path: '/admin/activity', from: '#admin-activity-from', to: '#admin-activity-to' },
    {
      path: '/admin/reindex',
      from: '#admin-reindex-history-from',
      to: '#admin-reindex-history-to',
    },
  ]) {
    test(`${path}: a date input keeps its focus ring on the calendar-picker Tab stop`, async ({
      page,
      context,
    }) => {
      await context.addCookies(cookies!);
      await stubAll(page);
      await page.goto(path);
      await page.locator(to).focus();
      await page.keyboard.press('Shift+Tab');
      const ring = await page.locator(from).evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          active: document.activeElement === el,
          style: s.outlineStyle,
          width: s.outlineWidth,
        };
      });
      expect(ring).toEqual({ active: true, style: 'solid', width: '3px' });
    });
  }

  for (const width of [1440, 390, 320]) {
    for (const { path, ready } of PAGES) {
      test(`${path} at ${width}: zero axe violations with rows and forms open, no sideways scroll`, async ({
        page,
        context,
      }) => {
        await context.addCookies(cookies!);
        await page.setViewportSize({ width, height: 900 });
        await stubAll(page);
        await page.goto(path);
        await expect(page.locator('h2').first()).toBeVisible();
        // A ready word can also sit in a hidden tab panel, so wait for a visible copy.
        await expect(page.getByText(ready).filter({ visible: true }).first()).toBeVisible();
        await openEverything(page);
        // The named inline forms (Managed by, mapping edit) and the re-index Done dialog.
        await openA3aForms(page, path);

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
});

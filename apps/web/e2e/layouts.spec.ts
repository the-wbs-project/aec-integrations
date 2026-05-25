import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Phase 2.6 (AECI-52). Smoke for the three reusable layout shells via their
// preview routes. Validates: SSR returns 200, slots render, axe-core finds no
// violations in light AND dark, and the responsive breakpoint behaviour kicks
// in at the small viewport.

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';

const LAYOUTS = [
  {
    name: 'detail',
    path: '/preview/layouts/detail',
    selectors: {
      hero: 'h1:has-text("Example Product")',
      sidebar: 'aside[aria-label="Metadata"]',
      body: 'h2:has-text("Overview")',
    },
  },
  {
    name: 'browse',
    path: '/preview/layouts/browse',
    selectors: {
      hero: 'h1:has-text("Products")',
      sidebar: 'aside[aria-label="Filters"]',
      grid: 'section[aria-label="Results"]',
    },
  },
  {
    name: 'index',
    path: '/preview/layouts/index',
    selectors: {
      hero: 'h1:has-text("Vendors")',
      table: 'table[aria-label="Results table"]',
      pagination: 'nav[aria-label="Pagination"]',
    },
  },
] as const;

test.describe('layout shells (preview routes)', () => {
  for (const layout of LAYOUTS) {
    test(`${layout.name} layout returns 200 and renders required slots`, async ({ page }) => {
      const res = await page.goto(layout.path);
      expect(res?.status(), `GET ${layout.path} must return 200`).toBe(200);

      for (const selector of Object.values(layout.selectors)) {
        await expect(page.locator(selector).first()).toBeVisible();
      }
    });

    test(`${layout.name} layout has zero axe violations in light theme`, async ({ page }) => {
      await page.goto(layout.path);
      await expect(page.locator('app-root')).toBeAttached();
      // Exclude site chrome (header / footer) — owned by AECI-32, not this
      // issue. Pre-existing dark-mode contrast issues in the footer are
      // tracked separately; re-test the chrome there.
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .exclude('aec-site-header')
        .exclude('aec-site-footer')
        .analyze();
      expect(results.violations, formatViolations(results.violations)).toEqual([]);
    });

    test(`${layout.name} layout has zero axe violations in dark theme`, async ({
      page,
      context,
    }) => {
      const url = new URL(BASE_URL);
      await context.addCookies([
        {
          name: 'theme',
          value: 'dark',
          domain: url.hostname,
          path: '/',
          secure: url.protocol === 'https:',
          sameSite: 'Lax',
        },
      ]);
      await context.addInitScript(() => {
        try {
          window.localStorage.setItem('theme', 'dark');
        } catch {
          /* private mode / storage blocked — ignore */
        }
      });

      await page.goto(layout.path);
      // Wait for the client-side theme service to apply .theme-dark from
      // localStorage. No explicit timeout — inherits the test-level default
      // so CI machines with slower hydration don't produce false failures.
      await page.waitForFunction(() => document.documentElement.classList.contains('theme-dark'));

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .exclude('aec-site-header')
        .exclude('aec-site-footer')
        .analyze();
      expect(results.violations, formatViolations(results.violations)).toEqual([]);
    });

    test(`${layout.name} layout renders on a 375x667 viewport without horizontal page scroll`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto(layout.path);
      await expect(page.locator('app-root')).toBeAttached();

      // The page itself must not scroll horizontally; the index layout's
      // table wraps in its own overflow container instead.
      const docOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(docOverflow, 'document must not overflow horizontally on mobile').toBeLessThanOrEqual(
        1,
      );
    });
  }
});

function formatViolations(
  violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations'],
): string {
  if (violations.length === 0) return '';
  return violations
    .map(
      (v) =>
        `[${v.impact ?? '?'}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n` +
        v.nodes.map((n) => `    ${n.target.join(' ')}`).join('\n'),
    )
    .join('\n\n');
}

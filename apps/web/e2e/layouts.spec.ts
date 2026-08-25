import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Phase 2.6 (AECI-52). Smoke for the reusable layout shells via their preview
// routes. Validates: SSR returns 200, slots render, axe-core finds no
// violations, and the responsive breakpoint behaviour kicks in at the small
// viewport.
//
// Originally three shells. `IndexLayout` was deleted once its last consumer
// went away: AECI-165 removed the `/vendors` + `/integrations` index pages and
// AECI-190 moved `/products` onto `BrowseLayout`, leaving the shell reachable
// only from its own preview route. Two shells ship.

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

    test(`${layout.name} layout has zero axe violations`, async ({ page }) => {
      await page.goto(layout.path);
      await expect(page.locator('app-root')).toBeAttached();
      // Exclude the site header — its nav chrome is owned by AECI-32 and fully
      // covered by nav-menu.spec.ts, so re-testing it here is redundant. The
      // footer IS in scope: its former carve-out was for dark-theme contrast
      // debt, which went away with the dark theme in AECI-226.
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .exclude('aec-site-header')
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

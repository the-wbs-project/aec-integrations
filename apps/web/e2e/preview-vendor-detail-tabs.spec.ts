import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// AECI-132. Pilot of Angular Aria (`@angular/aria`) tabs on the demo/preview
// vendor-detail surface (preview routes are 404'd in production — zero
// user-facing risk). Validates the ADR 0010 acceptance: axe-clean in BOTH
// themes, plus keyboard navigation (arrow keys, Home/End, activation) driving
// selection and panel visibility.
//
// `ngTabList` runs in its default `selectionMode="follow"` (automatic
// activation), so arrow/Home/End keys both move focus AND activate the tab —
// matching the original Spartan `BrnTabs` UX. Panels use `ngTabContent`, so the
// inactive panel renders no content (asserted via `toBeHidden`, which is true
// for detached nodes too).

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';
const PATH = '/preview/vendor-detail';

// Panel-specific, stable content markers.
const OVERVIEW_MARKER = '#company-card-title'; // <h2> "Company" — overview panel only
const PRODUCTS_MARKER = 'button[aria-label*="category rankings"]'; // info popover — products panel only

test.describe('preview vendor-detail tabs (Angular Aria pilot)', () => {
  test('returns 200 with the Overview panel selected by default', async ({ page }) => {
    const res = await page.goto(PATH);
    expect(res?.status(), `GET ${PATH} must return 200`).toBe(200);

    const overviewTab = page.getByRole('tab', { name: 'Overview' });
    const productsTab = page.getByRole('tab', { name: /Products/ });

    await expect(overviewTab).toHaveAttribute('aria-selected', 'true');
    await expect(productsTab).not.toHaveAttribute('aria-selected', 'true');

    await expect(page.locator(OVERVIEW_MARKER)).toBeVisible();
    await expect(page.locator(PRODUCTS_MARKER).first()).toBeHidden();
  });

  test('keyboard navigation (arrows, Home/End) moves selection and panels', async ({ page }) => {
    await page.goto(PATH);

    const overviewTab = page.getByRole('tab', { name: 'Overview' });
    const productsTab = page.getByRole('tab', { name: /Products/ });

    await overviewTab.focus();
    await expect(overviewTab).toBeFocused();

    // ArrowRight → Products (follow mode activates on navigation).
    await page.keyboard.press('ArrowRight');
    await expect(productsTab).toBeFocused();
    await expect(productsTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(PRODUCTS_MARKER).first()).toBeVisible();
    await expect(page.locator(OVERVIEW_MARKER)).toBeHidden();

    // ArrowLeft → back to Overview.
    await page.keyboard.press('ArrowLeft');
    await expect(overviewTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(OVERVIEW_MARKER)).toBeVisible();

    // End → last tab (Products); Home → first tab (Overview).
    await page.keyboard.press('End');
    await expect(productsTab).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(overviewTab).toHaveAttribute('aria-selected', 'true');
  });

  test('pointer + Enter/Space activation switches panels', async ({ page }) => {
    await page.goto(PATH);

    const overviewTab = page.getByRole('tab', { name: 'Overview' });
    const productsTab = page.getByRole('tab', { name: /Products/ });

    // Pointer activation.
    await productsTab.click();
    await expect(productsTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(PRODUCTS_MARKER).first()).toBeVisible();

    await overviewTab.click();
    await expect(overviewTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(OVERVIEW_MARKER)).toBeVisible();

    // Activation keys on a focused tab keep it selected (no regression).
    await overviewTab.focus();
    await page.keyboard.press('Enter');
    await expect(overviewTab).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Space');
    await expect(overviewTab).toHaveAttribute('aria-selected', 'true');
  });

  // Axe scope: the ported tab CONTROLS (`[role="tablist"]` + its tabs). The rest
  // of this demo page carries pre-existing WCAG-AA color-contrast debt from the
  // `--text-tertiary` token on small labels (header eyebrow, card titles, dt
  // labels) — unrelated to the Aria port and not introduced by it. Scoping keeps
  // this pilot's a11y assertion honest (it validates what AECI-132 changed); the
  // page-wide token debt is tracked separately. The tab controls themselves use
  // `--text-secondary`/`--text-primary`, which pass AA in both themes.
  const TABLIST = '[role="tablist"]';

  test('tab controls have zero axe violations in light theme', async ({ page }) => {
    await page.goto(PATH);
    await expect(page.locator(TABLIST)).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include(TABLIST)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });

  test('tab controls have zero axe violations in dark theme', async ({ page, context }) => {
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

    await page.goto(PATH);
    await page.waitForFunction(() => document.documentElement.classList.contains('theme-dark'));
    await expect(page.locator(TABLIST)).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include(TABLIST)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });
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

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// AECI-96. The primary navigation (DESIGN.md §5) is responsive. Below `md` it is
// a labelled hamburger to the left of the wordmark that opens a CDK-overlay
// dropdown holding all site chrome — the four directory links, search, the theme
// toggle, and the Sign-in CTA. At `md+` the hamburger drops out and those
// affordances render as an inline desktop nav + actions cluster in the header
// bar. The two viewports below exercise both arrangements: the overlay at a phone
// width, the inline nav at a desktop width.
//
// Unlike layouts.spec.ts (which EXCLUDES the header from axe), this spec is
// specifically about the header/menu, so axe INCLUDES `aec-site-header` and the
// open overlay panel. We exclude only `aec-site-footer` to avoid coupling to
// pre-existing footer findings tracked elsewhere.

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';
// Any route renders the global header; browse is a known-200 preview route.
const ROUTE = '/preview/layouts/browse';
const MOBILE = { width: 375, height: 667 } as const;
const DESKTOP = { width: 1280, height: 800 } as const;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const NAV_LINKS = ['Products', 'Vendors', 'Integrations', 'Categories'] as const;

// CSS locator, not getByRole: while the menu is open the popover marks the
// background (including the trigger) aria-hidden for the focus trap, so a
// role/name query can't find the toggle mid-open. A CSS locator still resolves
// it for state/focus assertions. The accessible NAME is asserted separately in
// the closed state below.
function toggle(page: Page) {
  return page.locator('aec-nav-menu button');
}

function overlay(page: Page) {
  return page.locator('.cdk-overlay-container');
}

test.describe('primary navigation menu (375px)', () => {
  test.use({ viewport: MOBILE });

  test('the labelled menu toggle is reachable and the header does not overflow', async ({
    page,
  }) => {
    await page.goto(ROUTE);
    await expect(page.locator('app-root')).toBeAttached();

    // The always-visible toggle: present with an accessible name (closed state,
    // so it's in the a11y tree and resolvable by role + name).
    const named = page.getByRole('button', { name: 'Open menu' });
    await expect(named).toBeVisible();
    await expect(named).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(named).toHaveAttribute('aria-expanded', 'false');

    // No horizontal page overflow with the toggle present (guards the header
    // density on the narrowest supported width).
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'document must not overflow horizontally on mobile').toBeLessThanOrEqual(1);
  });

  test('opening the menu exposes links, search, theme group, and sign-in', async ({ page }) => {
    await page.goto(ROUTE);
    await toggle(page).click();

    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    for (const name of NAV_LINKS) {
      await expect(overlay(page).getByRole('link', { name })).toBeVisible();
    }
    await expect(overlay(page).getByRole('searchbox')).toBeVisible();
    // The theme control inside the menu is a segmented button group (the compact
    // cycle button stays on the desktop bar). All three modes are direct targets,
    // with the default 'system' pressed; the Sign-in CTA also lives in the menu.
    const themeGroup = overlay(page).getByRole('group', { name: 'Theme' });
    await expect(themeGroup.getByRole('button', { name: 'System' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(themeGroup.getByRole('button', { name: 'Light' })).toBeVisible();
    await expect(themeGroup.getByRole('button', { name: 'Dark' })).toBeVisible();
    await expect(overlay(page).getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('the theme button group selects a mode and drives the theme', async ({ page }) => {
    await page.goto(ROUTE);
    await toggle(page).click();

    const themeGroup = overlay(page).getByRole('group', { name: 'Theme' });
    const system = themeGroup.getByRole('button', { name: 'System' });
    const dark = themeGroup.getByRole('button', { name: 'Dark' });
    await expect(system).toHaveAttribute('aria-pressed', 'true');

    await dark.click();

    // Selection moves to Dark and actually drives the document theme — the menu
    // stays open (a mode button is not a navigation, unlike the links above).
    await expect(dark).toHaveAttribute('aria-pressed', 'true');
    await expect(system).toHaveAttribute('aria-pressed', 'false');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('theme-dark')))
      .toBe(true);
  });

  test('Escape closes the menu and returns focus to the toggle', async ({ page }) => {
    await page.goto(ROUTE);
    await toggle(page).click();
    await expect(overlay(page).getByRole('link', { name: 'Products' })).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(overlay(page).getByRole('link', { name: 'Products' })).toBeHidden();
    await expect(toggle(page)).toBeFocused();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('clicking outside closes the menu', async ({ page }) => {
    await page.goto(ROUTE);
    await toggle(page).click();
    await expect(overlay(page).getByRole('link', { name: 'Products' })).toBeVisible();

    // Click the page body away from the panel.
    await page.mouse.click(5, 400);

    await expect(overlay(page).getByRole('link', { name: 'Products' })).toBeHidden();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('selecting a nav link navigates and closes the menu', async ({ page }) => {
    await page.goto(ROUTE);
    await toggle(page).click();
    const link = overlay(page).getByRole('link', { name: 'Products' });
    await expect(link).toBeVisible();

    await link.click();

    // The header (and this menu) live in the persistent app shell, so the
    // overlay would otherwise stay open over the destination after navigation.
    await page.waitForURL(/\/products$/);
    await expect(overlay(page).getByRole('link', { name: 'Products' })).toBeHidden();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('header + menu are axe-clean (closed and open) in light theme', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(toggle(page)).toBeVisible();
    expect(await analyzeHeader(page), 'closed state').toEqual([]);

    await toggle(page).click();
    await expect(overlay(page).getByRole('link', { name: 'Products' })).toBeVisible();
    expect(await analyzeHeaderAndOverlay(page), 'open state').toEqual([]);
  });

  test('header + menu are axe-clean (closed and open) in dark theme', async ({ page, context }) => {
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

    await page.goto(ROUTE);
    await page.waitForFunction(() => document.documentElement.classList.contains('theme-dark'));
    await expect(toggle(page)).toBeVisible();
    expect(await analyzeHeader(page), 'closed state').toEqual([]);

    await toggle(page).click();
    await expect(overlay(page).getByRole('link', { name: 'Products' })).toBeVisible();
    expect(await analyzeHeaderAndOverlay(page), 'open state').toEqual([]);
  });
});

test.describe('primary navigation menu (1280px)', () => {
  test.use({ viewport: DESKTOP });

  // The responsive split flips at `md+`: the hamburger drops out of the layout
  // and the links, theme toggle, and Sign-in render inline in the header bar.
  test('inline nav replaces the hamburger at desktop width', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(page.locator('app-root')).toBeAttached();

    // The hamburger trigger is removed from the layout (md:hidden host).
    await expect(toggle(page)).toBeHidden();

    // The four directory links render inline inside the "Primary" landmark —
    // not in an overlay (none is mounted; nothing was clicked).
    const primaryNav = page.locator('aec-site-header').getByRole('navigation', { name: 'Primary' });
    for (const name of NAV_LINKS) {
      await expect(primaryNav.getByRole('link', { name })).toBeVisible();
    }

    // The theme toggle and Sign-in CTA sit inline in the header bar.
    const header = page.locator('aec-site-header');
    await expect(header.getByRole('button', { name: 'Cycle theme' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('desktop header is axe-clean in light theme', async ({ page }) => {
    await page.goto(ROUTE);
    const primaryNav = page.locator('aec-site-header').getByRole('navigation', { name: 'Primary' });
    await expect(primaryNav.getByRole('link', { name: 'Products' })).toBeVisible();
    expect(await analyzeHeader(page)).toEqual([]);
  });
});

async function analyzeHeader(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(AXE_TAGS)
    .include('aec-site-header')
    .analyze();
  return results.violations.map(formatViolation);
}

async function analyzeHeaderAndOverlay(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(AXE_TAGS)
    .include('aec-site-header')
    .include('.cdk-overlay-container')
    .analyze();
  return results.violations.map(formatViolation);
}

function formatViolation(v: {
  impact?: string | null;
  id: string;
  help: string;
  nodes: { target: unknown[] }[];
}): string {
  const targets = v.nodes.map((n) => `\n    ${n.target.join(' ')}`).join('');
  return `[${v.impact ?? '?'}] ${v.id}: ${v.help} (${v.nodes.length} node(s))${targets}`;
}

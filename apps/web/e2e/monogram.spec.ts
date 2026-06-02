import { expect, test, type BrowserContext } from '@playwright/test';

// AECI-94. The header/footer monogram swaps between a light-theme and a
// dark-theme SVG via Tailwind's `dark:` variant. `styles.css` binds that variant
// to the app's `.theme-dark` class (overriding the Spartan preset's `.dark`-based
// default), so the monogram must follow the user's *explicit* theme choice — not
// the never-set `.dark` class and not the OS `prefers-color-scheme` media query.
//
// Pre-fix, the monogram's `dark:` utilities keyed off the Spartan preset's `.dark`
// class, which this app never sets — so the dark variant never rendered and dark-
// theme users always saw the LIGHT mark. The first test reproduces exactly that:
// it fails pre-fix (dark theme, dark mark expected, light shown) and passes post-
// fix. Each test additionally emulates the OPPOSITE OS color scheme to prove the
// monogram is independent of `prefers-color-scheme` too.
//
// Target a static preview shell (no API resolver) rather than `/` — the global
// header/footer (and therefore the monogram) render around every route via the
// app.ts shell, and this matches the route choice in layouts.spec.ts.

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';
const ROUTE = '/preview/layouts/detail';

// Mirrors the SSR theme cookie that index.html's inline script reads to decide
// `.theme-dark` before hydration, plus the localStorage the client reconciles
// from. Same shape as apps/web/e2e/layouts.spec.ts.
async function forceAppTheme(context: BrowserContext, mode: 'light' | 'dark') {
  const url = new URL(BASE_URL);
  await context.addCookies([
    {
      name: 'theme',
      value: mode,
      domain: url.hostname,
      path: '/',
      secure: url.protocol === 'https:',
      sameSite: 'Lax',
    },
  ]);
  await context.addInitScript((value) => {
    try {
      window.localStorage.setItem('theme', value);
    } catch {
      /* private mode / storage blocked — ignore */
    }
  }, mode);
}

const headerLight = 'aec-site-header aec-monogram img[src*="monogram-light"]';
const headerDark = 'aec-site-header aec-monogram img[src*="monogram-dark"]';
const footerLight = 'aec-site-footer aec-monogram img[src*="monogram-light"]';
const footerDark = 'aec-site-footer aec-monogram img[src*="monogram-dark"]';

test.describe('monogram follows the in-app theme, not the OS color scheme', () => {
  test('app Dark on a Light OS shows the dark monogram', async ({ page, context }) => {
    await forceAppTheme(context, 'dark');
    // OS says light; the app theme (dark) must win.
    await page.emulateMedia({ colorScheme: 'light' });

    await page.goto(ROUTE);
    await page.waitForFunction(() => document.documentElement.classList.contains('theme-dark'));

    await expect(page.locator(headerDark)).toBeVisible();
    await expect(page.locator(headerLight)).toBeHidden();
    await expect(page.locator(footerDark)).toBeVisible();
    await expect(page.locator(footerLight)).toBeHidden();
  });

  test('app Light on a Dark OS shows the light monogram', async ({ page, context }) => {
    await forceAppTheme(context, 'light');
    // OS says dark; the app theme (light) must win.
    await page.emulateMedia({ colorScheme: 'dark' });

    await page.goto(ROUTE);
    await expect(page.locator('app-root')).toBeAttached();
    await page.waitForFunction(() => !document.documentElement.classList.contains('theme-dark'));

    await expect(page.locator(headerLight)).toBeVisible();
    await expect(page.locator(headerDark)).toBeHidden();
    await expect(page.locator(footerLight)).toBeVisible();
    await expect(page.locator(footerDark)).toBeHidden();
  });
});

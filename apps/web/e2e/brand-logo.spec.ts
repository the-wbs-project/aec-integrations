import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// AECI-94 (originally the monogram swap; the header/footer now render the
// landing-page brand wordmark — see apps/web/src/app/layout/brand-logo.ts).
//
// The wordmark's ink comes from design tokens, not a per-theme asset:
//   - text → var(--accent-primary)   (Forest, flips lighter in dark theme)
//   - mark → var(--accent-secondary) (Clay)
// `--accent-primary` is rebound when `.theme-dark` is toggled on <html>, so the
// logo must follow the user's *explicit* in-app theme — not the never-set
// Spartan `.dark` class and not the OS `prefers-color-scheme` media query. Each
// test emulates the OPPOSITE OS color scheme to prove the wordmark is
// independent of `prefers-color-scheme`.
//
// Target a static preview shell (no API resolver) rather than `/` — the global
// header/footer (and therefore the wordmark) render around every route via the
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

const headerLogo = 'aec-site-header aec-brand-logo';
const footerLogo = 'aec-site-footer aec-brand-logo';

// The wordmark "AEC" text is painted with `currentColor`, inherited from the
// link's `text-(--accent-primary)`. We prove that by comparing its computed
// `fill` to the resolved value of `var(--accent-primary)` in the *same*
// document — so the assertion holds in whichever theme is active without
// hardcoding an oklch/rgb literal.
async function wordmarkMatchesAccent(page: Page, logoSelector: string): Promise<boolean> {
  return page.evaluate((selector) => {
    const text = document.querySelector(`${selector} svg text`);
    if (!text) return false;
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent-primary)';
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return getComputedStyle(text).fill === expected;
  }, logoSelector);
}

test.describe('brand wordmark follows the in-app theme, not the OS color scheme', () => {
  test('app Dark on a Light OS paints the wordmark with the dark accent token', async ({
    page,
    context,
  }) => {
    await forceAppTheme(context, 'dark');
    // OS says light; the app theme (dark) must win.
    await page.emulateMedia({ colorScheme: 'light' });

    await page.goto(ROUTE);
    await page.waitForFunction(() => document.documentElement.classList.contains('theme-dark'));

    await expect(page.locator(`${headerLogo} svg`)).toBeVisible();
    await expect(page.locator(`${footerLogo} svg`)).toBeVisible();
    // The home link is the accessible target.
    await expect(page.locator(`${headerLogo} a[href="/"]`)).toHaveCount(1);
    expect(await wordmarkMatchesAccent(page, headerLogo)).toBe(true);
  });

  test('app Light on a Dark OS paints the wordmark with the light accent token', async ({
    page,
    context,
  }) => {
    await forceAppTheme(context, 'light');
    // OS says dark; the app theme (light) must win.
    await page.emulateMedia({ colorScheme: 'dark' });

    await page.goto(ROUTE);
    await expect(page.locator('app-root')).toBeAttached();
    await page.waitForFunction(() => !document.documentElement.classList.contains('theme-dark'));

    await expect(page.locator(`${headerLogo} svg`)).toBeVisible();
    await expect(page.locator(`${footerLogo} svg`)).toBeVisible();
    await expect(page.locator(`${headerLogo} a[href="/"]`)).toHaveCount(1);
    expect(await wordmarkMatchesAccent(page, headerLogo)).toBe(true);
  });
});

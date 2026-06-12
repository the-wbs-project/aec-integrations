import { expect, test, type Page } from '@playwright/test';

// AECI-94 (originally the monogram swap; the header/footer now render the
// landing-page brand wordmark — see apps/web/src/app/layout/brand-logo.ts).
//
// The wordmark's ink comes from design tokens, not a per-theme asset:
//   - text → var(--accent-primary)   (Forest)
//   - mark → var(--accent-secondary) (Clay)
// Both are applied via `currentColor`: the brand link sets
// `text-(--accent-primary)` and the wordmark `<text>` inherits it. We assert the
// wordmark is painted with the resolved `--accent-primary` token rather than a
// hardcoded literal, so the check is token-driven.
//
// Target a static preview shell (no API resolver) — the global header/footer
// (and therefore the wordmark) render around every route via the app.ts shell.

const ROUTE = '/preview/layouts/detail';
const headerLogo = 'aec-site-header aec-brand-logo';

// The wordmark "AEC" text is painted with `currentColor`, inherited from the
// link's `text-(--accent-primary)`. We prove that by comparing its computed
// `fill` to the resolved value of `var(--accent-primary)` in the *same*
// document — so the assertion holds without hardcoding an oklch/rgb literal.
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

test.describe('brand wordmark renders with the Forest accent token', () => {
  test('the wordmark link paints with var(--accent-primary)', async ({ page }) => {
    await page.goto(ROUTE);
    await expect(page.locator('app-root')).toBeAttached();

    // The home link is the accessible target carrying the accent token.
    const brandLink = page.locator(`${headerLogo} a[aria-label="AEC Integrations home"]`);
    await expect(brandLink).toHaveCount(1);
    await expect(page.locator(`${headerLogo} svg`)).toBeVisible();

    // The wordmark text resolves to the live --accent-primary value (non-empty,
    // token-driven) rather than a hardcoded color.
    expect(await wordmarkMatchesAccent(page, headerLogo)).toBe(true);
  });
});

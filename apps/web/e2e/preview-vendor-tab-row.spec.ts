import { expect, test, type Page } from '@playwright/test';

import { untilAppStable, untilHydrated } from './hydration';

/**
 * AECI-1809: the portal tab row at 390px, where it scrolls sideways under edge fades.
 *
 * Two promises, both found by the PR #1483 review:
 *   - A pointer click on a tab half under the end fade navigates with ONE click. The
 *     row scrolls a focused tab clear of the fades for keyboard focus only. Chrome
 *     focuses a link on mousedown, so scrolling then moved the row under the pointer
 *     and the mouseup landed elsewhere. The click below is a single real sequence,
 *     down then up, with no retry: a retry would hide exactly that failure.
 *   - A tab reached with Tab is scrolled fully into the row.
 *
 * Runs on the ungated preview (no session, no `/vendor/` path). Every request off the
 * local stack is answered here: PostHog with an empty 200, the rest aborted.
 */
const PATH = '/preview/vendor-dashboard';

test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return route.continue();
    if (/posthog/.test(host)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
});

const row = (page: Page) => page.getByRole('navigation', { name: 'Portal sections' }).locator('ul');

/** The first tab whose end lies past the row's visible end: the one under the fade. */
async function halfHiddenTab(page: Page): Promise<{ href: string; x: number; y: number }> {
  return row(page).evaluate((ul) => {
    const box = ul.getBoundingClientRect();
    for (const a of Array.from(ul.querySelectorAll('a'))) {
      const r = a.getBoundingClientRect();
      if (r.right > box.right && r.left < box.right - 24) {
        // A point on the tab's visible part, inside the fade.
        return { href: a.getAttribute('href') ?? '', x: box.right - 16, y: r.top + r.height / 2 };
      }
    }
    throw new Error('no tab straddles the row end');
  });
}

test.describe('portal tab row at 390px (AECI-1809)', () => {
  test('one pointer click on a half-faded tab navigates', async ({ page }) => {
    await page.goto(`${PATH}/overview?fixture=verified`);
    await untilAppStable(page);
    // At 390px the preview's sticky fixture bar and the cookie banner cover the row.
    // Both are outside the surface under test, so the pointer must not meet them.
    await page.addStyleTag({
      content:
        '[aria-label="Concept switcher (dev only)"],aec-consent-banner{display:none!important}',
    });
    await row(page).evaluate((ul) => ul.scrollIntoView({ block: 'center' }));
    await expect(row(page)).toHaveClass(/aec-fade-end/);
    const target = await halfHiddenTab(page);
    await untilHydrated(row(page).locator(`a[href="${target.href}"]`));
    const before = await row(page).evaluate((ul) => ul.scrollLeft);

    await page.mouse.move(target.x, target.y);
    await page.mouse.down();
    // Pointer focus must not scroll the row between down and up.
    expect(await row(page).evaluate((ul) => ul.scrollLeft)).toBe(before);
    await page.mouse.up();

    await expect(page).toHaveURL(new RegExp(`${target.href}$`));
    await expect(row(page).locator(`a[href="${target.href}"]`)).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('a tab reached with Tab is fully inside the row', async ({ page }) => {
    await page.goto(`${PATH}/overview?fixture=verified`);
    await untilAppStable(page);
    const tabs = row(page).locator('a');
    await tabs.first().focus();
    const count = await tabs.count();
    for (let i = 1; i < count; i++) {
      await page.keyboard.press('Tab');
      const inside = await row(page).evaluate((ul) => {
        const a = document.activeElement as HTMLElement;
        const box = ul.getBoundingClientRect();
        const r = a.getBoundingClientRect();
        return ul.contains(a) && r.left >= box.left - 1 && r.right <= box.right + 1;
      });
      expect(inside, `tab ${i + 1} of ${count} is fully visible when focused`).toBe(true);
    }
  });
});

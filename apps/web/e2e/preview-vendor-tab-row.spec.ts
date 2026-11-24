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
  // AECI_E2E_BLOCK_FONTS=1 aborts the web fonts, so the tabs render in the fallback face.
  // The spec must pass both ways: it never depends on where a tab edge falls by chance.
  const blockFonts = process.env['AECI_E2E_BLOCK_FONTS'] === '1';
  await context.route('**/*', (route) => {
    const request = route.request();
    const host = new URL(request.url()).hostname;
    if (blockFonts && request.resourceType() === 'font') return route.abort();
    if (host === 'localhost' || host === '127.0.0.1') return route.continue();
    if (/posthog/.test(host)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
});

const row = (page: Page) => page.getByRole('navigation', { name: 'Portal sections' }).locator('ul');

/** Two animation frames: the scroll has applied and the fades have re-measured. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

/** Opens the overview at 390px with the fonts settled and the row in the middle of the screen. */
async function openRow(page: Page): Promise<void> {
  await page.goto(`${PATH}/overview?fixture=verified`);
  await untilAppStable(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // At 390px the preview's sticky fixture bar and the cookie banner cover the row.
  // Both are outside the surface under test, so the pointer must not meet them.
  await page.addStyleTag({
    content:
      '[aria-label="Concept switcher (dev only)"],aec-consent-banner{display:none!important}',
  });
  await row(page).evaluate((ul) => ul.scrollIntoView({ block: 'center' }));
  await settle(page);
  // Precondition: nine tabs never fit 390px, whatever the face.
  expect(await row(page).evaluate((ul) => ul.scrollWidth - ul.clientWidth)).toBeGreaterThan(40);
}

/**
 * Scrolls the row so its end edge cuts one tab through its middle, and returns that tab
 * and a point on its visible half. Deterministic: it does not wait for a tab to happen
 * to straddle the edge at rest, which depends on the font's metrics.
 */
async function cutTabAtRowEnd(page: Page): Promise<{ href: string; x: number; y: number }> {
  const href = await row(page).evaluate((ul) => {
    const max = ul.scrollWidth - ul.clientWidth;
    for (const a of Array.from(ul.querySelectorAll('a'))) {
      const scroll = a.offsetLeft + a.offsetWidth / 2 - ul.clientWidth;
      if (scroll > 0 && scroll < max) {
        ul.scrollLeft = scroll;
        ul.dispatchEvent(new Event('scroll'));
        return a.getAttribute('href') ?? '';
      }
    }
    throw new Error('no tab can be cut at the row end');
  });
  await settle(page);
  return row(page).evaluate((ul, target) => {
    const a = ul.querySelector(`a[href="${target}"]`) as HTMLElement;
    const box = ul.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    if (!(r.left < box.right - 4 && r.right > box.right + 4)) {
      throw new Error(
        `the tab does not straddle the row end (${r.left}-${r.right} vs ${box.right})`,
      );
    }
    // A point inside the visible half, a quarter of the tab in from the edge.
    return { href: target, x: box.right - (box.right - r.left) / 2, y: r.top + r.height / 2 };
  }, href);
}

test.describe('portal tab row at 390px (AECI-1809)', () => {
  test('one pointer click on a half-faded tab navigates', async ({ page }) => {
    await openRow(page);
    const target = await cutTabAtRowEnd(page);
    await expect(row(page)).toHaveClass(/aec-fade-end/);
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
    // The row overflows (openRow asserts it), so some tabs start outside it. Every one
    // must come fully into view when Tab reaches it, from whichever position.
    await openRow(page);
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

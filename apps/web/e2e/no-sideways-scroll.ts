/**
 * The one "the page does not scroll sideways" check (docs/TESTING_STRATEGY.md).
 *
 * It compares the root's `scrollWidth` with its `clientWidth` and passes when
 * `scrollWidth <= clientWidth`. Never assert equality, or a difference of exactly 0.
 * On Linux CI the root's `scrollWidth` excludes the classic scrollbar gutter and
 * `clientWidth` does not, so `scrollWidth` can be the smaller one on a page that
 * does not overflow. Three specs failed in CI that way.
 *
 * `tolerance` keeps a check that already allowed a pixel of sub-pixel rounding at
 * the same strength. Do not raise it to make a real overflow pass.
 *
 * This is for the page root only. A check that compares an element's width with
 * its container (a header row, a scroll strip, a clipped label) stays as it is.
 */
import { expect, type Page } from '@playwright/test';

export async function expectNoSidewaysScroll(
  page: Page,
  message = 'the page must not scroll sideways',
  { tolerance = 0 }: { tolerance?: number } = {},
): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    scrollWidth,
    `${message} (root scrollWidth ${scrollWidth}px, clientWidth ${clientWidth}px)`,
  ).toBeLessThanOrEqual(clientWidth + tolerance);
}

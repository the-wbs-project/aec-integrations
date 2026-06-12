import { expect, test, type Page } from '@playwright/test';

/**
 * AECI-153 — RTL readiness.
 *
 * No RTL locale ships (en-US only), so we prove the *mechanism* rather than a
 * translated build: when `dir="rtl"` is set on the document element, every
 * logical Tailwind utility must flip from its inline-start physical side to
 * inline-end. If a utility were still physical (`ml-*`, `text-right`, …) the
 * resolved margin would NOT move when `dir` flips — that's the regression this
 * guards (alongside the static `check-logical-properties.mjs` lint guard).
 *
 * Seed-free by design (same constraint as products-detail.spec.ts: the local /
 * CI dev DB is empty, so real detail/index *rows* may be absent). We assert on
 * the preview vendor-detail surface, which renders a static fixture with no DB
 * — and which is itself a vendor-detail layout port. Two observable proofs:
 *
 *   1. Logical margin (`ms-1.5` on the Products-tab count) resolves to the
 *      physical LEFT under LTR and the physical RIGHT under RTL. This needs no
 *      Tailwind variant — it is the CSS logical property doing the work.
 *   2. The directional `↗` glyph (mirrored via `rtl:-scale-x-100`) carries no
 *      transform under LTR and a horizontal-flip transform under RTL.
 */

const PATH = '/preview/vendor-detail';

/** Computed inline-margin + transform for the two probe elements. */
async function probe(page: Page) {
  return page.evaluate(() => {
    // The Products-tab count span: `class="ms-1.5 tabular-nums …"`. The only
    // tabular-nums span inside a [role=tab] (the Overview tab has none).
    const count = document.querySelector('[role="tab"] span.tabular-nums');
    // The "Visit website" external-link arrow (decorative, mirrored).
    const arrow = Array.from(document.querySelectorAll('span[aria-hidden="true"]')).find(
      (s) => s.textContent?.trim() === '↗',
    );
    const countCs = count ? getComputedStyle(count) : null;
    const arrowCs = arrow ? getComputedStyle(arrow) : null;
    return {
      foundCount: !!count,
      foundArrow: !!arrow,
      marginLeft: countCs?.marginLeft ?? null,
      marginRight: countCs?.marginRight ?? null,
      // Tailwind v4 `-scale-x-100` sets the CSS `scale` property (not
      // `transform`): "none" with no RTL ancestor, "-1 1" under dir=rtl.
      scale: arrowCs?.scale ?? null,
    };
  });
}

function parseScaleX(scale: string | null): number | null {
  if (!scale || scale === 'none') return null;
  return Number(scale.trim().split(/\s+/)[0]);
}

async function assertFlips(page: Page) {
  await page.goto(PATH);
  // The preview fixture renders without a DB; the tab list proves it mounted.
  await expect(page.locator('[role="tablist"]')).toBeVisible();

  const ltr = await probe(page);
  expect(ltr.foundCount, 'ms-1.5 count span must be present').toBe(true);
  expect(ltr.foundArrow, '↗ arrow span must be present').toBe(true);

  // ms-1.5 = 0.375rem = 6px on the inline-start side. Under LTR that is LEFT.
  expect(ltr.marginLeft).toBe('6px');
  expect(ltr.marginRight).toBe('0px');
  // No RTL ancestor → no horizontal flip on the directional glyph.
  expect(ltr.scale).toBe('none');

  // Force RTL at runtime; CSS recalculates logical props + the rtl: variant.
  await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));

  const rtl = await probe(page);
  // The SAME inline-start margin now resolves to the physical RIGHT side.
  expect(rtl.marginLeft).toBe('0px');
  expect(rtl.marginRight).toBe('6px');
  // The directional glyph is now horizontally mirrored (negative x-scale).
  expect(rtl.scale).not.toBe('none');
  expect(parseScaleX(rtl.scale)).toBeLessThan(0);
}

test.describe('RTL readiness (AECI-153)', () => {
  test('logical utilities flip under dir="rtl"', async ({ page }) => {
    await assertFlips(page);
  });
});

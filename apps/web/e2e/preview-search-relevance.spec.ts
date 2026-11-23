import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// AECI-286. The `/preview/search-relevance` lab (preview routes are 404'd on the
// public tiers — zero user-facing risk) ranks curated AEC fixtures under the
// candidate `customRanking` levers from `SEARCH_RANKING.md` §7. The pure
// ordering logic is exhaustively covered by `ranking-strategies.spec.ts`
// (plain Vitest); this spec covers the surface: SSR 200, the strategy toggle
// actually reordering the rendered results, the blend sliders, and axe.
//
// The reorder assertion uses the "estimating" preset because the unit spec
// pins its divergence: Baseline #1 = STACK, Coverage-weighted #1 = ProEst — so a
// changed top row is deterministic, not incidental. (Before AECI-636 PR-B the
// Baseline ranked on integration_count and diverged from Ratings-forward
// instead; it now ranks on listing_tier, which the fixtures do not carry.)

const PATH = '/preview/search-relevance';

// First data row of the signal/diff table; its row header is the product name.
const TOP_PRODUCT = 'tbody tr:first-child th[scope="row"]';

test.describe('preview search-relevance lab (AECI-286)', () => {
  // One page load for the three checks, in this order. The strategy step reads the
  // Baseline ranking before any other strategy is picked. The slider step starts with
  // Coverage-weighted selected, which shows no sliders either.
  test('the lab loads on Baseline, reorders by strategy, and shows the blend sliders', async ({
    page,
  }) => {
    const res = await page.goto(PATH);
    await test.step('returns 200 with Baseline selected over the default query', async () => {
      expect(res?.status(), `GET ${PATH} must return 200`).toBe(200);

      await expect(page.getByRole('heading', { name: /Search relevance lab/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Baseline (today)' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      // Fixtures render for the default query on both zones (cards + table).
      await expect(page.getByRole('status')).toContainText(/[1-9]\d* results?/);
      await expect(page.locator(TOP_PRODUCT)).toBeVisible();
    });

    await test.step('switching strategy reorders results and shows movement badges', async () => {
      await page.getByRole('button', { name: 'estimating', exact: true }).click();
      const baselineTop = await page.locator(TOP_PRODUCT).innerText();

      await page.getByRole('button', { name: 'Coverage-weighted' }).click();
      await expect(page.getByRole('button', { name: 'Coverage-weighted' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      // Divergent by fixture design (see header comment): the top result changes,
      // and at least one movement badge (▲/▼) appears vs Baseline.
      await expect(page.locator(TOP_PRODUCT)).not.toHaveText(baselineTop);
      await expect(
        page
          .locator('tbody')
          .getByText(/[▲▼]\d/)
          .first(),
      ).toBeVisible();
    });

    await test.step('Balanced blend exposes the three weight sliders', async () => {
      await expect(page.locator('input[type="range"]')).toHaveCount(0);
      await page.getByRole('button', { name: 'Balanced blend' }).click();
      await expect(page.locator('input[type="range"]')).toHaveCount(3);
      await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible();
    });
  });

  test('surface has zero axe violations', async ({ page }) => {
    await page.goto(PATH);
    await expect(page.locator(TOP_PRODUCT)).toBeVisible();
    const results = await new AxeBuilder({ page })
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

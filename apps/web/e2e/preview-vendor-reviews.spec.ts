import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The portal Reviews tab (AECI-1179, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.16), on
 * the ungated dev preview. `?fixture=` picks the plan preset on first paint:
 *
 *   - `verified` (default) — a Managed product, so Reply, Edit and Resubmit show;
 *   - `downgraded` — the same products on Free, so only Withdraw is left.
 *
 * Why the preview and not `/vendor/:slug`: see `preview-vendor-portal-nav.spec.ts`.
 * `vendor-dashboard.spec.ts` skips without `SUPABASE_VENDOR_TEST_USER_*`, which CI
 * does not set. The preview mounts the same tab against a fixture-backed fake that
 * runs the server's state machine, so "reply to one review end to end" runs here.
 */
const PATH = '/preview/vendor-dashboard/products/summit-model-coordination/reviews';

/** Keep acting until the effect is observable: a pre-hydration click is dropped. */
async function until(act: () => Promise<unknown>, settled: () => Promise<unknown>): Promise<void> {
  await expect(async () => {
    await act();
    await settled();
  }).toPass({ timeout: 15_000 });
}

async function axeSerious(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
}

const reviewRow = (page: Page, title: string): Locator =>
  page.locator('[data-review]').filter({ has: page.getByRole('heading', { name: title }) });

test.describe('vendor reviews tab (preview)', () => {
  test('lists every reply state', async ({ page }) => {
    const res = await page.goto(PATH);
    expect(res?.status()).toBe(200);

    const nav = page.getByRole('navigation', { name: 'Summit Model Coordination sections' });
    await expect(nav.getByRole('link', { name: 'Reviews' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.locator('[data-review]')).toHaveCount(6);
    for (const state of ['none', 'pending', 'published', 'rejected', 'withdrawn', 'removed']) {
      await expect(page.locator(`[data-reply-state="${state}"]`)).toHaveCount(1);
    }
    await expect(page.locator('[data-reply-reason]')).toHaveCount(2);
    expect(await axeSerious(page)).toEqual([]);
  });

  test('replies to one review end to end', async ({ page }) => {
    await page.goto(PATH);
    const row = reviewRow(page, 'Clash runs are fast, but the issue export drops comments');
    const reply = row.getByRole('button', { name: /^Reply/ });

    await until(
      () => reply.click(),
      () => expect(row.getByRole('textbox')).toBeVisible({ timeout: 1_000 }),
    );
    await expect(row.getByRole('textbox')).toBeFocused();
    expect(await axeSerious(page)).toEqual([]);

    await row
      .getByRole('textbox')
      .fill('Thanks. Release 4.3 keeps threaded comments in the export.');
    await row.getByRole('button', { name: 'Send for approval' }).click();

    await expect(row).toHaveAttribute('data-reply-state', 'pending');
    await expect(row.locator('[data-reply-pill]')).toHaveText('Pending approval');
    await expect(row.locator('[data-own-body]')).toContainText('Release 4.3');
  });

  test('warns before editing a published reply', async ({ page }) => {
    await page.goto(PATH);
    const row = reviewRow(page, 'The best clash tool we have used');
    await until(
      () => row.getByRole('button', { name: /^Edit/ }).click(),
      () => expect(row.locator('[data-reply-warning]')).toBeVisible({ timeout: 1_000 }),
    );
    await expect(row.locator('[data-reply-warning]')).toContainText('off the product page');
    expect(await axeSerious(page)).toEqual([]);
  });

  test('a Free product keeps the list and Withdraw, and says why it cannot reply', async ({
    page,
  }) => {
    await page.goto(`${PATH}?fixture=downgraded`);
    await expect(page.locator('[data-reviews-locked]')).toContainText('part of Managed');
    await expect(page.locator('[data-review]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Reply|Edit|Resubmit)/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Withdraw/ })).toHaveCount(2);
    expect(await axeSerious(page)).toEqual([]);
  });
});

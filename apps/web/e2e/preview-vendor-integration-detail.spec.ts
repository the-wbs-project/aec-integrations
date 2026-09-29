import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The integration detail page (AECI-1149 to AECI-1153,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17), driven on the ungated dev preview.
 *
 * Here and not in `vendor-dashboard.spec.ts` for the reason
 * `preview-vendor-portal-nav.spec.ts` gives: that spec skips without a vendor
 * session, and `/preview/vendor-dashboard` mounts the same shell and routes over a
 * fixture-backed API, so this file actually runs in CI.
 *
 * Covers: a list row opens its page; a deep link with a fragment lands on the
 * section; the section nav is native anchors that move focus; "Things that need
 * you" jumps into Change requests; a Yes saves and announces; the No reason form;
 * an unknown id is not found; and axe (serious and critical) on the page with a
 * form open.
 */
const LIST = '/preview/vendor-dashboard/products/summit-model-coordination/integrations';
const PROCORE = '00000000-0000-4000-8000-000000005310';
const OWNED = '00000000-0000-4000-8000-00000000531c';
const ANNOUNCER = '[role="status"].sr-only';

/** Click until the state it should produce is observable: a click between SSR
 *  paint and hydration is dropped (see `preview-vendor-portal-nav.spec.ts`). */
async function clickUntil(target: Locator, settled: () => Promise<unknown>): Promise<void> {
  await expect(async () => {
    await target.click();
    await settled();
  }).toPass({ timeout: 15_000 });
}

async function axeSerious(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('[aria-label="Concept switcher (dev only)"]')
    .analyze();
  return result.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

async function openPage(page: Page, id: string, hash = ''): Promise<void> {
  await page.goto(`${LIST}/${id}${hash}`);
  await expect(page.getByTestId('integration-title')).toBeVisible();
}

test.describe('integration detail page (preview)', () => {
  test('a list row opens the integration’s page', async ({ page }) => {
    await page.goto(LIST);
    const row = page.getByTestId(`integration-row-${PROCORE}`);
    await clickUntil(row, () =>
      expect(page).toHaveURL(new RegExp(`/integrations/${PROCORE}$`), { timeout: 1_000 }),
    );
    await expect(page.getByTestId('integration-title')).toHaveText(
      'Summit Model Coordination and Procore',
    );
    await expect(page.getByTestId('integration-status')).toContainText('Disagreement open');
    // The shell keeps its product context: the h1 is the product.
    await expect(page.locator('h1')).toHaveText('Summit Model Coordination');
  });

  test('a deep link with a fragment lands on the section', async ({ page }) => {
    await openPage(page, PROCORE, '#change-requests');
    await expect(page.locator('#change-requests')).toBeInViewport();
  });

  test('the section nav is native anchors that move focus to the heading', async ({ page }) => {
    await openPage(page, PROCORE);
    const nav = page.getByRole('navigation', { name: 'Integration sections' });
    await expect(nav.getByRole('link')).toHaveCount(5);
    await expect(nav.getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'location',
    );
    const settings = nav.getByRole('link', { name: 'Settings' });
    await expect(settings).toHaveAttribute(
      'href',
      new RegExp(`/integrations/${PROCORE}#settings$`),
    );
    await clickUntil(settings, () =>
      expect(page.locator('#settings-heading')).toBeFocused({ timeout: 1_000 }),
    );
    await expect(page).toHaveURL(/#settings$/);
    await expect(page.getByTestId('integration-sticky-bar')).toBeVisible();
  });

  test('"Things that need you" jumps to the item it names', async ({ page }) => {
    await openPage(page, PROCORE);
    const item = page
      .getByTestId('integration-needs')
      .getByRole('button', { name: /added Documents/ });
    await clickUntil(item, () =>
      expect(page.locator('[id^="added-"]:focus')).toHaveCount(1, { timeout: 1_000 }),
    );
  });

  test('Yes saves at once and announces; No asks for a reason', async ({ page }) => {
    await openPage(page, PROCORE);
    const yes = page.getByTestId('yes-models');
    await clickUntil(yes, () =>
      expect(yes).toHaveAttribute('aria-pressed', 'true', { timeout: 1_000 }),
    );
    await expect(page.locator(ANNOUNCER)).toContainText('Models: you said this is right.');

    await page.getByTestId('no-documents').click();
    await expect(page.getByTestId('answer-form')).toBeVisible();
    await page.getByTestId('answer-save').click();
    await expect(page.getByTestId('answer-form').getByRole('alert')).toContainText('Give a reason');
    expect(await axeSerious(page), 'page with the reason form open').toEqual([]);
  });

  test('the owner’s page is axe clean with an editor and the request form open', async ({
    page,
  }) => {
    await openPage(page, OWNED);
    await clickUntil(page.getByTestId('edit-maturity'), () =>
      expect(page.getByTestId('overview-row-maturity').locator('input')).toBeVisible({
        timeout: 1_000,
      }),
    );
    expect(await axeSerious(page), 'owner page with an editor open').toEqual([]);
  });

  test('a non-owner can open the request form from a row', async ({ page }) => {
    await openPage(page, PROCORE);
    await clickUntil(page.getByTestId('request-description'), () =>
      expect(page.getByTestId('request-form')).toBeVisible({ timeout: 1_000 }),
    );
    await expect(page.locator('#request-field')).toHaveValue('description');
    expect(await axeSerious(page), 'page with the request form open').toEqual([]);
  });

  test('an unknown id is not found, with a way back', async ({ page }) => {
    await page.goto(`${LIST}/00000000-0000-4000-8000-00000000dead`);
    await expect(page.getByTestId('integration-not-found')).toBeVisible();
    await expect(page.getByRole('link', { name: /integrations$/ }).last()).toHaveAttribute(
      'href',
      new RegExp(`${LIST}$`),
    );
  });
});

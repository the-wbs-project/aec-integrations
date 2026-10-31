import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * A private row thread's permanent page and the Conversations list (AECI-1551,
 * `STAGE_2_ATTESTATIONS_SPEC.md` §15.11), driven on the ungated dev preview for the
 * reason `preview-vendor-integration-detail.spec.ts` gives: `/preview/vendor-dashboard`
 * mounts the same shell and routes over a fixture-backed API, so this runs in CI.
 *
 * Covers: the nav reaches the list; the list links a row to its page; the page of a
 * live thread is writable (composer, help ask, delete) and posts; the page of a
 * thread whose row was deleted is read-only; an unknown id says "not found"; and axe
 * (serious and critical) on each.
 */
const BASE = '/preview/vendor-dashboard';
const LIVE_THREAD = '00000000-0000-4000-8000-0000000a9001';
const DETACHED_THREAD = '00000000-0000-4000-8000-0000000a9002';

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

test.describe('private row threads (preview, AECI-1551)', () => {
  test('the portal nav reaches the Conversations list, and a row opens its thread', async ({
    page,
  }) => {
    await page.goto(`${BASE}/overview`);
    const link = page.getByRole('link', { name: 'Conversations' });
    await clickUntil(link, () => expect(page).toHaveURL(/\/threads$/, { timeout: 1_000 }));
    const row = page.locator(`[data-thread-row="${LIVE_THREAD}"]`);
    await expect(row).toContainText('Conversation with Procore Technologies about Drawings');
    await expect(row.locator('[data-thread-state]')).toHaveText('Open');
    await expect(page.locator(`[data-thread-row="${DETACHED_THREAD}"]`)).toContainText('Closed');
    expect(await axeSerious(page), 'the Conversations list').toEqual([]);
    await clickUntil(row.getByRole('link'), () =>
      expect(page).toHaveURL(new RegExp(`/threads/${LIVE_THREAD}$`), { timeout: 1_000 }),
    );
    await expect(page.getByTestId('thread-page-title')).toContainText(
      'Conversation about Drawings',
    );
  });

  test('a live thread’s page is writable and posts through the claim route', async ({ page }) => {
    await page.goto(`${BASE}/threads/${LIVE_THREAD}`);
    const box = page.getByTestId('thread-composer');
    await expect(box).toBeVisible();
    await expect(page.getByTestId('thread-help')).toBeVisible();
    expect(await axeSerious(page), 'a writable thread page').toEqual([]);
    await expect(async () => {
      await box.fill('Posted from the thread page');
      await expect(page.getByTestId('thread-send')).toBeEnabled({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await page.getByTestId('thread-send').click();
    await expect(page.getByText('Posted from the thread page')).toBeVisible();
    await expect(box).toHaveValue('');
  });

  test('the page of a thread whose row was deleted is read-only', async ({ page }) => {
    await page.goto(`${BASE}/threads/${DETACHED_THREAD}`);
    await expect(page.getByTestId('thread-closed')).toContainText(
      'closed when this row was removed from the directory',
    );
    await expect(page.getByTestId('thread-composer')).toHaveCount(0);
    await expect(page.getByTestId('thread-help')).toHaveCount(0);
    expect(await axeSerious(page), 'a read-only thread page').toEqual([]);
  });

  test('an unknown thread id says it was not found, with no retry', async ({ page }) => {
    await page.goto(`${BASE}/threads/00000000-0000-4000-8000-00000000dead`);
    await expect(page.getByTestId('thread-missing')).toBeVisible();
    await expect(page.getByTestId('thread-page-title')).toHaveText('Conversation not found');
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    expect(await axeSerious(page), 'a not-found thread page').toEqual([]);
  });
});

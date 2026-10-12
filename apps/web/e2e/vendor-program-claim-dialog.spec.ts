/**
 * AECI-1293: the claim dialog end to end (`docs/VENDOR_PROGRAM_PAGE_SPEC.md` §15).
 *
 * Both paths against a mocked search index and mocked submit endpoints, so nothing
 * leaves the machine and no row is written: a found listing sends
 * `POST /api/requests/claim` with the plan answer and the comments, a typed-in listing
 * sends `POST /api/requests/listing`. Then the dialog's own behaviour (Escape, focus,
 * the full-screen sheet below `sm`) and axe with the dialog open at 375 and 1280.
 *
 * Set `CLAIM_DIALOG_SHOTS` to a directory to save a screenshot of each step at both
 * widths (the design record for the issue). Unset, no file is written.
 */
import { join } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';

import { waitForHydrationSettle } from './console-capture';

const SHOTS = process.env['CLAIM_DIALOG_SHOTS'];

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  const width = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: join(SHOTS, `claim-dialog-${name}-${width}.png`) });
}

/** A stand-in public search config and a fixed answer: "Proc…" finds one product. */
async function mockSearch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __AECI_ALGOLIA__: unknown }).__AECI_ALGOLIA__ = {
      appId: 'E2ETEST',
      searchKey: 'e2e',
      indexes: { products: 'products', vendors: 'vendors', integrations: 'integrations' },
    };
  });
  await page.route('**/1/indexes/*/queries**', async (route) => {
    const body = route.request().postDataJSON() as { requests: { query?: string }[] };
    const query = body.requests[0]?.query ?? '';
    const hit = query.toLowerCase().startsWith('proc');
    const product = {
      objectID: 'p1',
      name: 'Procore',
      slug: 'fixture-procore',
      vendor_name: 'Procore Technologies',
    };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          { hits: hit ? [product] : [], nbHits: hit ? 1 : 0, query, params: '', index: 'products' },
          { hits: [], nbHits: 0, query, params: '', index: 'vendors' },
        ],
      }),
    });
  });
}

/** Answers both submit endpoints with a 201 and records what was sent. */
async function mockSubmits(page: Page): Promise<{ claim: unknown[]; listing: unknown[] }> {
  const sent = { claim: [] as unknown[], listing: [] as unknown[] };
  for (const kind of ['claim', 'listing'] as const) {
    await page.route(`**/api/requests/${kind}`, async (route) => {
      sent[kind].push(route.request().postDataJSON());
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          request_id: '11111111-2222-4333-8444-555555555555',
          message: 'ok',
        }),
      });
    });
  }
  return sent;
}

async function openFromManagedCard(page: Page) {
  const start = page.locator('aec-plan-cards').getByRole('link', { name: 'Start with Managed' });
  const dialog = page.getByRole('dialog', { name: 'Claim your listing' });
  // The first click can land before hydration finishes; retry until the dialog opens.
  await expect(async () => {
    await start.click();
    await expect(dialog).toBeVisible({ timeout: 2000 });
  }).toPass();
  return dialog;
}

async function fillYou(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Your name').fill('Dana Reyes');
  await dialog.getByLabel('Your role at the company').fill('Head of Partnerships');
  await dialog.getByLabel('Your work email').fill('dana@procore.example');
}

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

test.describe('/vendor-program claim dialog (AECI-1293)', () => {
  for (const width of [375, 1280]) {
    test(`found listing: search, you, plan preselected from the Managed card, comments, receipt at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 375 ? 740 : 900 });
      await mockSearch(page);
      const sent = await mockSubmits(page);
      await page.goto('/vendor-program');
      await waitForHydrationSettle(page);

      const dialog = await openFromManagedCard(page);
      await expect(dialog.getByRole('heading', { name: 'Find your listing' })).toBeVisible();
      await expect(dialog).toContainText('Step 1 of 4');
      expect((await axe(page)).violations).toEqual([]);
      await shot(page, '1-find');

      // Below sm the panel fills the screen.
      if (width === 375) {
        const box = await page.getByTestId('claim-dialog').boundingBox();
        expect(box?.width).toBe(375);
      }

      await dialog.getByLabel('Your product or company').fill('Proc');
      await page.getByRole('option', { name: /Procore/ }).click();
      await expect(dialog.getByRole('heading', { name: 'About you' })).toBeFocused();
      await expect(dialog.getByTestId('claim-dialog-listing')).toContainText('Procore');

      // Continue with nothing filled stays, and names the first bad field.
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await expect(dialog.getByLabel('Your name')).toBeFocused();
      await expect(dialog.getByText('Your name is required.')).toBeVisible();
      await fillYou(page);
      expect((await axe(page)).violations).toEqual([]);
      await shot(page, '2-you');
      await dialog.getByRole('button', { name: 'Continue' }).click();

      await expect(dialog.getByRole('heading', { name: 'Your plan' })).toBeFocused();
      await expect(dialog.getByRole('radio', { name: 'Managed' })).toBeChecked();
      expect((await axe(page)).violations).toEqual([]);
      await shot(page, '3-plan');
      await dialog.getByRole('button', { name: 'Continue' }).click();

      await dialog.getByLabel('Additional comments').fill('We make four products.');
      expect((await axe(page)).violations).toEqual([]);
      await shot(page, '4-comments');
      await dialog.getByRole('button', { name: 'Send claim' }).click();

      await expect(dialog.getByRole('heading', { name: 'Claim sent' })).toBeFocused();
      await expect(dialog).toContainText('dana@procore.example');
      expect((await axe(page)).violations).toEqual([]);
      await shot(page, '5-done');
      expect(sent.claim).toEqual([
        {
          submitter_name: 'Dana Reyes',
          submitter_email: 'dana@procore.example',
          submitter_role: 'Head of Partnerships',
          submitter_linkedin_url: '',
          plan_interest: 'managed',
          body: 'We make four products.',
          target_type: 'product',
          slug: 'fixture-procore',
        },
      ]);
      expect(sent.listing).toEqual([]);

      await dialog.getByRole('button', { name: 'Done' }).click();
      await expect(dialog).toBeHidden();
    });
  }

  test('typed-in listing: "Not listed? Type it in" sends a listing request', async ({ page }) => {
    await mockSearch(page);
    const sent = await mockSubmits(page);
    await page.goto('/vendor-program');
    await waitForHydrationSettle(page);

    const dialog = await openFromManagedCard(page);
    await dialog.getByRole('button', { name: 'Type it in' }).click();
    await dialog.getByLabel('Product or company name').fill('Site Diary Pro');
    await dialog.getByLabel('Website').fill('https://sitediary.example.com');
    await fillYou(page);
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: width === 375 ? 740 : 900 });
      await shot(page, '2-typed');
    }
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await dialog.getByRole('radio', { name: 'Not sure yet' }).check();
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await dialog.getByRole('button', { name: 'Send request' }).click();

    await expect(dialog.getByRole('heading', { name: 'Request sent' })).toBeVisible();
    await expect(dialog).toContainText(
      "We'll add Site Diary Pro to the directory, then email dana@procore.example so you can finish your claim.",
    );
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: width === 375 ? 740 : 900 });
      await shot(page, '5-typed-done');
    }
    expect(sent.listing).toEqual([
      {
        submitter_name: 'Dana Reyes',
        submitter_email: 'dana@procore.example',
        submitter_role: 'Head of Partnerships',
        submitter_linkedin_url: '',
        plan_interest: 'not_sure',
        body: '',
        listing_name: 'Site Diary Pro',
        website: 'https://sitediary.example.com',
      },
    ]);
    expect(sent.claim).toEqual([]);
  });

  test('Back, Escape and focus return', async ({ page }) => {
    await mockSearch(page);
    await page.goto('/vendor-program');
    await waitForHydrationSettle(page);

    const dialog = await openFromManagedCard(page);
    await dialog.getByRole('button', { name: 'Type it in' }).click();
    await expect(dialog.getByRole('button', { name: 'Back' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Back' }).click();
    await expect(dialog.getByRole('heading', { name: 'Find your listing' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(
      page.locator('aec-plan-cards').getByRole('link', { name: 'Start with Managed' }),
    ).toBeFocused();
  });

  test('the pricing link opens the inquiry dialog, not the claim dialog', async ({ page }) => {
    await page.goto('/vendor-program');
    await waitForHydrationSettle(page);
    const pricing = page.locator('aec-plan-cards').getByRole('link', { name: 'Talk to us' });
    await expect(pricing).toHaveAttribute('href', '/contact?topic=managed');
    await expect(async () => {
      await pricing.click();
      await expect(page.getByRole('dialog', { name: 'Talk to us about Managed' })).toBeVisible({
        timeout: 2000,
      });
    }).toPass();
  });
});

test.describe('/docs/vendors/plans claim dialog (AECI-1293)', () => {
  test('the docs Plans page opens the same dialog from its cards', async ({ page }) => {
    await page.goto('/docs/vendors/plans');
    await waitForHydrationSettle(page);
    const claim = page.locator('aec-plan-cards').getByRole('link', { name: 'Claim your listing' });
    await expect(claim).toHaveAttribute('href', '/search');
    const dialog = page.getByRole('dialog', { name: 'Claim your listing' });
    await expect(async () => {
      await claim.click();
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass();
    await dialog.getByRole('button', { name: 'Type it in' }).click();
    await fillYou(page);
    await dialog.getByLabel('Product or company name').fill('X');
    await dialog.getByLabel('Website').fill('https://x.example.com');
    await dialog.getByRole('button', { name: 'Continue' }).click();
    // Opened from the Free card: Free is preselected.
    await expect(dialog.getByRole('radio', { name: 'Free' })).toBeChecked();
  });
});

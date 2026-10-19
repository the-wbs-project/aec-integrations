/**
 * AECI-1293: the claim dialog end to end (`docs/VENDOR_PROGRAM_PAGE_SPEC.md` §15).
 *
 * Both paths against a mocked search index and mocked submit endpoints, so nothing
 * leaves the machine and no row is written: a found listing sends
 * `POST /api/requests/claim` with the comments, a typed-in listing sends
 * `POST /api/requests/listing`. Three steps since AECI-1365 removed the plan step, and
 * neither body carries a plan answer. AECI-1366: the vendor terms box is required on the
 * You step and both bodies carry `accepted_terms: true`. The claim-target lookup is
 * mocked too, and a company with an owner seat shows the routed notice and receipt.
 * Then the dialog's own behaviour (Escape, focus,
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

/** Answers both submit endpoints with a 201 and records what was sent. Also answers the
 *  claim-target lookup (AECI-1368): the company has an owner seat when `hasSeats`. */
async function mockSubmits(
  page: Page,
  hasSeats = false,
): Promise<{ claim: unknown[]; listing: unknown[] }> {
  const sent = { claim: [] as unknown[], listing: [] as unknown[] };
  await page.route('**/api/requests/claim-target/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        vendor_id: '99999999-2222-4333-8444-555555555555',
        has_seats: hasSeats,
      }),
    });
  });
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
  // AECI-1364: the dialog's name changes to "Claim <Company>" once a listing is
  // chosen, so it is located by role and its name asserted separately.
  const dialog = page.getByRole('dialog');
  // The first click can land before hydration finishes; retry until the dialog opens.
  await expect(async () => {
    await start.click();
    await expect(dialog).toBeVisible({ timeout: 2000 });
  }).toPass();
  await expect(dialog).toHaveAccessibleName('Claim your company');
  return dialog;
}

/** The vendor terms box (AECI-1366). */
const termsBox = (page: Page) =>
  page.getByRole('dialog').getByRole('checkbox', { name: /I represent this company/ });

/** The You step's fields, and the vendor terms box unless `terms` is false. */
async function fillYou(page: Page, terms = true) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Your name').fill('Dana Reyes');
  await dialog.getByLabel('Your role at the company').fill('Head of Partnerships');
  await dialog.getByLabel('Your work email').fill('dana@procore.example');
  if (terms) await termsBox(page).check();
}

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

test.describe('/vendor-program claim dialog (AECI-1293)', () => {
  for (const width of [375, 1280]) {
    test(`found listing: search, you, comments, receipt at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 740 : 900 });
      await mockSearch(page);
      const sent = await mockSubmits(page);
      await page.goto('/vendor-program');
      await waitForHydrationSettle(page);

      const dialog = await openFromManagedCard(page);
      await expect(dialog.getByRole('heading', { name: 'Find your listing' })).toBeVisible();
      await expect(dialog).toContainText('Step 1 of 3');
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
      // AECI-1364: a product hit names its company (the record's vendor_name) and the
      // product page, and the dialog is titled for the company.
      await expect(dialog.getByTestId('claim-dialog-listing')).toContainText(
        'Claiming Procore Technologies from the Procore page',
      );
      await expect(dialog).toHaveAccessibleName('Claim Procore Technologies');

      // Continue with nothing filled stays, and names the first bad field.
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await expect(dialog.getByLabel('Your name')).toBeFocused();
      await expect(dialog.getByText('Your name is required.')).toBeVisible();
      // AECI-1366: the vendor terms box is required, and its error is tied to it.
      await fillYou(page, false);
      await expect(dialog.getByTestId('claim-routed-notice')).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await expect(termsBox(page)).toBeFocused();
      await expect(termsBox(page)).toHaveAttribute('aria-describedby', 'claim-dialog-terms-error');
      await expect(dialog.locator('#claim-dialog-terms-error')).toBeVisible();
      await expect(dialog.getByRole('link', { name: /vendor terms/ })).toHaveAttribute(
        'href',
        '/legal/vendor-terms',
      );
      await termsBox(page).check();
      expect((await axe(page)).violations).toEqual([]);
      await shot(page, '2-you');
      await dialog.getByRole('button', { name: 'Continue' }).click();

      // AECI-1365: no plan step. "About you" goes straight to the comments.
      await expect(dialog.getByRole('heading', { name: 'Anything to add?' })).toBeFocused();
      await expect(dialog).toContainText('Step 3 of 3');
      await expect(dialog.getByRole('radio')).toHaveCount(0);
      await dialog.getByLabel('Additional comments').fill('We make four products.');
      expect((await axe(page)).violations).toEqual([]);
      await shot(page, '3-comments');
      await dialog.getByRole('button', { name: 'Send claim' }).click();

      await expect(dialog.getByRole('heading', { name: 'Claim sent' })).toBeFocused();
      await expect(dialog).toContainText("We've emailed a receipt to dana@procore.example.");
      expect((await axe(page)).violations).toEqual([]);
      await shot(page, '4-done');
      expect(sent.claim).toEqual([
        {
          submitter_name: 'Dana Reyes',
          submitter_email: 'dana@procore.example',
          submitter_role: 'Head of Partnerships',
          submitter_linkedin_url: '',
          body: 'We make four products.',
          accepted_terms: true,
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
    await dialog.getByRole('button', { name: 'Send request' }).click();

    await expect(dialog.getByRole('heading', { name: 'Request sent' })).toBeVisible();
    await expect(dialog).toContainText(
      "We've emailed a receipt to dana@procore.example. We'll add Site Diary Pro to the directory, then write to you there so you can finish your claim.",
    );
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: width === 375 ? 740 : 900 });
      await shot(page, '4-typed-done');
    }
    expect(sent.listing).toEqual([
      {
        submitter_name: 'Dana Reyes',
        submitter_email: 'dana@procore.example',
        submitter_role: 'Head of Partnerships',
        submitter_linkedin_url: '',
        body: '',
        accepted_terms: true,
        listing_name: 'Site Diary Pro',
        website: 'https://sitediary.example.com',
      },
    ]);
    expect(sent.claim).toEqual([]);
  });

  test('a company with an owner seat: the routed notice, then the routed receipt (AECI-1366)', async ({
    page,
  }) => {
    await mockSearch(page);
    const sent = await mockSubmits(page, true);
    await page.goto('/vendor-program');
    await waitForHydrationSettle(page);

    const dialog = await openFromManagedCard(page);
    await dialog.getByLabel('Your product or company').fill('Proc');
    await page.getByRole('option', { name: /Procore/ }).click();
    await expect(dialog.getByTestId('claim-routed-notice')).toHaveText(
      'Procore Technologies already maintains this listing. Send your request and their team will confirm you. We step in if they do not answer within 7 days.',
    );
    await fillYou(page);
    expect((await axe(page)).violations).toEqual([]);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await dialog.getByRole('button', { name: 'Send claim' }).click();

    await expect(dialog.getByRole('heading', { name: 'Claim sent' })).toBeVisible();
    await expect(dialog.getByTestId('claim-dialog-sent-routed')).toHaveText(
      'The team at Procore Technologies has been asked to confirm you.',
    );
    await expect(dialog).toContainText('If they accept, you get an invitation email to join.');
    await expect(dialog).toContainText(
      'If nobody answers within 7 days, we review your claim and write to you.',
    );
    await expect(dialog).not.toContainText('with our decision');
    expect(sent.claim).toHaveLength(1);
    expect(sent.claim[0]).toMatchObject({ accepted_terms: true });
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

  // E8.1 (2026-10-19): the plan inquiry dialog is gone. "Questions? Contact us" is a
  // plain link to /contact, with no topic, and opens no dialog.
  test('the contact link goes to /contact', async ({ page }) => {
    await page.goto('/vendor-program');
    await waitForHydrationSettle(page);
    const contact = page.locator('aec-plan-cta-panel').getByRole('link', { name: 'Contact us' });
    await expect(contact).toHaveAttribute('href', '/contact');
    await expect(async () => {
      await contact.click();
      await expect(page).toHaveURL(/\/contact$/, { timeout: 2000 });
    }).toPass();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('/docs/vendors/plans claim dialog (AECI-1293)', () => {
  test('the docs Plans page opens the same dialog from its cards', async ({ page }) => {
    await page.goto('/docs/vendors/plans');
    await waitForHydrationSettle(page);
    const claim = page.locator('aec-plan-cards').getByRole('link', { name: 'Claim your listing' });
    await expect(claim).toHaveAttribute('href', '/search');
    const dialog = page.getByRole('dialog', { name: 'Claim your company' });
    await expect(async () => {
      await claim.click();
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass();
    await dialog.getByRole('button', { name: 'Type it in' }).click();
    await fillYou(page);
    await dialog.getByLabel('Product or company name').fill('X');
    await dialog.getByLabel('Website').fill('https://x.example.com');
    await dialog.getByRole('button', { name: 'Continue' }).click();
    // AECI-1365 removed the plan step: the You step goes straight to the comments.
    await expect(dialog.getByRole('heading', { name: 'Anything to add?' })).toBeVisible();
  });
});

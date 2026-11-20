/**
 * AECI-1720: what a visitor types or ticks before hydration survives into the form.
 *
 * The claim pages are server-rendered and cached, so a visitor on a slow phone can
 * fill the form and tick the Vendor Terms box before the scripts load. Hydration
 * wrote the model's empty starting values over every `[formField]` control: the box
 * unticked itself, the answers emptied, and the submit stayed disabled. The inline
 * recorder in `src/index.html` keeps the visitor's own values and `AecEarlyInput`
 * (`shared/form-field/early-input.ts`) puts them back once the field is live.
 *
 * Each test holds the app's entry bundle, acts on the server-rendered HTML, then
 * releases the bundle and checks the form once it is hydrated. Every request is
 * routed: the page's own same-origin GETs pass, other origins are aborted, the one
 * write each test makes is answered here, and any other write fails the test.
 */
import { expect, test, type Page } from '@playwright/test';

import { untilHydrated } from './hydration';

const CLAIM_PAGES = [
  { name: 'product claim', path: '/products/fixture-procore/claim' },
  { name: 'vendor claim', path: '/vendors/fixture-procore-technologies/claim' },
] as const;

const CLAIM_FORM = '[data-testid="page-canvas"] form';
const CLAIM_SUBMIT = `${CLAIM_FORM} button[type="submit"]`;

interface Guard {
  /** Bodies of the writes this test allows, answered with a stub. */
  readonly sent: { path: string; body: Record<string, unknown> }[];
  /** Anything else: a write nobody allowed, or a request to another origin. */
  readonly unexpected: string[];
  release(): void;
}

/** Hold the entry bundle until `release()`, and route every request. */
async function holdScripts(page: Page, origin: string, allowWrite: string): Promise<Guard> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const sent: Guard['sent'] = [];
  const unexpected: string[] = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) {
      unexpected.push(`${req.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (req.method() !== 'GET' && req.method() !== 'HEAD') {
      if (url.pathname === allowWrite) {
        sent.push({ path: url.pathname, body: req.postDataJSON() });
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            request_id: '00000000-0000-4000-8000-000000000001',
            message: 'ok',
            confirmation_required: false,
          }),
        });
      }
      unexpected.push(`${req.method()} ${url.pathname}`);
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    }
    if (/\/main-[^/]+\.js$/.test(url.pathname)) await held;
    return route.continue();
  });
  return { sent, unexpected, release };
}

/** Open the page with the scripts held, and check it is not hydrated yet. */
async function openHeld(page: Page, path: string, form: string): Promise<void> {
  await page.goto(path, { waitUntil: 'commit' });
  await expect(page.locator(form), 'the form is server-rendered').toBeVisible();
  await expect(page.locator(form), 'not hydrated yet').toHaveAttribute('jsaction', /submit/);
}

/** Release the bundle and wait until the form's listeners are live. */
async function hydrate(page: Page, guard: Guard, form: string): Promise<void> {
  guard.release();
  await untilHydrated(page.locator(form));
}

const ANSWERS = {
  '#claim-name': 'Jane Example',
  '#claim-title': 'Product manager',
  '#claim-email': 'jane@procore.com',
  '#claim-legal-name': 'Procore Technologies, Inc.',
} as const;

test.describe('early input survives hydration (AECI-1720)', () => {
  for (const r of CLAIM_PAGES) {
    test(`${r.name}: an early tick and early answers reach the form and the claim`, async ({
      page,
      baseURL,
    }) => {
      const guard = await holdScripts(page, new URL(baseURL!).origin, '/api/requests/claim');
      await openHeld(page, r.path, CLAIM_FORM);

      for (const [id, value] of Object.entries(ANSWERS)) await page.locator(id).fill(value);
      await page.locator('#claim-terms').check();
      await expect(page.locator(CLAIM_SUBMIT), 'the SSR submit waits for the app').toBeDisabled();

      await hydrate(page, guard, CLAIM_FORM);

      await expect(page.locator('#claim-terms')).toBeChecked();
      for (const [id, value] of Object.entries(ANSWERS)) {
        await expect(page.locator(id)).toHaveValue(value);
        await expect(page.locator(id)).not.toHaveAttribute('aria-invalid', 'true');
      }
      await expect(page.locator('#claim-terms')).not.toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator(CLAIM_SUBMIT), 'the tick reached the form').toBeEnabled();

      await page.locator(CLAIM_SUBMIT).click();
      await expect(page.locator('h1')).toContainText(/sent/i);
      expect(guard.sent).toHaveLength(1);
      expect(guard.sent[0].body).toMatchObject({
        submitter_name: ANSWERS['#claim-name'],
        submitter_title: ANSWERS['#claim-title'],
        submitter_email: ANSWERS['#claim-email'],
        company_legal_name: ANSWERS['#claim-legal-name'],
        accepted_terms: true,
      });
      expect(guard.unexpected).toEqual([]);
    });

    test(`${r.name}: a tick a script made is not carried, and a cleared answer stays clear`, async ({
      page,
      baseURL,
    }) => {
      const guard = await holdScripts(page, new URL(baseURL!).origin, '/api/requests/claim');
      await openHeld(page, r.path, CLAIM_FORM);

      // A script ticks the box and fires the events a click would. They are not trusted.
      await page.locator('#claim-terms').evaluate((box: HTMLInputElement) => {
        box.checked = true;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
      });
      // The visitor types an answer and clears it again: the empty value is theirs.
      await page.locator('#claim-name').fill('Jane');
      await page.locator('#claim-name').fill('');

      await hydrate(page, guard, CLAIM_FORM);

      await expect(page.locator('#claim-terms'), 'no tick without the visitor').not.toBeChecked();
      await expect(page.locator(CLAIM_SUBMIT), 'the box still gates the submit').toBeDisabled();
      await expect(page.locator('#claim-name')).toHaveValue('');

      expect(guard.sent).toEqual([]);
      expect(guard.unexpected).toEqual([]);
    });
  }

  test('product claim: ticked and unticked before hydration stays unticked', async ({
    page,
    baseURL,
  }) => {
    const guard = await holdScripts(page, new URL(baseURL!).origin, '/api/requests/claim');
    await openHeld(page, CLAIM_PAGES[0].path, CLAIM_FORM);
    await page.locator('#claim-terms').check();
    await page.locator('#claim-terms').uncheck();
    await hydrate(page, guard, CLAIM_FORM);
    await expect(page.locator('#claim-terms')).not.toBeChecked();
    await expect(page.locator(CLAIM_SUBMIT)).toBeDisabled();
    expect(guard.sent).toEqual([]);
    expect(guard.unexpected).toEqual([]);
  });

  test('/vendor-program/list-your-product: early answers survive and focus stays put', async ({
    page,
    baseURL,
  }) => {
    const form = 'form#claim-dialog-form';
    const guard = await holdScripts(page, new URL(baseURL!).origin, '/api/requests/listing');
    await openHeld(page, '/vendor-program/list-your-product', form);

    const early = {
      '#claim-dialog-listing-name': 'Fixture Planner',
      '#claim-dialog-website': 'https://planner.example.com',
      '#claim-dialog-name': 'Jane Example',
    } as const;
    for (const [id, value] of Object.entries(early)) await page.locator(id).fill(value);

    await hydrate(page, guard, form);

    for (const [id, value] of Object.entries(early)) {
      await expect(page.locator(id)).toHaveValue(value);
    }
    await expect(page.locator('#claim-dialog-name'), 'focus stays in the field').toBeFocused();
    await expect(page.locator('#claim-dialog-name')).not.toHaveAttribute('aria-invalid', 'true');

    // Continue checks the step: the early answers count, the empty fields do not.
    await page.getByTestId('claim-dialog-primary').click();
    for (const id of Object.keys(early)) {
      await expect(page.locator(id)).not.toHaveAttribute('aria-invalid', 'true');
    }
    await expect(page.locator('#claim-dialog-email')).toHaveAttribute('aria-invalid', 'true');
    expect(guard.sent).toEqual([]);
    expect(guard.unexpected).toEqual([]);
  });

  test('/products: an early address in the mailing list card reaches the subscribe', async ({
    page,
    baseURL,
  }) => {
    const form = '[data-testid="mailing-list-card"] form';
    const guard = await holdScripts(page, new URL(baseURL!).origin, '/api/subscribe');
    await openHeld(page, '/products', form);
    await page.locator('#mailing-list-email').fill('jane@procore.com');
    await hydrate(page, guard, form);
    await expect(page.locator('#mailing-list-email')).toHaveValue('jane@procore.com');
    await page.locator(`${form} button[type="submit"]`).click();
    await expect.poll(() => guard.sent.length).toBe(1);
    expect(guard.sent[0].body).toMatchObject({ email: 'jane@procore.com' });
    expect(guard.unexpected).toEqual([]);
  });

  test('/vendor-program: the claim dialog has no form before hydration, so nothing is lost', async ({
    page,
    baseURL,
  }) => {
    const guard = await holdScripts(page, new URL(baseURL!).origin, '/api/requests/claim');
    await page.goto('/vendor-program', { waitUntil: 'commit' });
    await expect(page.getByRole('link', { name: 'Claim your listing' }).first()).toBeVisible();
    await expect(page.locator('#claim-dialog-form, #claim-dialog-terms')).toHaveCount(0);
    guard.release();
    await untilHydrated(page.getByRole('link', { name: 'Claim your listing' }).first());
    await expect(page.locator('#claim-dialog-form, #claim-dialog-terms')).toHaveCount(0);
    expect(guard.unexpected).toEqual([]);
  });
});

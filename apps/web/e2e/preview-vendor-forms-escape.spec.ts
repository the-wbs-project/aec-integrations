import { expect, test, type Page } from '@playwright/test';

import { untilAppStable } from './hydration';

/**
 * AECI-2133: in a portal nested form, Escape does what Cancel does and focus returns
 * to the form's opener (`aecCloseOnEscape`, `vendor/shared/close-on-escape.ts`).
 *
 * For each of the four contest forms: open it, type a draft, press Escape, and check
 * the form is gone and focus is on the button that opened it. Then the guards a real
 * browser decides: Escape on an open native `<select>` (Chromium still sends it to the
 * page) leaves the form open, and so does Escape on an open tooltip. Once the list or
 * tooltip is closed, the next Escape closes the form.
 *
 * Driven on the ungated dev preview, so no vendor session is needed. Every request off
 * the local stack is answered here: PostHog with an empty 200, the rest aborted.
 * Nothing is submitted.
 */
const PRODUCTS = '/preview/vendor-dashboard/products';
const PROCORE = `${PRODUCTS}/summit-model-coordination/integrations/00000000-0000-4000-8000-000000005310`;
const UNCLAIMED = `${PRODUCTS}/summit-field-issues/integrations/00000000-0000-4000-8000-000000005312`;
const LIST = `${PRODUCTS}/summit-model-coordination/integrations`;
const DECLINED = '00000000-0000-4000-8000-000000005c14';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return route.continue();
    if (/posthog/.test(host)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
});

/** Click until the target shows: a click between SSR paint and hydration is dropped. */
async function open(page: Page, trigger: string, shows: string): Promise<void> {
  await expect(async () => {
    await page.locator(trigger).first().click();
    await expect(page.locator(shows)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** Pick the first option that can be picked, so the form shows its text fields. */
async function pickFirstField(page: Page, select: string): Promise<void> {
  const value = await page
    .locator(select)
    .evaluate(
      (el) =>
        [...(el as unknown as HTMLSelectElement).options].find((o) => o.value !== '' && !o.disabled)
          ?.value ?? '',
    );
  await page.locator(select).selectOption(value);
}

async function expectFocusOn(page: Page, selector: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((s) => document.activeElement === document.querySelector(s), selector),
    )
    .toBe(true);
}

const FORMS: readonly {
  name: string;
  url: string;
  steps: readonly { trigger: string; shows: string }[];
  form: string;
  /** A select to choose first, so the text fields render. */
  field?: string;
  opener: string;
}[] = [
  {
    name: 'the request form',
    url: PROCORE,
    steps: [
      { trigger: '[data-testid="request-correction"]', shows: '[data-testid="request-form"]' },
    ],
    form: '[data-testid="request-form"]',
    field: '#request-field',
    // The toolbar button is re-created when the form closes.
    opener: '[data-testid="request-correction"]',
  },
  {
    name: 'the protest to AECi',
    url: PROCORE,
    steps: [
      {
        trigger: `[data-testid="closed-toggle-${DECLINED}"]`,
        shows: `#vendor-protest-start-${DECLINED}`,
      },
      { trigger: `#vendor-protest-start-${DECLINED}`, shows: `#vendor-protest-form-${DECLINED}` },
    ],
    form: `#vendor-protest-form-${DECLINED}`,
    opener: `#vendor-protest-start-${DECLINED}`,
  },
  {
    name: '"Not ours?"',
    url: UNCLAIMED,
    steps: [{ trigger: '[data-testid="not-ours"]', shows: '[data-testid="not-ours-form"]' }],
    form: '[data-testid="not-ours-form"]',
    opener: '[data-testid="not-ours"]',
  },
  {
    name: '"Request a change" on a delivered pair',
    url: LIST,
    steps: [
      {
        trigger: '[data-contest-target] button[aria-controls]',
        shows: '[data-testid="contest-form"]',
      },
    ],
    form: '[data-testid="contest-form"]',
    field: '[data-testid="contest-form"] select[id$="-field"]',
    opener: '[data-contest-target] button[aria-controls]',
  },
];

for (const f of FORMS) {
  test(`${f.name}: Escape closes it as Cancel does and focus returns to the opener`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(f.url);
    await untilAppStable(page);
    for (const step of f.steps) await open(page, step.trigger, step.shows);
    if (f.field) await pickFirstField(page, f.field);
    const draft = page.locator(`${f.form} textarea`).last();
    await draft.fill('A draft the vendor typed.');
    await draft.focus();
    await page.keyboard.press('Escape');
    await expect(page.locator(f.form)).toHaveCount(0);
    await expectFocusOn(page, f.opener);
  });
}

test('the request form: Escape with the select open closes only the list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(PROCORE);
  await untilAppStable(page);
  await open(page, '[data-testid="request-correction"]', '[data-testid="request-form"]');
  // Count every Escape keydown that reaches the form, before the directive sees it.
  await page.locator('[data-testid="request-form"]').evaluate((form) => {
    const w = window as unknown as { formEscapes: number };
    w.formEscapes = 0;
    form.addEventListener(
      'keydown',
      (e) => {
        if ((e as KeyboardEvent).key === 'Escape') w.formEscapes += 1;
      },
      true,
    );
  });
  const formEscapes = () =>
    page.evaluate(() => (window as unknown as { formEscapes: number }).formEscapes);
  const select = page.locator('#request-field');
  await select.click();
  await expect.poll(() => select.evaluate((el) => el.matches(':open'))).toBe(true);
  await page.keyboard.press('Escape');
  // Headless Chromium can keep reporting `:open` after this Escape, so do not wait for
  // the list to close: the keydown is dispatched synchronously with the key press.
  const reached = await formEscapes();
  // The guard only matters while Chromium passes this Escape to the page. If a later
  // Chromium stops doing that, this test proves nothing, so it says so rather than pass.
  test.skip(
    reached === 0,
    'This Chromium no longer sends Escape on an open native select to the page, so the :open guard is not exercised.',
  );
  expect(reached).toBe(1);
  // The Escape reached the form once. Give a close time to render, then check it held.
  await page.waitForTimeout(300);
  await expect(page.locator('[data-testid="request-form"]')).toBeVisible();
  // With the list closed, the next Escape is the form's.
  await page.locator('#change-requests-form-title').click();
  await expect.poll(() => select.evaluate((el) => el.matches(':open'))).toBe(false);
  await select.focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="request-form"]')).toHaveCount(0);
  await expectFocusOn(page, '[data-testid="request-correction"]');
});

test('the answer form: Escape on an open tooltip closes only the tooltip', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(PROCORE);
  await untilAppStable(page);
  await open(page, '[data-testid="no-documents"]', '[data-testid="answer-form"]');
  const tip = page.locator('[data-testid="answer-form"] aec-vendor-tip button');
  await tip.focus();
  await expect(page.locator('[data-testid="vendor-tip-panel"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="vendor-tip-panel"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="answer-form"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="answer-form"]')).toHaveCount(0);
  await expectFocusOn(page, '[data-testid="no-documents"]');
});

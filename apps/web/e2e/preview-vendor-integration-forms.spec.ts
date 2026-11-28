import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { untilAppStable } from './hydration';

/**
 * AECI-1811 part 2: the five forms nested in the integration detail page carry the
 * nested save bar (`NESTED_SAVE_BAR`, sticky at the bottom), so each binds
 * `PORTAL_FORM_CLASS` through `FORM_PANEL`. This walks each form with Tab and checks
 * that no control it focuses sits under the bar (WCAG 2.4.11), at 1440 and at 320,
 * then runs axe with the form open. Driven on the ungated dev preview, so no vendor
 * session is needed.
 *
 * The forms: add a row, the answer ("No") form, the request form, and "Not ours?".
 * The protest to AECi on a declined request left this list with AECI-2110: it opens
 * in a dialog now (`preview-vendor-protest-dialog.spec.ts`). Since AECI-1812 also the integrations
 * list's forms, which took `aecKeepClearOfSaveBar`: "Add an integration" step 2, "Ask
 * us to add it", the owner edit form, the connector catalogue's match form, and "Add a
 * product". Since AECI-2132 also "Request a change" on a connector-delivered pair.
 *
 * Every request off the local stack is answered here: PostHog with an empty 200, the
 * rest aborted. Nothing is submitted.
 */
const PRODUCTS = '/preview/vendor-dashboard/products';
const PROCORE = `${PRODUCTS}/summit-model-coordination/integrations/00000000-0000-4000-8000-000000005310`;
const UNCLAIMED = `${PRODUCTS}/summit-field-issues/integrations/00000000-0000-4000-8000-000000005312`;

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return route.continue();
    if (/posthog/.test(host)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
});

/**
 * The dev-only fixture switcher is sticky and, at 320px, tall: it covers the page's
 * buttons and would count as an obscurer for axe. Un-stick it so only the page is
 * driven and judged. It is not part of the portal.
 */
async function unstickSwitcher(page: Page): Promise<void> {
  await page
    .locator('[aria-label="Concept switcher (dev only)"]')
    .evaluate((el) => el.closest<HTMLElement>('.sticky')?.style.setProperty('position', 'static'));
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

/** Click until the form shows: a click between SSR paint and hydration is dropped. */
async function open(page: Page, trigger: string, form: string): Promise<void> {
  await expect(async () => {
    await page.locator(trigger).first().click();
    await expect(page.locator(form)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/**
 * Tab from the form's first control to its bar. Every control focused on the way
 * must end above the bar's top edge. Controls inside the bar are exempt.
 */
async function walkClearOfBar(page: Page, form: string): Promise<number> {
  const first = page.locator(`${form} :is(input, select, textarea)`).first();
  await first.focus();
  let checked = 0;
  for (let i = 0; i < 40; i++) {
    if (i > 0) await page.keyboard.press('Tab');
    await page.waitForTimeout(50);
    const state = await page.evaluate((formSelector) => {
      const el = document.activeElement as HTMLElement | null;
      const formEl = document.querySelector(formSelector);
      const bar = formEl?.querySelector('.aec-portal-save-bar') as HTMLElement | null;
      if (!el || !formEl || !bar || !formEl.contains(el)) return { done: true };
      if (bar.contains(el)) return { done: true };
      return {
        done: false,
        name: `${el.tagName} ${el.id || el.textContent?.trim().slice(0, 30) || ''}`,
        bottom: Math.round(el.getBoundingClientRect().bottom),
        barTop: Math.round(bar.getBoundingClientRect().top),
      };
    }, form);
    if (state.done) break;
    checked++;
    expect(state.bottom!, `${state.name} is above the bar`).toBeLessThanOrEqual(state.barTop!);
  }
  return checked;
}

const FORMS: readonly {
  name: string;
  url: string;
  steps: readonly { trigger: string; shows: string }[];
  form: string;
}[] = [
  {
    name: 'add a row',
    url: PROCORE,
    steps: [{ trigger: '[data-testid="add-row"]', shows: '[data-testid="add-row-form"]' }],
    form: '[data-testid="add-row-form"]',
  },
  {
    name: 'the answer form',
    url: PROCORE,
    steps: [{ trigger: '[data-testid="no-documents"]', shows: '[data-testid="answer-form"]' }],
    form: '[data-testid="answer-form"]',
  },
  {
    name: 'the request form',
    url: PROCORE,
    steps: [
      { trigger: '[data-testid="request-correction"]', shows: '[data-testid="request-form"]' },
    ],
    form: '[data-testid="request-form"]',
  },
  {
    name: '"Not ours?"',
    url: UNCLAIMED,
    steps: [{ trigger: '[data-testid="not-ours"]', shows: '[data-testid="not-ours-form"]' }],
    form: '[data-testid="not-ours-form"]',
  },
  // AECI-1812: the integrations list's forms took `aecKeepClearOfSaveBar` too.
  {
    name: 'add an integration (step 2)',
    url: `${PRODUCTS}/summit-model-coordination/integrations?create=open&counterpart=procore`,
    steps: [],
    form: '[data-testid="create-form"]',
  },
  {
    name: 'ask us to add a product',
    url: `${PRODUCTS}/summit-model-coordination/integrations?create=open`,
    steps: [
      { trigger: '[data-testid="create-ask-us"]', shows: '[data-testid="product-request-form"]' },
    ],
    form: '[data-testid="product-request-form"]',
  },
  {
    name: 'the owner edit form',
    url: `${PRODUCTS}/summit-model-coordination/integrations`,
    steps: [
      {
        trigger: '[data-testid="edit-owned-integration"]',
        shows: 'aec-vendor-integration-edit-form form',
      },
    ],
    form: 'aec-vendor-integration-edit-form form',
  },
  {
    name: 'add a product',
    url: `${PRODUCTS}?create=open`,
    steps: [],
    form: '[data-testid="product-create-form"]',
  },
  // AECI-2132: "Request a change" on a connector-delivered pair (the Connectors section).
  {
    name: 'request a change on a delivered pair',
    url: `${PRODUCTS}/summit-model-coordination/integrations`,
    steps: [
      {
        trigger: '[data-contest-target] button[aria-controls]',
        shows: '[data-testid="contest-form"]',
      },
    ],
    form: '[data-testid="contest-form"]',
  },
  {
    name: 'the connector match form',
    url: `${PRODUCTS}/agave/catalogue?fixture=connector-seat`,
    steps: [
      {
        trigger: 'role=button[name="Edit the match for Procore"]',
        shows: 'form[aria-label^="Edit the match"]',
      },
    ],
    form: 'form[aria-label^="Edit the match"]',
  },
];

for (const width of [1440, 320]) {
  for (const f of FORMS) {
    test(`${f.name}: no control focused by Tab sits under the save bar at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 640 });
      await page.goto(f.url);
      await untilAppStable(page);
      await unstickSwitcher(page);
      for (const step of f.steps) await open(page, step.trigger, step.shows);
      expect(await walkClearOfBar(page, f.form)).toBeGreaterThan(0);
      expect(await axeSerious(page), `${f.name} open at ${width}px`).toEqual([]);
    });
  }
}

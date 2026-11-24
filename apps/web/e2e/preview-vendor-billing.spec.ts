import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { untilAppStable } from './hydration';

/**
 * AECI-1812 part 2: the portal Billing and Proposed products tabs in the portal's design
 * language, on the ungated dev preview. Each state is axe-scanned at 1440, 390 and 320,
 * and none may scroll the page sideways: a wide table scrolls inside its own labelled,
 * focusable region instead (before this, Billing was 1056px wide at 390).
 *
 * States: the default Billing read (the buy form, a waiting grant, live and ended
 * subscriptions), `?billing=card` (a company already paying by card), each inline form
 * open, the assign confirmation, the actions menu, the release dialog, the add dialog,
 * the ended subscriptions opened, and Proposed products with each confirmation open.
 *
 * NOTHING IS PAID OR ACCEPTED. The preview's API is an in-page fake, so no request
 * leaves the page for billing. Even so, every Stripe host is aborted and every
 * non-GET to `/api/vendor/billing*`, `/api/vendor/licen*`, `/api/vendor/license-grants*`
 * and `/api/vendor/proposals*` is refused with a 403, and no test presses "Continue to
 * Stripe", "Add subscriptions" (the dialog's submit), or a grant's "Accept".
 */
const BILLING = '/preview/vendor-dashboard/billing';
const PROPOSALS = '/preview/vendor-dashboard/proposals';
const WRITES = /\/api\/vendor\/(billing|licen|proposals)/;

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (/stripe/i.test(url.hostname)) return route.abort();
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      if (WRITES.test(url.pathname) && req.method() !== 'GET') {
        return route.fulfill({ status: 403, body: '{"error":{"code":"FORBIDDEN"}}' });
      }
      return route.continue();
    }
    if (/posthog/.test(url.hostname)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
});

/** The dev-only fixture switcher is sticky and tall at 320px. Un-stick it. */
async function unstickSwitcher(page: Page): Promise<void> {
  await page
    .locator('[aria-label="Concept switcher (dev only)"]')
    .evaluate((el) => el.closest<HTMLElement>('.sticky')?.style.setProperty('position', 'static'));
}

async function axeSerious(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('[aria-label="Concept switcher (dev only)"]')
    .analyze();
  return result.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** Click until the state shows: a click between SSR paint and hydration is dropped. */
async function reach(page: Page, steps: readonly Step[]): Promise<void> {
  for (const step of steps) {
    await expect(async () => {
      await page.locator(step.click).first().click();
      await expect(page.locator(step.shows).first()).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
  }
}

interface Step {
  readonly click: string;
  readonly shows: string;
}

const STATES: readonly { name: string; url: string; steps: readonly Step[] }[] = [
  { name: 'billing', url: BILLING, steps: [] },
  { name: 'billing, paying by card', url: `${BILLING}?billing=card`, steps: [] },
  {
    name: 'billing email form open',
    url: BILLING,
    steps: [{ click: 'aec-vendor-billing-email-form button', shows: '#billing-email-input' }],
  },
  {
    name: 'legal name form open',
    url: BILLING,
    steps: [
      { click: 'aec-vendor-billing-legal-name-form button', shows: '#billing-legal-name-input' },
    ],
  },
  {
    name: 'assign confirmation open',
    url: BILLING,
    steps: [
      {
        click: '[data-testid="license-assign-trigger"]',
        shows: '[data-testid="license-assign-confirm"]',
      },
    ],
  },
  {
    name: 'actions menu open',
    url: BILLING,
    steps: [
      {
        click: '[data-testid="license-actions-trigger"]',
        shows: '[data-testid="license-actions-menu"]',
      },
    ],
  },
  {
    name: 'release dialog open',
    url: BILLING,
    steps: [
      {
        click: '[data-testid="license-actions-trigger"]',
        shows: '[data-testid="license-actions-menu"]',
      },
      {
        click: '[data-testid="license-actions-release"]',
        shows: '[data-testid="license-release-description"]',
      },
    ],
  },
  {
    name: 'add subscriptions dialog open',
    url: `${BILLING}?billing=card`,
    steps: [
      { click: '[data-testid="stripe-add-open"]', shows: '[data-testid="stripe-add-dialog"]' },
    ],
  },
  {
    name: 'ended subscriptions open',
    url: BILLING,
    steps: [
      {
        click: '[data-testid="licenses-ended-summary"]',
        shows: '[data-testid="licenses-ended"][open]',
      },
    ],
  },
  { name: 'proposed products', url: PROPOSALS, steps: [] },
  {
    name: 'accept confirmation open',
    url: PROPOSALS,
    steps: [
      {
        click: '[data-testid="proposal-accept"]:not([disabled])',
        shows: '[data-testid="proposal-confirm"]',
      },
    ],
  },
  {
    name: 'decline confirmation open',
    url: PROPOSALS,
    steps: [
      { click: '[data-testid="proposal-decline"]', shows: '[data-testid="proposal-confirm"]' },
    ],
  },
];

for (const width of [1440, 390, 320]) {
  for (const s of STATES) {
    test(`${s.name} at ${width}px: axe clean, no sideways page scroll`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(s.url);
      await untilAppStable(page);
      await unstickSwitcher(page);
      await reach(page, s.steps);
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth, `${s.name} page width at ${width}px`).toBeLessThanOrEqual(width);
      expect(await axeSerious(page), `${s.name} at ${width}px`).toEqual([]);
    });
  }
}

test.describe('billing tables', () => {
  test('each table scrolls inside a labelled, focusable region', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(BILLING);
    await untilAppStable(page);
    for (const [id, name] of [
      ['licenses-region', 'Subscriptions'],
      ['agreements-region', 'Accepted agreements'],
    ] as const) {
      const region = page.getByTestId(id);
      await expect(region).toHaveAttribute('role', 'region');
      await expect(region).toHaveAttribute('tabindex', '0');
      await expect(region).toHaveAccessibleName(name);
      const overflows = await region.evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(overflows, `${name} scrolls inside its region`).toBe(true);
    }
  });
});

/**
 * Every sentence around a pay or accept action stays above that action, in source
 * order AND on screen, at every width (AECI-1812 review). Each element's top is below
 * the one before it, and each sits wholly above the action button.
 */
async function expectRenderedOrder(page: Page, ids: readonly string[], label: string) {
  const boxes = [];
  for (const id of ids) {
    const el = page.getByTestId(id).first();
    await expect(el, `${id} is on the page`).toBeVisible();
    boxes.push({ id, box: (await el.boundingBox())! });
  }
  const sourceOrder = await page.evaluate((list) => {
    const els = list.map((id) => document.querySelector(`[data-testid="${id}"]`)!);
    return els.every(
      (el, i) =>
        i === 0 ||
        (els[i - 1]!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    );
  }, ids);
  expect(sourceOrder, `${label}: source order`).toBe(true);
  const action = boxes[boxes.length - 1]!;
  for (let i = 1; i < boxes.length; i++) {
    const prev = boxes[i - 1]!;
    const cur = boxes[i]!;
    expect(cur.box.y, `${label}: ${cur.id} is below ${prev.id}`).toBeGreaterThan(prev.box.y);
    if (cur !== action) {
      expect(
        cur.box.y + cur.box.height,
        `${label}: ${cur.id} ends above ${action.id}`,
      ).toBeLessThanOrEqual(action.box.y);
    }
  }
}

for (const width of [1440, 390, 320]) {
  test.describe(`order around pay and accept at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test('Pay by card: disclosure, cap and agreement note sit above "Continue to Stripe"', async ({
      page,
    }) => {
      await page.goto(BILLING);
      await untilAppStable(page);
      await expectRenderedOrder(
        page,
        ['stripe-disclosure', 'stripe-cap', 'stripe-agreement', 'stripe-checkout'],
        `buy form at ${width}px`,
      );
      // The one primary action on the page.
      await expect(page.getByTestId('stripe-checkout')).toHaveAttribute('data-variant', 'primary');
    });

    test('Add subscriptions: the proration sentence sits above the submit', async ({ page }) => {
      await page.goto(`${BILLING}?billing=card`);
      await untilAppStable(page);
      await unstickSwitcher(page);
      await reach(page, [
        { click: '[data-testid="stripe-add-open"]', shows: '[data-testid="stripe-add-dialog"]' },
      ]);
      await expectRenderedOrder(
        page,
        ['stripe-add-intro', 'stripe-add-submit'],
        `add dialog at ${width}px`,
      );
    });

    test('a waiting grant: the agreement sentence sits above Accept', async ({ page }) => {
      await page.goto(BILLING);
      await untilAppStable(page);
      await expectRenderedOrder(
        page,
        ['pending-grant-version-link', 'pending-grant-accept-label', 'pending-grant-accept'],
        `grant card at ${width}px`,
      );
    });
  });
}

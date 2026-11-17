/**
 * AECI-1807: the claim and correction pages and the review form in the new design
 * language. The forms are the shared card on the 7xl canvas with the context rail
 * (`DESIGN.md` "Form + context rail"), so this spec checks what a restyle can break:
 *
 *   - no sideways scroll from 320 to 1440px, in the default and error states;
 *   - axe (WCAG 2.2 AA) has no serious or critical violation in the default, error
 *     and success states;
 *   - a submit press with a bad answer shows the errors, ties each one to its field
 *     and moves focus to the first bad field ("Submit stays enabled");
 *   - every target in the forms is at least 44px tall;
 *   - with the web fonts blocked and a wide face forced, no label, button or link
 *     wraps out of its box or clips at 320px (Linux CI has other font widths).
 *
 * Every write is intercepted with `page.route`: nothing reaches the API, Linear or
 * mail. The review form needs the dummy session cookie that `reviews-submission.spec.ts`
 * uses, and the seed product.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { expectNoSidewaysScroll } from './no-sideways-scroll';

const PRODUCT_SLUG = 'fixture-procore';
const VENDOR_SLUG = 'fixture-procore-technologies';
const WIDTHS = [320, 390, 768, 1024, 1280, 1440];
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const REQUEST_PAGES = [
  { name: 'product claim', path: `/products/${PRODUCT_SLUG}/claim`, kind: 'claim' },
  { name: 'product correction', path: `/products/${PRODUCT_SLUG}/correction`, kind: 'correction' },
  { name: 'vendor claim', path: `/vendors/${VENDOR_SLUG}/claim`, kind: 'claim' },
  { name: 'vendor correction', path: `/vendors/${VENDOR_SLUG}/correction`, kind: 'correction' },
] as const;

const REVIEW_PATH = `/products/${PRODUCT_SLUG}/review`;

/** Every write is answered here. Reads of the local stack pass through. */
async function interceptWrites(page: Page): Promise<string[]> {
  const sent: string[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/requests/claim' || path === '/api/requests/correction') {
      sent.push(path);
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
    if (path === '/api/reviews' && req.method() === 'POST') {
      sent.push(path);
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'rev-e2e', status: 'pending', message: 'ok' }),
      });
    }
    // The dummy session has no account behind it: answer as the API would.
    if (path.startsWith('/api/account')) {
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    }
    if (req.method() !== 'GET' && req.method() !== 'HEAD') {
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    }
    return route.continue();
  });
  return sent;
}

async function addAuthCookie(context: BrowserContext, baseURL: string): Promise<void> {
  const url = new URL(baseURL);
  await context.addCookies([
    {
      name: 'sb-localdev-auth-token',
      value: 'base64-e2e-forms',
      domain: url.hostname,
      path: '/',
      secure: url.protocol === 'https:',
      sameSite: 'Lax',
    },
  ]);
}

async function seriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

/** The routed page's submit, once hydrated (the claim seat lookup runs after render). */
async function openRequest(page: Page, path: string) {
  await page.goto(path);
  const submit = page.locator('[data-testid="page-canvas"] form button[type="submit"]');
  await expect(submit).toBeVisible();
  return submit;
}

/** Fill a request form validly. */
async function fillRequest(page: Page, kind: 'claim' | 'correction'): Promise<void> {
  if (kind === 'claim') {
    await page.locator('#claim-name').fill('Jane Example');
    await page.locator('#claim-title').fill('Product manager');
    await page.locator('#claim-email').fill('jane@procore.com');
    await page.locator('#claim-legal-name').fill('Procore Technologies, Inc.');
    await page.locator('#claim-terms').check();
  } else {
    await page.locator('#correction-body').fill('The founding year should read 2002, not 2003.');
    await page.locator('#correction-email').fill('jane@procore.com');
  }
}

/** Press submit until the press lands: a click before hydration is replayed, not run. */
async function pressUntil(
  page: Page,
  submit: ReturnType<Page['locator']>,
  done: () => Promise<void>,
) {
  await expect(async () => {
    await submit.click();
    await done();
  }).toPass({ timeout: 15_000 });
}

test.describe('request forms (AECI-1807)', () => {
  for (const r of REQUEST_PAGES) {
    test.describe(r.name, () => {
      test('no sideways scroll from 320 to 1440px, default and error', async ({ page }) => {
        await interceptWrites(page);
        const submit = await openRequest(page, r.path);
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          await expectNoSidewaysScroll(page, `default at ${width}px`);
        }
        if (r.kind === 'claim') await page.locator('#claim-terms').check();
        const first = r.kind === 'claim' ? '#claim-name' : '#correction-body';
        await pressUntil(page, submit, async () => {
          await expect(page.locator(first)).toBeFocused({ timeout: 1000 });
        });
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          await expectNoSidewaysScroll(page, `error at ${width}px`);
        }
      });

      test('a press with bad answers ties each error to its field and focuses the first', async ({
        page,
      }) => {
        const sent = await interceptWrites(page);
        await page.setViewportSize({ width: 390, height: 900 });
        const submit = await openRequest(page, r.path);
        // The claim box gates the button (VENDOR_SIGNUP_PROCESS.md section 4).
        if (r.kind === 'claim') {
          await expect(submit).toBeDisabled();
          await page.locator('#claim-terms').check();
        }
        await expect(submit).toBeEnabled();
        const first = r.kind === 'claim' ? 'claim-name' : 'correction-body';
        const email = r.kind === 'claim' ? 'claim-email' : 'correction-email';
        await pressUntil(page, submit, async () => {
          await expect(page.locator(`#${first}`)).toBeFocused({ timeout: 1000 });
        });
        for (const id of [first, email]) {
          const field = page.locator(`#${id}`);
          await expect(field).toHaveAttribute('aria-invalid', 'true');
          await expect(field).toHaveAttribute('aria-describedby', new RegExp(`${id}-error`));
          await expect(page.locator(`#${id}-error`)).toHaveAttribute('role', 'alert');
        }
        // The red edge is 2px in the error colour, so the field changes more than its hue.
        const width = await page
          .locator(`#${first}`)
          .evaluate((el) => getComputedStyle(el).borderTopWidth);
        expect(width).toBe('2px');
        expect(sent).toEqual([]);
        expect(await seriousViolations(page)).toEqual([]);
      });

      test('default and success states pass axe, and the success heading takes focus', async ({
        page,
      }) => {
        const sent = await interceptWrites(page);
        const submit = await openRequest(page, r.path);
        expect(await seriousViolations(page)).toEqual([]);
        await fillRequest(page, r.kind);
        await pressUntil(page, submit, async () => {
          await expect(page.locator('h1')).toContainText(/sent/i, { timeout: 1000 });
        });
        await expect(page.locator('h1')).toBeFocused();
        expect(sent).toEqual([`/api/requests/${r.kind}`]);
        expect(await seriousViolations(page)).toEqual([]);
      });

      test('every target in the form and rail is at least 44px tall', async ({ page }) => {
        await interceptWrites(page);
        await page.setViewportSize({ width: 390, height: 900 });
        await openRequest(page, r.path);
        const heights = await page
          .locator(
            '[data-testid="page-canvas"] form button, [data-testid="page-canvas"] form input:not([type="checkbox"]), [data-testid="page-canvas"] form select, [data-testid="context-rail"] a',
          )
          .evaluateAll((els) =>
            els
              .filter((el) => (el as HTMLElement).offsetParent !== null)
              .map((el) => ({
                id: el.id || el.textContent?.trim(),
                h: el.getBoundingClientRect().height,
              })),
          );
        expect(heights.length).toBeGreaterThan(1);
        for (const { id, h } of heights)
          expect(h, `${id} is 44px or taller`).toBeGreaterThanOrEqual(44);
      });
    });
  }
});

/**
 * The SSR form has no action, and event replay never cancels a native submit. If the
 * submit were enabled before hydration, an early press or Enter would GET the page
 * with every answer, the email included, in the query string. With JavaScript off
 * the SSR HTML is all there is, so this pins that the submit waits for hydration.
 */
test.describe('request forms before hydration (AECI-1807)', () => {
  test.use({ javaScriptEnabled: false });
  for (const r of REQUEST_PAGES) {
    test(`${r.name}: the SSR submit is disabled and Enter does not submit`, async ({ page }) => {
      await page.goto(r.path);
      const submit = page.locator('[data-testid="page-canvas"] form button[type="submit"]');
      await expect(submit).toBeDisabled();
      const email = r.kind === 'claim' ? '#claim-email' : '#correction-email';
      await page.locator(email).fill('jane@procore.com');
      await page.locator(email).press('Enter');
      await page.waitForTimeout(500);
      expect(new URL(page.url()).search).toBe('');
    });
  }
});

test.describe('review form (AECI-1807)', () => {
  test.beforeEach(async ({ context, baseURL, request }) => {
    const probe = await request.get(`/products/${PRODUCT_SLUG}`, { maxRedirects: 0 });
    test.skip(probe.status() !== 200, `seed product ${PRODUCT_SLUG} is absent`);
    await addAuthCookie(context, baseURL!);
  });

  test('no sideways scroll from 320 to 1440px, default and error', async ({ page }) => {
    await interceptWrites(page);
    await page.goto(REVIEW_PATH);
    const submit = page.getByRole('button', { name: 'Submit review' });
    await expect(submit).toBeVisible();
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoSidewaysScroll(page, `default at ${width}px`);
    }
    await pressUntil(page, submit, async () => {
      await expect(page.locator('#overall-error')).toBeVisible({ timeout: 1000 });
    });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoSidewaysScroll(page, `error at ${width}px`);
    }
  });

  test('error state: errors tied to their fields, axe clean, focus on the first rating', async ({
    page,
  }) => {
    const sent = await interceptWrites(page);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(REVIEW_PATH);
    const submit = page.getByRole('button', { name: 'Submit review' });
    await expect(submit).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await pressUntil(page, submit, async () => {
      await expect(page.locator('#overall-error')).toBeVisible({ timeout: 1000 });
    });
    const overall = page.locator('ul[aria-labelledby="overall-label"]');
    await expect(overall.locator('[role="option"]:focus')).toHaveCount(1);
    await expect(overall).toHaveAttribute('aria-describedby', 'overall-error');
    await expect(page.locator('#review-title-input')).toHaveAttribute(
      'aria-describedby',
      'review-title-hint review-title-error',
    );
    await expect(page.locator('#review-body')).toHaveAttribute(
      'aria-describedby',
      'review-body-hint review-body-error',
    );
    expect(sent).toEqual([]);
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('success state passes axe; the recommend choice shows a tick', async ({ page }) => {
    const sent = await interceptWrites(page);
    await page.goto(REVIEW_PATH);
    const submit = page.getByRole('button', { name: 'Submit review' });
    await expect(submit).toBeVisible();
    await page.locator('ul[aria-labelledby="overall-label"] [role="option"]').nth(3).click();
    await page.locator('ul[aria-labelledby="onboarding-label"] [role="option"]').nth(4).click();
    await page.locator('#review-title-input').fill('Reliable Revit connector');
    await page
      .locator('#review-body')
      .fill(
        'We rolled this out across three offices and the model sync held up under heavy load. ' +
          'Onboarding took a couple of calls but support was responsive.',
      );
    const yes = page.locator('ul[aria-labelledby="recommend-label"] [role="option"]').first();
    await yes.click();
    await expect(yes).toHaveAttribute('aria-selected', 'true');
    await expect(yes.locator('aec-icon')).toHaveCount(1);
    expect(await seriousViolations(page)).toEqual([]);
    await submit.click();
    await expect(page.getByRole('heading', { name: 'Review received' })).toBeFocused();
    expect(sent).toEqual(['/api/reviews']);
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('every target in the form and rail is at least 44px tall', async ({ page }) => {
    await interceptWrites(page);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(REVIEW_PATH);
    await expect(page.getByRole('button', { name: 'Submit review' })).toBeVisible();
    const heights = await page
      .locator(
        '[data-testid="page-canvas"] form button, [data-testid="page-canvas"] form input, [data-testid="page-canvas"] form [role="option"], [data-testid="context-rail"] a',
      )
      .evaluateAll((els) =>
        els.map((el) => ({
          id: el.getAttribute('aria-label') || el.textContent?.trim() || el.id,
          h: el.getBoundingClientRect().height,
        })),
      );
    for (const { id, h } of heights) {
      // A recommend segment is 36px inside its 44px frame (the segmented control recipe).
      const floor = /^(Yes|No|Maybe)$/.test(id ?? '') ? 36 : 44;
      expect(h, `${id} is ${floor}px or taller`).toBeGreaterThanOrEqual(floor);
    }
  });
});

/**
 * With the web fonts blocked and a wide face forced, nothing in the forms wraps out
 * of its box or clips at 320px. Verdana is the widest common sans; the generic family
 * covers a runner that has none of the named ones.
 */
test.describe('wide fallback fonts at 320px (AECI-1807)', () => {
  for (const face of ['Verdana', 'DejaVu Sans', 'sans-serif']) {
    test(`claim, correction and review hold in ${face}`, async ({ page, context, baseURL }) => {
      await interceptWrites(page);
      await page.route('**/fonts/**', (route) => route.abort());
      await addAuthCookie(context, baseURL!);
      await page.setViewportSize({ width: 320, height: 800 });
      for (const path of [
        `/products/${PRODUCT_SLUG}/claim`,
        `/vendors/${VENDOR_SLUG}/correction`,
        REVIEW_PATH,
      ]) {
        await page.goto(path);
        await page.addStyleTag({
          content: `body, body * { font-family: "${face}", sans-serif !important; }`,
        });
        await expect(
          page.locator('[data-testid="page-canvas"] form button[type="submit"]'),
        ).toBeVisible();
        await expectNoSidewaysScroll(page, `${path} in ${face}`);
        const clipped = await page
          .locator(
            '[data-testid="page-canvas"] label, [data-testid="page-canvas"] button, [data-testid="page-canvas"] a, [data-testid="page-canvas"] [role="option"]',
          )
          .evaluateAll((els) =>
            els
              .filter((el) => (el as HTMLElement).offsetParent !== null)
              .filter((el) => el.scrollWidth > el.clientWidth + 1)
              .map((el) => el.textContent?.trim().slice(0, 40)),
          );
        expect(clipped, `${path}: nothing overflows its box`).toEqual([]);
        // The submit stays one 44px line.
        const submitBox = await page
          .locator('[data-testid="page-canvas"] form button[type="submit"]')
          .boundingBox();
        expect(submitBox!.height).toBeGreaterThanOrEqual(44);
        expect(submitBox!.height).toBeLessThanOrEqual(46);
        // The rail's guide link and the claim's terms links stay visible.
        await expect(page.locator('[data-testid="context-rail"] a')).toBeVisible();
        if (path.endsWith('/claim')) {
          await expect(page.getByRole('link', { name: /Vendor Terms/ }).first()).toBeVisible();
          await expect(page.getByRole('link', { name: /Review Guidelines/ })).toBeVisible();
        }
      }
    });
  }
});

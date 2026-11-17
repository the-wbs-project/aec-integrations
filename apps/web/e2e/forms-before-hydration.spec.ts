/**
 * AECI-1919 hotfix: a form submitted before hydration must not put answers in the address.
 *
 * A form with no `method` and no `action` is a native GET to the page itself. Signal
 * Forms gives every field a `name` (`ng.form0.submitter_email`), so Enter on the
 * server-rendered listing request form reloaded the page with every answer in the
 * query string. The edge request log keeps full addresses for 400 days and PostHog's
 * `$current_url` receives them. The form now declares `method="dialog"`, whose
 * native submit does nothing outside a `<dialog>`.
 *
 * With JavaScript off the SSR HTML is all there is, which is the window before
 * hydration. Every request is routed: the page's own same-origin GETs pass while it
 * loads, then the test arms, and any request after that is recorded and stubbed.
 * Nothing reaches the stack. A new leaking route is one line in `ROUTES`.
 */
import { expect, test, type Page } from '@playwright/test';

const ROUTES: readonly string[] = ['/vendor-program/list-your-product'];

const TEXT_FIELD =
  'input:not([type]), input[type="text"], input[type="email"], input[type="url"], textarea';

async function guardRequests(page: Page, origin: string) {
  const sent: string[] = [];
  let armed = false;
  await page.route('**/*', (route) => {
    const req = route.request();
    if (armed || req.method() !== 'GET') {
      sent.push(`${req.method()} ${req.url()}`);
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' });
    }
    return req.url().startsWith(origin) ? route.continue() : route.abort();
  });
  return {
    sent,
    arm: () => {
      sent.length = 0;
      armed = true;
    },
  };
}

test.describe('forms before hydration (AECI-1919)', () => {
  test.use({ javaScriptEnabled: false });

  for (const path of ROUTES) {
    test(`${path}: Enter and submit leave the address unchanged`, async ({ page, baseURL }) => {
      const guard = await guardRequests(page, new URL(baseURL!).origin);
      expect((await page.goto(path))?.status()).toBe(200);
      expect(guard.sent, 'no write while the page loads').toEqual([]);

      const form = page.locator('form:not([method="get"])').first();
      await expect(form).toHaveAttribute('method', 'dialog');

      const fields = form.locator(TEXT_FIELD);
      for (let i = 0; i < (await fields.count()); i++) {
        const field = fields.nth(i);
        if ((await field.isVisible()) && (await field.isEditable())) {
          await field.fill('fake.tester@example.invalid');
        }
      }

      const address = page.url();
      guard.arm();
      await form.locator('input').filter({ visible: true }).first().press('Enter');
      const submit = page.locator(
        'button[type="submit"][form="claim-dialog-form"], form button[type="submit"]',
      );
      if ((await submit.count()) > 0 && (await submit.first().isEnabled())) {
        await submit.first().click();
      }
      await page.waitForTimeout(300);

      expect(page.url(), 'the address is unchanged').toBe(address);
      expect(guard.sent, 'nothing left the page').toEqual([]);
    });
  }
});

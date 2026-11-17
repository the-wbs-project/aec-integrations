/**
 * AECI-1919: no form can put a visitor's answers in the address before hydration.
 *
 * A form with no `method` and no `action` is a native GET to the page itself. Signal
 * Forms gives every field a `name` (`ng.form9.submitter_email`), so a press or Enter
 * on the server-rendered HTML, before the scripts load, reloaded the page with every
 * answer in the query string. The edge request log keeps full addresses for 400 days
 * and PostHog's `$current_url` receives them. Every form now declares `method`:
 * `dialog` for a form the component submits (a native submit that does nothing
 * outside a `<dialog>`), `get` with `action="/search"` for the search forms that are
 * built to work without scripts. DESIGN.md "Forms are inert before hydration".
 *
 * With JavaScript off the SSR HTML is all there is, which is exactly the window
 * before hydration. Each route below is loaded that way. Every request is routed:
 * the page's own same-origin GETs pass while it loads, then the test arms, and any
 * request at all after that is recorded and aborted. Nothing is ever sent.
 *
 * Adding a form route is one line in `INERT_FORM_ROUTES` (or `SEARCH_FORM_ROUTES` for
 * a no-JS GET search form).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const PRODUCT = 'fixture-procore';
const VENDOR = 'fixture-procore-technologies';

interface FormRoute {
  readonly path: string;
  /** Needs the presence-only session cookie the SSR gate checks (`/account`, the review form). */
  readonly signedIn?: boolean;
}

/** Routes whose SSR HTML holds at least one form the component submits. */
const INERT_FORM_ROUTES: readonly FormRoute[] = [
  // The mailing list card sits in the foot of the listing, detail and pair pages.
  { path: '/products' },
  { path: `/products/${PRODUCT}` },
  { path: `/products/${PRODUCT}/integrations/fixture-acme-connector` },
  { path: `/vendors/${VENDOR}` },
  { path: '/categories/project-management' },
  { path: '/trades' },
  { path: '/search' },
  { path: '/roadmap' },
  { path: '/updates' },
  { path: `/products/${PRODUCT}/claim` },
  { path: `/products/${PRODUCT}/correction` },
  { path: `/vendors/${VENDOR}/claim` },
  { path: `/vendors/${VENDOR}/correction` },
  { path: '/vendor-program/list-your-product' },
  { path: '/auth/login' },
];

/**
 * Signed-in routes whose form renders only after hydration, behind a browser-only
 * session check. Their SSR HTML must hold no form the component submits. If one
 * starts to, move it to `INERT_FORM_ROUTES`.
 */
const CLIENT_ONLY_FORM_ROUTES: readonly FormRoute[] = [
  { path: `/products/${PRODUCT}/review`, signedIn: true },
  { path: '/account', signedIn: true },
  { path: '/welcome', signedIn: true },
];

/** Routes with a search form built to work without scripts: a GET to `/search?q=`. */
const SEARCH_FORM_ROUTES: readonly FormRoute[] = [
  { path: '/' },
  { path: `/products/${PRODUCT}` },
  { path: '/search' },
];

/** Text-like fields a visitor can type an answer into. */
const TEXT_FIELD =
  'input:not([type]), input[type="text"], input[type="email"], input[type="url"], ' +
  'input[type="search"], input[type="tel"], textarea';

async function addPresenceCookie(context: BrowserContext, baseURL: string): Promise<void> {
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

/**
 * Route every request. While the page loads, its own same-origin GETs pass and other
 * origins are aborted. A non-GET at any point is recorded, and the tests fail on it.
 * After `arm()`, every request is recorded and answered here with a stub, so it
 * never reaches the stack.
 */
async function guardRequests(page: Page, origin: string) {
  const sent: string[] = [];
  let armed = false;
  await page.route('**/*', (route) => {
    const req = route.request();
    const sameOrigin = req.url().startsWith(origin);
    if (armed || req.method() !== 'GET') {
      sent.push(`${req.method()} ${req.url()}`);
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' });
    }
    return sameOrigin ? route.continue() : route.abort();
  });
  return {
    sent,
    arm: () => {
      sent.length = 0;
      armed = true;
    },
    disarm: () => {
      armed = false;
    },
  };
}

/** Fill every visible text field in the form with a recognisable answer. */
async function fillAll(form: ReturnType<Page['locator']>): Promise<void> {
  const fields = form.locator(TEXT_FIELD);
  for (let i = 0; i < (await fields.count()); i++) {
    const field = fields.nth(i);
    if ((await field.isVisible()) && (await field.isEditable())) {
      await field.fill('jane@example.com');
    }
  }
}

test.describe('forms before hydration (AECI-1919)', () => {
  test.use({ javaScriptEnabled: false });

  for (const route of INERT_FORM_ROUTES) {
    test(`${route.path}: no form puts an answer in the address`, async ({
      page,
      context,
      baseURL,
    }) => {
      if (route.signedIn) await addPresenceCookie(context, baseURL!);
      const guard = await guardRequests(page, new URL(baseURL!).origin);
      const response = await page.goto(route.path);
      expect(response?.status(), `${route.path} renders`).toBe(200);
      expect(new URL(page.url()).pathname, 'no redirect away from the form').toBe(
        new URL(route.path, baseURL).pathname,
      );
      expect(guard.sent, 'no write while the page loads').toEqual([]);

      const forms = page.locator('form:not([method="get"])');
      const count = await forms.count();
      expect(count, `${route.path} has a form the component submits`).toBeGreaterThan(0);

      const address = page.url();
      for (let i = 0; i < count; i++) {
        const form = forms.nth(i);
        const shape = await form.evaluate((el: HTMLFormElement) => ({
          method: el.getAttribute('method'),
          submits: [...el.elements]
            .filter(
              (e): e is HTMLButtonElement => e instanceof HTMLButtonElement && e.type === 'submit',
            )
            .map((b) => ({ id: b.id, disabled: b.disabled })),
        }));
        expect(
          shape.method === 'dialog' || shape.submits.every((s) => s.disabled),
          `form ${i} on ${route.path} is inert (method="dialog") or its submit is disabled`,
        ).toBe(true);

        await fillAll(form);
        guard.arm();

        const field = form.locator(TEXT_FIELD).filter({ visible: true }).first();
        if ((await field.count()) > 0 && (await field.evaluate((e) => e.tagName)) === 'INPUT') {
          await field.press('Enter');
        }
        const submit = shape.submits.find((s) => !s.disabled);
        if (submit) {
          const button = form.locator('button[type="submit"]:not([disabled])').first();
          if ((await button.count()) > 0 && (await button.isVisible())) await button.click();
        }
        await page.waitForTimeout(300);

        expect(page.url(), `form ${i} on ${route.path} left the address unchanged`).toBe(address);
        expect(guard.sent, `form ${i} on ${route.path} sent nothing`).toEqual([]);
      }
    });
  }

  for (const route of CLIENT_ONLY_FORM_ROUTES) {
    test(`${route.path}: the SSR HTML holds no form to submit`, async ({
      page,
      context,
      baseURL,
    }) => {
      if (route.signedIn) await addPresenceCookie(context, baseURL!);
      const guard = await guardRequests(page, new URL(baseURL!).origin);
      const response = await page.goto(route.path);
      expect(response?.status(), `${route.path} renders`).toBe(200);
      expect(new URL(page.url()).pathname, 'no redirect away from the page').toBe(
        new URL(route.path, baseURL).pathname,
      );
      await expect(page.locator('form:not([method="get"])')).toHaveCount(0);
      expect(guard.sent, 'no write while the page loads').toEqual([]);
    });
  }

  for (const route of SEARCH_FORM_ROUTES) {
    test(`${route.path}: the no-JS search forms GET /search with the query only`, async ({
      page,
      baseURL,
    }) => {
      const guard = await guardRequests(page, new URL(baseURL!).origin);
      await page.goto(route.path);
      const forms = page.locator('form[method="get"]');
      const count = await forms.count();
      expect(count, `${route.path} has a search form`).toBeGreaterThan(0);

      for (let i = 0; i < count; i++) {
        guard.disarm();
        if (i > 0) await page.goto(route.path);
        const form = forms.nth(i);
        await expect(form).toHaveAttribute('action', '/search');
        const field = form.locator(TEXT_FIELD).filter({ visible: true }).first();
        if ((await field.count()) === 0) continue;
        await field.fill('revit');
        guard.arm();
        await field.press('Enter');
        await expect.poll(() => guard.sent.length).toBeGreaterThan(0);

        const [first] = guard.sent;
        const url = new URL(first.slice('GET '.length));
        expect(first.startsWith('GET '), 'a GET, never a write').toBe(true);
        expect(url.pathname).toBe('/search');
        expect([...new Set(url.searchParams.keys())], 'only the query is in the address').toEqual([
          'q',
        ]);
        expect(url.searchParams.get('q')).toBe('revit');
      }
    });
  }
});

/**
 * AECI-1720: what a visitor types before hydration survives into the form, and no
 * consent box can be ticked before the app can take the tick.
 *
 * The claim pages are server-rendered and cached, so a visitor on a slow phone can
 * fill the form before the scripts load. Hydration wrote the model's empty starting
 * values over every `[formField]` control, so the answers emptied. The inline recorder
 * in `src/index.html` keeps typed values and `AecEarlyInput`
 * (`shared/form-field/early-input.ts`) puts them back once the field is live.
 *
 * Consent is the other half. No checkbox is ever carried, whatever ticked it: the
 * visitor, an extension or a script's `click()` (Chromium fires trusted `input` and
 * `change` for all three). A consent box is disabled in the server HTML until the app
 * is live (`AecConsentBox`), so it cannot be ticked early and untick itself.
 *
 * Each test holds the app's entry bundle, acts on the server-rendered HTML, then
 * releases the bundle and checks the form once it is hydrated. Every request is
 * routed: the page's own same-origin GETs pass, other origins are aborted, the one
 * write each test makes is answered here, and any other write fails the test.
 *
 * Analytics. Where the stack serves a PostHog key (CI's `dev:bound` uses the committed
 * per-env `phc_` var), the client asks PostHog for its config and flags and may send
 * events. Those requests are answered here with empty payloads, so none leaves the
 * machine. Each one is decoded (URL, raw body, gzip, base64 `data=`) and checked: no
 * value a test types may appear in it, so the spec also proves analytics does not
 * receive form answers.
 *
 * `AECI_CPU_THROTTLE=4` runs every test with the CPU slowed four times (CDP).
 */
import { gunzipSync } from 'node:zlib';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request } from '@playwright/test';

import { untilHydrated } from './hydration';

const CLAIM_PAGES = [
  { name: 'product claim', path: '/products/fixture-procore/claim' },
  { name: 'vendor claim', path: '/vendors/fixture-procore-technologies/claim' },
] as const;

const CLAIM_FORM = '[data-testid="page-canvas"] form';
const CLAIM_SUBMIT = `${CLAIM_FORM} button[type="submit"]`;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const THROTTLE = Number(process.env['AECI_CPU_THROTTLE'] ?? '1');

test.beforeEach(async ({ page }) => {
  if (THROTTLE > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  }
});

interface Guard {
  /** Bodies of the writes this test allows, answered with a stub. */
  readonly sent: { path: string; body: Record<string, unknown> }[];
  /** Anything else: a write nobody allowed, or a request to another origin. */
  readonly unexpected: string[];
  /** PostHog requests, answered here. Expected wherever the stack serves a key. */
  readonly analytics: string[];
  /** A typed test value found in a PostHog request: a leak of a form answer. */
  readonly leaks: string[];
  release(): void;
}

/** PostHog's hosts: `us.i.posthog.com`, `us-assets.i.posthog.com` and the like. */
function isPostHog(url: URL): boolean {
  return url.hostname === 'posthog.com' || url.hostname.endsWith('.posthog.com');
}

/** Everything a PostHog request could carry, decoded as far as the client encodes it. */
function analyticsText(req: Request): string {
  const parts = [req.url()];
  try {
    parts.push(decodeURIComponent(req.url()));
  } catch {
    // A malformed escape: the raw URL is already in.
  }
  const body = req.postDataBuffer();
  if (body) {
    const raw = body.toString('utf8');
    parts.push(raw);
    try {
      parts.push(gunzipSync(body).toString('utf8'));
    } catch {
      // Not gzip.
    }
    const data = new URLSearchParams(raw).get('data');
    if (data) parts.push(Buffer.from(data, 'base64').toString('utf8'));
  }
  return parts.join('\n');
}

/** An empty answer for each PostHog endpoint the client calls. */
function analyticsAnswer(url: URL): string {
  if (url.pathname.includes('/flags')) {
    return JSON.stringify({
      featureFlags: {},
      featureFlagPayloads: {},
      errorsWhileComputingFlags: false,
    });
  }
  if (url.pathname.includes('/config')) return '{}';
  return JSON.stringify({ status: 1 });
}

/** Hold the entry bundle until `release()`, and route every request. */
async function holdScripts(page: Page, origin: string, allowWrite: string): Promise<Guard> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const sent: Guard['sent'] = [];
  const unexpected: string[] = [];
  const analytics: string[] = [];
  const leaks: string[] = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (isPostHog(url)) {
      analytics.push(`${req.method()} ${url.origin}${url.pathname}`);
      const text = analyticsText(req);
      for (const value of TYPED_VALUES) {
        if (text.includes(value)) leaks.push(`${value} in ${req.method()} ${url.pathname}`);
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: analyticsAnswer(url),
      });
    }
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
  return { sent, unexpected, analytics, leaks, release };
}

/** Nothing unexpected was sent, and no PostHog request carried a typed answer. */
function expectClean(guard: Guard): void {
  expect(guard.unexpected, 'no request outside the app, its one write and analytics').toEqual([]);
  expect(guard.leaks, 'no form answer reached analytics').toEqual([]);
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

/** Wait until the app is stable: the recorder has stopped and removed its global. */
async function untilRecorderStopped(page: Page): Promise<void> {
  await page.waitForFunction(() => !('__aeciEarlyInput' in window));
}

async function seriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const ANSWERS = {
  '#claim-name': 'Jane Example',
  '#claim-title': 'Product manager',
  '#claim-email': 'jane@procore.com',
  '#claim-legal-name': 'Procore Technologies, Inc.',
} as const;

const LIST_ANSWERS = {
  '#claim-dialog-listing-name': 'Fixture Planner',
  '#claim-dialog-website': 'https://planner.example.com',
  '#claim-dialog-name': 'Jane Example',
} as const;
const LATE_TITLE = 'Typed after the app took over';

/** Every value a test here types. None may appear in a PostHog request. */
const TYPED_VALUES: readonly string[] = [
  ...Object.values(ANSWERS),
  ...Object.values(LIST_ANSWERS),
  'jane@procore.com',
  'planner.example.com',
  LATE_TITLE,
];

test.describe('early input survives hydration (AECI-1720)', () => {
  for (const r of CLAIM_PAGES) {
    test(`${r.name}: early answers survive; the box waits for the app, then the claim sends`, async ({
      page,
      baseURL,
    }) => {
      const guard = await holdScripts(page, new URL(baseURL!).origin, '/api/requests/claim');
      await openHeld(page, r.path, CLAIM_FORM);

      for (const [id, value] of Object.entries(ANSWERS)) await page.locator(id).fill(value);
      const box = page.locator('#claim-terms');
      await expect(box, 'the consent box is inert before hydration').toBeDisabled();
      await expect(box).not.toBeChecked();
      await expect(page.locator(CLAIM_SUBMIT), 'the SSR submit waits for the app').toBeDisabled();
      // The label's links stay live: the terms open in a new tab without the app.
      await expect(page.locator('label[for="claim-terms"] a')).toHaveAttribute(
        'href',
        '/legal/vendor-terms',
      );

      await hydrate(page, guard, CLAIM_FORM);

      for (const [id, value] of Object.entries(ANSWERS)) {
        await expect(page.locator(id)).toHaveValue(value);
        await expect(page.locator(id)).not.toHaveAttribute('aria-invalid', 'true');
      }
      await expect(box, 'the box is live once the app is').toBeEnabled();
      await expect(box).not.toBeChecked();
      await expect(page.locator(CLAIM_SUBMIT), 'no tick, no submit').toBeDisabled();

      await box.check();
      await expect(page.locator(CLAIM_SUBMIT)).toBeEnabled();
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
      expectClean(guard);
    });

    test(`${r.name}: a consent box is never carried, whatever ticks it before hydration`, async ({
      page,
      baseURL,
    }) => {
      const guard = await holdScripts(page, new URL(baseURL!).origin, '/api/requests/claim');
      await openHeld(page, r.path, CLAIM_FORM);

      // What a script can do to the disabled box, measured in Chromium: box.click() and
      // label.click() do nothing. A dispatched synthetic click still ticks it and fires
      // input and change with isTrusted true. Once the attribute is stripped, box.click()
      // ticks it the same way. The recorder cannot tell these from the visitor, so it
      // keeps no checkbox at all.
      const before = await page.locator('#claim-terms').evaluate((box: HTMLInputElement) => {
        const label = document.querySelector<HTMLLabelElement>('label[for="claim-terms"]')!;
        const trusted: boolean[] = [];
        box.addEventListener('change', (e) => trusted.push(e.isTrusted));
        box.click();
        label.click();
        const afterClicks = box.checked;
        box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        const afterDispatch = box.checked;
        box.checked = false;
        box.removeAttribute('disabled');
        box.click();
        return {
          afterClicks,
          afterDispatch,
          afterEnabledClick: box.checked,
          trustedChange: trusted.length > 0 && trusted.every(Boolean),
        };
      });
      expect(before).toEqual({
        afterClicks: false,
        afterDispatch: true,
        afterEnabledClick: true,
        trustedChange: true,
      });
      // The visitor types an answer and clears it again: the empty value is theirs.
      await page.locator('#claim-name').fill('Jane');
      await page.locator('#claim-name').fill('');

      await hydrate(page, guard, CLAIM_FORM);

      await expect(page.locator('#claim-terms'), 'no tick crosses hydration').not.toBeChecked();
      await expect(page.locator(CLAIM_SUBMIT), 'the box still gates the submit').toBeDisabled();
      await expect(page.locator('#claim-name')).toHaveValue('');
      expect(guard.sent).toEqual([]);
      expectClean(guard);
    });
  }

  test('/vendor-program/list-your-product: early answers survive and focus stays put', async ({
    page,
    baseURL,
  }) => {
    const form = 'form#claim-dialog-form';
    const guard = await holdScripts(page, new URL(baseURL!).origin, '/api/requests/listing');
    await openHeld(page, '/vendor-program/list-your-product', form);

    const early = LIST_ANSWERS;
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
    expectClean(guard);
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
    expectClean(guard);
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
    expectClean(guard);
  });

  test('the recorder stops once the app is stable: no global, nothing kept after', async ({
    page,
    baseURL,
  }) => {
    const guard = await holdScripts(page, new URL(baseURL!).origin, '/api/requests/claim');
    await openHeld(page, CLAIM_PAGES[0].path, CLAIM_FORM);

    const before = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const d = Object.getOwnPropertyDescriptor(window, '__aeciEarlyInput');
      // Keep a handle, to ask the recorder about a later value once it has stopped.
      w['__probe'] = w['__aeciEarlyInput'];
      w['__aeciEarlyInput'] = 'replaced';
      return { writable: d?.writable, kept: w['__aeciEarlyInput'] === w['__probe'] };
    });
    expect(before).toEqual({ writable: false, kept: true });

    await hydrate(page, guard, CLAIM_FORM);
    await untilRecorderStopped(page);

    await page.locator('#claim-title').fill(LATE_TITLE);
    const after = await page.evaluate(() => {
      const probe = (window as unknown as Record<string, { take(el: Element): unknown }>)[
        '__probe'
      ];
      return {
        global: '__aeciEarlyInput' in window,
        kept: probe.take(document.getElementById('claim-title')!) ?? null,
      };
    });
    expect(after).toEqual({ global: false, kept: null });
    expectClean(guard);
  });

  test('the server HTML of a claim page is the same for every visitor, the box disabled', async ({
    request,
  }) => {
    const path = CLAIM_PAGES[0].path;
    // The form counter in Signal Forms' generated `name` differs per render, not per visitor.
    const box = (html: string) =>
      (html.match(/<input[^>]*id="claim-terms"[^>]*>/)?.[0] ?? '').replace(
        /ng\.form\d+\./,
        'ng.form.',
      );
    const plain = await (await request.get(path)).text();
    const withCookies = await (
      await request.get(path, { headers: { cookie: 'aeci_consent=granted; ph_test=1' } })
    ).text();
    expect(box(plain)).toMatch(/\bdisabled=""/);
    expect(box(withCookies)).toBe(box(plain));
  });
});

test.describe('a disabled consent box passes axe (AECI-1720)', () => {
  const SURFACES = [
    { path: CLAIM_PAGES[0].path, form: CLAIM_FORM, write: '/api/requests/claim' },
    {
      path: '/vendor-program/list-your-product',
      form: 'form#claim-dialog-form',
      write: '/api/requests/listing',
    },
  ] as const;
  for (const s of SURFACES) {
    for (const width of [1440, 390]) {
      test(`${s.path} at ${width}px: axe before and after hydration`, async ({ page, baseURL }) => {
        await page.setViewportSize({ width, height: 900 });
        const guard = await holdScripts(page, new URL(baseURL!).origin, s.write);
        await openHeld(page, s.path, s.form);
        expect(await seriousViolations(page), 'before hydration').toEqual([]);
        await hydrate(page, guard, s.form);
        await untilRecorderStopped(page);
        expect(await seriousViolations(page), 'after hydration').toEqual([]);
        expectClean(guard);
      });
    }
  }
});

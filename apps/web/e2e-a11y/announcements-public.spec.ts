/**
 * AECI-1880: status messages and form errors on the signed-out pages.
 *
 * Each test starts the recorder (`support/announcements.ts`) after the hydration
 * gate, takes one action, and asserts what a screen reader would be given: the
 * message heard exactly once, through the channel the page promises, at the
 * politeness it promises. WCAG 4.1.3 and 3.3.1. `docs/TESTING_STRATEGY.md` §8.4.4.
 *
 * A known-failure mark passes on any failure. So a flow with a known barrier is
 * two tests: an unmarked one for everything that works today (the error wiring,
 * the focus move, the stub being hit), and a marked one that holds only the
 * hearing assertion. A broken error link then turns the unmarked test red.
 *
 * No real sends. Every test blocks all writes first (`blockWrites`), then stubs
 * the one write it answers. The magic-link call to Supabase, the subscribe and
 * claim-confirm calls to the API, and the vendor portal's writes never leave the
 * browser.
 */
import { expect, test, type Page } from '@playwright/test';
import { routeFakeAlgolia } from '../e2e/fake-algolia';
import { untilHydrated } from '../e2e/hydration';
import { knownFailure } from './known-failure';
import { browserOf } from './support/browser-expectations';
import {
  blockWrites,
  expectFieldErrorWired,
  flowAnnotations,
  openFlowPage,
  activate,
  stubWrite,
} from './support/announcement-flows';
import {
  describe as describeRecord,
  expectHeardOnce,
  expectNotHeard,
  heard,
  liveRegions,
  recordAnnouncements,
  recordAnnouncementsFromLoad,
  type Announcement,
} from './support/announcements';
import { openSurface, phase2FixturesPresent, surfaceAnnotations } from './support/surface-page';
import { SURFACES, type A11ySurface } from './surfaces';

function surface(id: string): A11ySurface {
  const found = SURFACES.find((s) => s.id === id);
  if (!found) throw new Error(`No manifest surface "${id}"`);
  return found;
}

const LOGIN = surface('login');
const HOME = surface('home');
const PRODUCT = surface('product-detail');

// A known failure that times out turns red, because a timeout is not the failure it
// expects. Pages can take a minute to render on a loaded runner, so allow for it.
test.describe.configure({ timeout: 90_000 });

let fixturesPresent = false;
test.beforeAll(async () => {
  fixturesPresent = await phase2FixturesPresent();
});

/** What a field-error flow saw: the record, the focused field's error, and the writes. */
interface FieldErrorRun {
  readonly record: readonly Announcement[];
  readonly error: string;
  /** Calls that reached the write stub. An invalid submit makes none. */
  readonly stubCalls: number;
  readonly aborted: readonly string[];
}

// --- The on-load recorder itself ------------------------------------------------

test.describe('Announcements: the on-load recorder', () => {
  test(
    'counts a message added before DOMContentLoaded, and refuses a read after a reload',
    surfaceAnnotations(LOGIN),
    async ({ page }) => {
      await blockWrites(page);
      // A stand-in for a banner the app inserts early: an alert added when the
      // document is parsed, before DOMContentLoaded fires.
      await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
          const p = document.createElement('p');
          p.setAttribute('role', 'alert');
          p.textContent = 'AECI-1880 early message';
          document.body.appendChild(p);
        });
      });
      const rec = await recordAnnouncementsFromLoad(page);
      await openSurface(page, LOGIN);
      expectHeardOnce(await rec.read(), 'AECI-1880 early message', 'assertive');

      await page.reload();
      await expect(rec.read(), 'a read from the next document throws').rejects.toThrow(
        /new document/,
      );
    },
  );
});

// --- Login --------------------------------------------------------------------

/** A stub Supabase config, as `e2e/auth-login.spec.ts` plants it. The server's own
 *  inline config wins where `.dev.vars` sets one, so the OTP route below matches any host. */
async function stubSupabaseOtp(page: Page, status: number) {
  await page.addInitScript(() => {
    (window as unknown as { __AECI_SUPABASE__: unknown }).__AECI_SUPABASE__ = {
      url: 'https://stub.supabase.test',
      anonKey: 'e2e-anon-key',
    };
  });
  return stubWrite(page, '**/auth/v1/otp**', {
    status,
    json: status === 200 ? {} : { code: 500, msg: 'stubbed failure' },
  });
}

/** Submit the login form with a bad email. Asserts the focus move and the wiring. */
async function loginBadEmail(page: Page): Promise<FieldErrorRun> {
  const { aborted } = await blockWrites(page);
  const otp = await stubSupabaseOtp(page, 200);
  await openSurface(page, LOGIN);
  const submit = page.getByRole('button', { name: 'Email me a sign-in link' });
  await expect(submit).toBeEnabled();
  const email = page.locator('#login-email');
  await email.fill('not-an-email');

  const rec = await recordAnnouncements(page);
  // AECI-2196: a click here races the error that moves the button, so outside
  // Chromium, whose instant click lands first, this flow presses Enter. The lost
  // click has its own test, the slow press.
  await activate(page, submit, { keyboard: browserOf(page) !== 'chromium' });
  await expect(email).toBeFocused();
  const error = await expectFieldErrorWired(email, /valid email/);
  return { record: await rec.settle(), error, stubCalls: otp.calls, aborted };
}

test.describe('Announcements: login', () => {
  test(
    'a sent link announces "Check your email" once, by focus',
    surfaceAnnotations(LOGIN),
    async ({ page }) => {
      await blockWrites(page);
      const otp = await stubSupabaseOtp(page, 200);
      await openSurface(page, LOGIN);
      const submit = page.getByRole('button', { name: 'Email me a sign-in link' });
      await expect(submit).toBeEnabled();
      await page.locator('#login-email').fill('pm@example.com');

      const rec = await recordAnnouncements(page);
      await activate(page, submit);
      await expect(page.getByRole('heading', { name: 'Check your email' })).toBeFocused();
      const record = await rec.settle();
      expectHeardOnce(record, 'Check your email', 'focus');
      expect(otp.calls).toBe(1);
    },
  );

  test(
    'a failed send announces the error once, as an alert',
    surfaceAnnotations(LOGIN),
    async ({ page }) => {
      await blockWrites(page);
      const otp = await stubSupabaseOtp(page, 500);
      await openSurface(page, LOGIN);
      const submit = page.getByRole('button', { name: 'Email me a sign-in link' });
      await expect(submit).toBeEnabled();
      await page.locator('#login-email').fill('pm@example.com');

      const rec = await recordAnnouncements(page);
      await activate(page, submit);
      await expect(page.getByText('Something went wrong. Please try again.')).toBeVisible();
      const record = await rec.settle();
      expectHeardOnce(record, 'Something went wrong. Please try again.', 'assertive');
      expect(otp.calls).toBe(1);
    },
  );

  test(
    'a bad email is tied to the field, focuses it, and posts nothing',
    surfaceAnnotations(LOGIN),
    async ({ page }) => {
      const run = await loginBadEmail(page);
      expect(run.stubCalls, `an invalid email posts nothing. Aborted: ${run.aborted}`).toBe(0);
    },
  );

  // AECI-2196 (review 4): a person's press, not Playwright's instant click. The
  // mouse goes down on submit, waits 150 ms, as a hand does, then comes up. The
  // first click must submit: the field is focused and nothing is posted. Today
  // the press blurs the field, its error pushes the button down about 29px, and
  // the release misses it. Lost in all three browsers, 9 of 9 on 2026-11-26.
  test(
    'a bad email: a slow press on submit still submits',
    surfaceAnnotations(LOGIN),
    async ({ page }) => {
      await blockWrites(page);
      const otp = await stubSupabaseOtp(page, 200);
      await openSurface(page, LOGIN);
      const submit = page.getByRole('button', { name: 'Email me a sign-in link' });
      await expect(submit).toBeEnabled();
      const email = page.locator('#login-email');
      await email.fill('not-an-email');
      await submit.scrollIntoViewIfNeeded();
      const box = await submit.boundingBox();
      expect(box, 'the submit button has a box').not.toBeNull();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      // Marked only once the setup has passed: a broken setup stays red.
      knownFailure(
        'AECI-2196',
        'the error the press renders on blur moves the submit button, so the click is lost',
      );
      await page.mouse.down();
      await page.waitForTimeout(150);
      await page.mouse.up();
      await expect(email, 'the first press submitted, so the field has focus').toBeFocused();
      expect(otp.calls, 'an invalid email posts nothing').toBe(0);
    },
  );

  test('a bad email is heard once', surfaceAnnotations(LOGIN), async ({ page }) => {
    knownFailure(
      'AECI-2079',
      'the field error is role="alert" and the submit focuses the field it describes, so it is heard twice',
    );
    const run = await loginBadEmail(page);
    expectHeardOnce(run.record, run.error, 'focus');
  });
});

// --- Subscribe and waitlist -----------------------------------------------------

const UPDATES = '/updates';

test.describe('Announcements: subscribe on /updates', () => {
  const join = (page: Page) => page.getByRole('button', { name: 'Join the mailing list' });

  async function openUpdates(page: Page, respond: { status: number; json?: unknown }) {
    await blockWrites(page);
    const sub = await stubWrite(page, '**/api/subscribe', respond);
    await openFlowPage(page, UPDATES);
    await page.getByLabel('Email address').fill('pm@example.com');
    await untilHydrated(join(page));
    await expect(join(page)).toBeEnabled();
    return sub;
  }

  test(
    'a new signup announces "You\'re on the list." once, by focus',
    flowAnnotations('updates', UPDATES),
    async ({ page }) => {
      const sub = await openUpdates(page, { status: 201, json: { created: true } });
      const rec = await recordAnnouncements(page);
      await activate(page, join(page));
      await expect(page.getByRole('heading', { name: "You're on the list." })).toBeFocused();
      expectHeardOnce(await rec.settle(), "You're on the list.", 'focus');
      expect(sub.calls).toBe(1);
    },
  );

  test(
    'an address already on the list is announced once, politely',
    flowAnnotations('updates', UPDATES),
    async ({ page }) => {
      const sub = await openUpdates(page, { status: 200, json: { created: false } });
      const rec = await recordAnnouncements(page);
      await activate(page, join(page));
      await expect(page.getByText("You're already on the list.")).toBeVisible();
      expectHeardOnce(await rec.settle(), "You're already on the list.", 'polite');
      expect(sub.calls).toBe(1);
    },
  );

  test(
    'a failed signup is announced once, politely',
    flowAnnotations('updates', UPDATES),
    async ({ page }) => {
      const sub = await openUpdates(page, { status: 500, json: { error: 'stubbed' } });
      const rec = await recordAnnouncements(page);
      await activate(page, join(page));
      await expect(page.getByText('Something went wrong. Please try again.')).toBeVisible();
      expectHeardOnce(await rec.settle(), 'Something went wrong. Please try again.', 'polite');
      expect(sub.calls).toBe(1);
    },
  );
});

test.describe('Announcements: the mailing-list band', () => {
  const subscribe = (page: Page) =>
    page.locator('aec-mailing-list-signup').getByRole('button', { name: 'Subscribe' });

  async function openBand(page: Page, respond: { status: number; json?: unknown }) {
    test.skip(!fixturesPresent, 'phase2 fixtures not seeded, see the beforeAll warning');
    const { aborted } = await blockWrites(page);
    const sub = await stubWrite(page, '**/api/subscribe', respond);
    await openSurface(page, PRODUCT);
    const email = page.locator('#mailing-list-email');
    await email.scrollIntoViewIfNeeded();
    await untilHydrated(subscribe(page));
    return { sub, email, aborted };
  }

  /** Submit the band with a bad email. Asserts the focus move and the wiring. */
  async function bandBadEmail(page: Page): Promise<FieldErrorRun> {
    const { sub, email, aborted } = await openBand(page, { status: 201, json: { created: true } });
    await email.fill('not-an-email');
    const rec = await recordAnnouncements(page);
    await activate(page, subscribe(page));
    await expect(email).toBeFocused();
    const error = await expectFieldErrorWired(email, /valid email/);
    return { record: await rec.settle(), error, stubCalls: sub.calls, aborted };
  }

  test(
    'a signup on the product page announces once, politely',
    surfaceAnnotations(PRODUCT),
    async ({ page }) => {
      const { sub, email } = await openBand(page, { status: 201, json: { created: true } });
      await email.fill('pm@example.com');
      const rec = await recordAnnouncements(page);
      await activate(page, subscribe(page));
      await expect(
        page.getByText("You're on the list. We'll email when there's something new."),
      ).toBeVisible();
      expectHeardOnce(await rec.settle(), "You're on the list.", 'polite');
      expect(sub.calls).toBe(1);
    },
  );

  test(
    'a bad email is tied to the field, focuses it, and posts nothing',
    surfaceAnnotations(PRODUCT),
    async ({ page }) => {
      const run = await bandBadEmail(page);
      expect(run.stubCalls, `an invalid email posts nothing. Aborted: ${run.aborted}`).toBe(0);
    },
  );

  test('a bad email is heard once', surfaceAnnotations(PRODUCT), async ({ page }) => {
    knownFailure(
      'AECI-2079',
      'the field error is role="alert" and the submit focuses the field it describes, so it is heard twice',
    );
    const run = await bandBadEmail(page);
    expectHeardOnce(run.record, run.error, 'focus');
  });
});

test.describe('Announcements: the waitlist welcome', () => {
  const route = '/?ref=waitlist&token=e2e-token';
  const welcome = "Thanks for waiting. Here's the directory.";

  async function arrive(page: Page) {
    await blockWrites(page);
    const rec = await recordAnnouncementsFromLoad(page);
    await openSurface(page, { ...HOME, route });
    await expect(page.getByRole('region', { name: 'Waitlist welcome' })).toContainText(welcome);
    return rec.settle();
  }

  test('the welcome banner shows on arrival', surfaceAnnotations(HOME), async ({ page }) => {
    await arrive(page);
  });

  test(
    'the welcome banner is announced once on arrival',
    surfaceAnnotations(HOME),
    async ({ page }) => {
      knownFailure(
        'AECI-2080',
        'the banner is added after hydration as a plain region, with no live region and no focus move',
      );
      expectHeardOnce(await arrive(page), welcome, 'polite');
    },
  );
});

// --- Claim confirm --------------------------------------------------------------

const CLAIM_CONFIRM = '/claims/confirm?token=e2e-token';
const CONFIRM_ERROR = 'Something went wrong. Please try again.';

test.describe('Announcements: claim confirm', () => {
  const confirm = (page: Page) => page.getByRole('button', { name: 'Confirm and send' });

  async function openConfirm(page: Page, respond: { status: number; json?: unknown }) {
    await blockWrites(page);
    const call = await stubWrite(page, '**/api/requests/confirm', respond);
    await openFlowPage(page, CLAIM_CONFIRM);
    await untilHydrated(confirm(page));
    return call;
  }

  /** Confirm against a failing stub. Asserts the stub was hit and the error took focus. */
  async function failedConfirm(page: Page) {
    const call = await openConfirm(page, { status: 500, json: { error: 'stubbed' } });
    const rec = await recordAnnouncements(page);
    await activate(page, confirm(page));
    await expect(page.getByText(CONFIRM_ERROR)).toBeFocused();
    expect(call.calls).toBe(1);
    return rec.settle();
  }

  test(
    'a confirmed claim announces "Claim sent" once, by focus',
    flowAnnotations('claim-confirm', CLAIM_CONFIRM),
    async ({ page }) => {
      const call = await openConfirm(page, {
        status: 200,
        json: {
          status: 'confirmed',
          kind: 'claim',
          request_id: '11111111-2222-4333-8444-555555555555',
          routed: false,
          company_name: 'Procore Technologies',
        },
      });
      const rec = await recordAnnouncements(page);
      await activate(page, confirm(page));
      await expect(page.getByRole('heading', { name: 'Claim sent' })).toBeFocused();
      expectHeardOnce(await rec.settle(), 'Claim sent', 'focus');
      expect(call.calls).toBe(1);
    },
  );

  test(
    'a failed confirm shows the error and moves focus to it',
    flowAnnotations('claim-confirm', CLAIM_CONFIRM),
    async ({ page }) => {
      await failedConfirm(page);
    },
  );

  test(
    'a failed confirm announces the error once',
    flowAnnotations('claim-confirm', CLAIM_CONFIRM),
    async ({ page }) => {
      knownFailure(
        'AECI-2079',
        'the error paragraph is role="alert" and also takes focus, so it is heard twice',
      );
      expectHeardOnce(await failedConfirm(page), CONFIRM_ERROR, 'focus');
    },
  );
});

// --- Search ---------------------------------------------------------------------

const SEARCH = '/search';

test.describe('Announcements: search results', () => {
  async function openSearch(page: Page) {
    await blockWrites(page);
    // After `blockWrites`: Algolia queries are POSTs, and this answers them.
    await routeFakeAlgolia(page);
    await openFlowPage(page, SEARCH);
    const box = page.locator('main input[type="search"]');
    await untilHydrated(box);
    // The first answer has landed: the count is on the page.
    await expect(page.locator('aec-search-product-card').first()).toBeVisible({ timeout: 30_000 });
    return box;
  }

  test(
    'a new query announces its result count once, politely',
    flowAnnotations('search', SEARCH),
    async ({ page }) => {
      const box = await openSearch(page);
      const rec = await recordAnnouncements(page);
      await box.fill('Zz Fake Product 01');
      await expect(page.locator('aec-search-product-card')).toHaveCount(10);
      const record = await rec.settle({ quietMs: 1_500 });
      expectHeardOnce(record, /^10 results$/, 'polite');
      const counts = heard(record).filter(
        (a) => a.channel === 'live' && /\bresults?\b/.test(a.text),
      );
      expect(counts, `one count per settled query. Record: ${describeRecord(record)}`).toHaveLength(
        1,
      );
    },
  );

  test(
    'a query with no match announces the zero count once, politely',
    flowAnnotations('search', SEARCH),
    async ({ page }) => {
      const box = await openSearch(page);
      const rec = await recordAnnouncements(page);
      await box.fill('qqq no such product');
      await expect(page.locator('aec-search-product-card')).toHaveCount(0);
      await expect(page.locator('aec-empty-state')).toBeVisible();
      const record = await rec.settle({ quietMs: 1_500 });
      expectHeardOnce(record, /^0 results$/, 'polite');
    },
  );
});

// --- Vendor portal (the ungated preview) ----------------------------------------

/** `/preview/vendor-dashboard` mounts the real portal shell and sections over a
 *  fixture-backed fake API, so it runs with no vendor session. Its writes stay in
 *  memory. The signed-in portal is in `announcements-signed-in.spec.ts`. */
const PREVIEW_INTEGRATION =
  '/preview/vendor-dashboard/products/summit-model-coordination/integrations/00000000-0000-4000-8000-000000005310';

test.describe('Announcements: vendor portal preview', () => {
  const channels = async (page: Page) =>
    (await liveRegions(page)).filter((r) => r.srOnly && r.role === 'status');

  test(
    'a write is announced once by the shell, politely, never as an alert',
    flowAnnotations('vendor-portal-preview', PREVIEW_INTEGRATION),
    async ({ page }) => {
      await blockWrites(page);
      await openFlowPage(page, PREVIEW_INTEGRATION);
      await expect(page.getByTestId('integration-title')).toBeVisible();

      const channel = await channels(page);
      expect(channel, 'the portal shell has exactly one announcement channel').toHaveLength(1);
      expect(channel[0]!.politeness).toBe('polite');

      const yes = page.getByTestId('yes-models');
      await untilHydrated(yes);
      const rec = await recordAnnouncements(page);
      await activate(page, yes);
      await expect(page.getByTestId('answer-models')).toContainText('Yes');
      const record = await rec.settle();
      expectHeardOnce(record, 'Models: you said this is right.', 'polite');
      const assertive = heard(record).filter(
        (a) => a.channel === 'live' && a.politeness === 'assertive',
      );
      expect(
        assertive,
        `a portal write is never an alert. Record: ${describeRecord(record)}`,
      ).toEqual([]);
      expect(await channels(page), 'still one channel after the write').toHaveLength(1);
    },
  );

  test(
    'with one section open, a write in another section is announced once by the shell',
    flowAnnotations('vendor-portal-preview', PREVIEW_INTEGRATION),
    async ({ page }) => {
      await blockWrites(page);
      await openFlowPage(page, PREVIEW_INTEGRATION);
      await expect(page.getByTestId('integration-title')).toBeVisible();

      // Open a change request in the Overview section and leave it open.
      const request = page.getByTestId('request-name');
      await untilHydrated(request);
      await request.click();
      const form = page.getByTestId('request-form');
      await expect(form).toBeVisible();

      // Then answer a row in the "Data that's shared" section.
      const yes = page.getByTestId('yes-models');
      await untilHydrated(yes);
      const rec = await recordAnnouncements(page);
      await activate(page, yes);
      await expect(page.getByTestId('answer-models')).toContainText('Yes');
      const record = await rec.settle();
      expectHeardOnce(record, 'Models: you said this is right.', 'polite');
      const assertive = heard(record).filter(
        (a) => a.channel === 'live' && a.politeness === 'assertive',
      );
      expect(assertive, `never an alert. Record: ${describeRecord(record)}`).toEqual([]);
      await expect(form, 'the open form is still open').toBeVisible();
      expect(await channels(page), 'still one channel').toHaveLength(1);
    },
  );
});

// --- Form errors on a multi-field form -------------------------------------------

const CLAIM_FORM = `/products/fixture-procore/claim`;

test.describe('Announcements: form errors on the claim form', () => {
  /** Submit the empty claim form. Asserts focus on the first field and the wiring of two errors. */
  async function emptyClaim(page: Page) {
    test.skip(!fixturesPresent, 'phase2 fixtures not seeded, see the beforeAll warning');
    const { aborted } = await blockWrites(page);
    const claim = await stubWrite(page, '**/api/requests/claim', { status: 201, json: {} });
    await openFlowPage(page, CLAIM_FORM);
    const submit = page.locator('[data-testid="page-canvas"] form button[type="submit"]');
    // The terms box gates the button (VENDOR_SIGNUP_PROCESS.md section 4).
    await page.locator('#claim-terms').check();
    await expect(submit).toBeEnabled();
    await untilHydrated(submit);

    const rec = await recordAnnouncements(page);
    await activate(page, submit);
    const name = page.locator('#claim-name');
    await expect(name).toBeFocused();
    const nameError = await expectFieldErrorWired(name, /\S/);
    const emailError = await expectFieldErrorWired(page.locator('#claim-email'), /\S/);
    return { record: await rec.settle(), nameError, emailError, claim, aborted };
  }

  test(
    'a bad submit wires the errors, focuses the first field, and posts nothing',
    flowAnnotations('product-claim', CLAIM_FORM),
    async ({ page }) => {
      const run = await emptyClaim(page);
      expect(run.claim.calls, `an invalid form posts nothing. Aborted: ${run.aborted}`).toBe(0);
    },
  );

  test(
    "a bad submit speaks only the focused field's error",
    flowAnnotations('product-claim', CLAIM_FORM),
    async ({ page }) => {
      knownFailure(
        'AECI-1859',
        'every field error is role="alert", so a submit that reveals several speaks them all, not the focused field\'s',
      );
      const run = await emptyClaim(page);
      expectHeardOnce(run.record, run.nameError, 'focus');
      expectNotHeard(run.record, run.emailError);
    },
  );
});

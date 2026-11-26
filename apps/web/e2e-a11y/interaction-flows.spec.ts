/**
 * AECI-1882 check 7: error prevention (WCAG 3.3.4). The claim, checkout,
 * delete-account and moderation flows each have a confirm or review step before
 * the write that commits them.
 *
 * Each test proves the step is there and stops on it. None completes a write
 * against a real endpoint:
 *
 *   - `blockWrites` (`support/announcement-flows.ts`) runs first and aborts every
 *     request that is not a read, on any origin. A stub added after it answers
 *     the one write a test means to send. Nothing reaches the network.
 *   - The claim form's submit is answered by a stub, and the confirm page is only
 *     loaded: its "Confirm and send" is never pressed.
 *   - Checkout never presses "Continue to Stripe" or the add dialog's submit.
 *     No request goes to Stripe or to the routes that create a Checkout
 *     Session or charge a card. Two reads are answered in the browser so an
 *     owner's card panels render for the member test seat (`billingAsOwner`).
 *   - The account delete dialog is opened and closed with Escape. Its confirm is
 *     never pressed.
 *   - Moderation runs over a stubbed queue list, so no real review is touched.
 *     Reject and remove stop on their confirm. The ban dialog is opened from a
 *     stubbed reject and closed with Escape.
 *
 * `writes` counts every write the page tried, aborted or stubbed, so "nothing
 * was sent yet" is a count of zero. `docs/TESTING_STRATEGY.md` §8.4.7.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { untilAppStable, untilHydrated } from '../e2e/hydration';
import { knownFailure } from './known-failure';
import { FIXTURE, SURFACES, type A11ySurface } from './surfaces';
import {
  blockWrites,
  flowAnnotations,
  openFlowPage,
  stubWrite,
} from './support/announcement-flows';
import { isTelemetryWrite } from './support/interaction-rules';
import {
  openSurface,
  phase2FixturesPresent,
  prepareSurface,
  signInAs,
  surfaceAnnotations,
} from './support/surface-page';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

function surface(id: string): A11ySurface {
  const found = SURFACES.find((s) => s.id === id);
  if (!found) throw new Error(`no surface ${id}`);
  return found;
}

const ACCOUNT = surface('account');
const ADMIN_REVIEWS = surface('admin-reviews');

/** Count every non-telemetry write the page tries, whatever answers it. */
function countWrites(page: Page): { list: string[] } {
  const list: string[] = [];
  page.on('request', (req) => {
    if (READS.has(req.method()) || isTelemetryWrite(req.url())) return;
    list.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });
  return { list };
}

/**
 * Nothing new arrives in a quiet window. A negative assertion: there is no
 * event for "no request was sent".
 */
async function quiet(page: Page): Promise<void> {
  await page.waitForTimeout(1_000);
}

let fixturesPresent = false;
test.beforeAll(async () => {
  fixturesPresent = await phase2FixturesPresent();
});

// ── The claim ──────────────────────────────────────────────────────────────

const CLAIM_FORM = `/products/${FIXTURE.productSlug}/claim`;
const CLAIM_CONFIRM = '/claims/confirm?token=e2e-token';

test.describe('error prevention: the claim', () => {
  test(
    'the claim form sends a request to confirm by email, not the claim',
    flowAnnotations('product-claim', CLAIM_FORM),
    async ({ page }) => {
      test.skip(!fixturesPresent, 'phase2 fixtures not seeded');
      await blockWrites(page);
      const writes = countWrites(page);
      const claim = await stubWrite(page, '**/api/requests/claim', {
        status: 201,
        json: {
          request_id: '11111111-2222-4333-8444-555555555555',
          message: 'Check your email to confirm your claim.',
          confirmation_required: true,
        },
      });
      await openFlowPage(page, CLAIM_FORM);
      await page.locator('#claim-name').fill('A11y Nightly');
      await page.locator('#claim-title').fill('Accessibility check');
      await page.locator('#claim-email').fill('a11y-nightly@example.test');
      await page.locator('#claim-terms').check();
      const submit = page.locator('[data-testid="page-canvas"] form button[type="submit"]');
      await untilHydrated(submit);
      await submit.click();
      await expect.poll(() => claim.calls, { message: 'the submit reached the stub' }).toBe(1);
      await quiet(page);
      expect(writes.list, 'the only write is the claim request, which only emails a link').toEqual([
        'POST /api/requests/claim',
      ]);
      // The receipt names the next step: the emailed link, then "Confirm and send".
      await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
      await expect(page.getByText(/Your claim is not sent until you click it/)).toBeVisible();
    },
  );

  test(
    'the confirm page sends nothing on load and waits for "Confirm and send"',
    flowAnnotations('claim-confirm', CLAIM_CONFIRM),
    async ({ page }) => {
      await blockWrites(page);
      const writes = countWrites(page);
      await openFlowPage(page, CLAIM_CONFIRM);
      const confirm = page.getByRole('button', { name: 'Confirm and send' });
      await expect(confirm).toBeVisible();
      await quiet(page);
      expect(writes.list, 'loading the confirm page sends nothing').toEqual([]);
    },
  );
});

// ── Checkout ───────────────────────────────────────────────────────────────

const BILLING = `/vendor/${FIXTURE.vendorSlug}/billing`;

/**
 * The billing tab as an owner seat sees it, with the card panels on.
 *
 * The vendor test account is a member seat, and the local API has no Stripe
 * key, so neither panel would render. Three reads are answered in the browser:
 * the page itself, whose transfer state carries `GET /api/vendor/me`, with
 * `seat_owner` set; `GET /api/vendor/billing`, a small account with Stripe on;
 * and the empty list of accepted agreements. The guard still aborts every
 * write, and the API would refuse a member's write anyway.
 */
async function billingAsOwner(page: Page, stripe: unknown): Promise<void> {
  // The tab's other owner-only read: no agreements accepted yet.
  await page.route(
    (url) => url.pathname === '/api/vendor/billing/acceptances',
    async (route: Route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({ json: { acceptances: [] } });
    },
  );
  // The server renders the portal with the seat in the transfer state, so the
  // browser never asks for it again. Flip that one flag in the local SSR answer.
  await page.route(
    (url) => url.pathname === BILLING,
    async (route: Route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const real = await route.fetch();
      const html = await real.text();
      expect(html, 'the transfer state carries the seat').toContain('"seat_owner":false');
      await route.fulfill({
        response: real,
        body: html.replace('"seat_owner":false', '"seat_owner":true'),
      });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/vendor/billing',
    async (route: Route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({
        json: {
          billing_account: {
            id: '00000000-0000-4000-8000-0000000a1882',
            billing_email: 'billing@example.test',
          },
          licenses: [],
          licenses_truncated: false,
          assignable_products: [],
          pool_count: 0,
          stripe,
          stripe_checkout_available: true,
          stripe_customer: stripe !== null,
          legal_name: 'Fixture Procore Technologies, Inc.',
          checkout_signer_title: null,
          pending_grants: [],
        },
      });
    },
  );
}

test.describe('error prevention: checkout', () => {
  test.beforeEach(async ({ context }) => {
    test.skip(!fixturesPresent, 'phase2 fixtures not seeded');
    await signInAs(context, 'vendor');
  });

  test(
    'Pay by card continues to Stripe, where the plan is reviewed and accepted',
    flowAnnotations('vendor-billing', BILLING),
    async ({ page }) => {
      await blockWrites(page);
      const writes = countWrites(page);
      await billingAsOwner(page, null);
      await openFlowPage(page, BILLING);
      const panel = page.getByTestId('billing-stripe-panel');
      await expect(panel).toBeVisible();
      // The submit opens Stripe's page and charges nothing. It is never pressed here.
      await expect(page.getByTestId('stripe-checkout')).toHaveText(/Continue to Stripe/);
      await expect(panel.getByText(/On the Stripe page you accept/)).toBeVisible();
      await quiet(page);
      expect(writes.list, 'nothing is sent before the reader acts').toEqual([]);
    },
  );

  test(
    'Add subscriptions charges only from its dialog, which states the charge',
    flowAnnotations('vendor-billing', BILLING),
    async ({ page }) => {
      await blockWrites(page);
      const writes = countWrites(page);
      await billingAsOwner(page, {
        interval: 'year',
        quantity: 1,
        current_period_end: '2027-11-24T00:00:00.000Z',
        cancel_at_period_end: false,
        synced: false,
      });
      await openFlowPage(page, BILLING);
      const open = page.getByTestId('stripe-add-open');
      await untilHydrated(open);
      await open.click();
      const dialog = page.getByTestId('stripe-add-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/charges your card now/)).toBeVisible();
      await expect(dialog.getByTestId('stripe-add-submit')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
      await quiet(page);
      expect(writes.list, 'opening the dialog sends nothing').toEqual([]);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      expect(writes.list, 'closing it sends nothing').toEqual([]);
    },
  );
});

// ── Account delete ─────────────────────────────────────────────────────────

test(
  'error prevention: account delete opens a dialog, and only its confirm deletes',
  surfaceAnnotations(ACCOUNT),
  async ({ page, context }) => {
    await prepareSurface(context, ACCOUNT, fixturesPresent);
    await blockWrites(page);
    const writes = countWrites(page);
    await openSurface(page, ACCOUNT);
    const trigger = page.getByRole('button', { name: 'Delete account', exact: true });
    await trigger.scrollIntoViewIfNeeded();
    await untilHydrated(trigger);
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Delete my account' })).toBeVisible();
    await quiet(page);
    expect(writes.list, 'opening the dialog deletes nothing').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(writes.list, 'closing it deletes nothing').toEqual([]);
  },
);

// ── Moderation ─────────────────────────────────────────────────────────────

const REVIEW_ID = '00000000-0000-4000-8000-0000000a1882';

/** One review shaped as `AdminReviewSchema`, in the status the queue asked for. */
function stubReview(status: string) {
  return {
    id: REVIEW_ID,
    product: {
      id: '00000000-0000-4000-8000-0000000b1882',
      name: 'Fixture Procore',
      slug: 'fixture-procore',
    },
    reviewer_email: 'reviewer@example.test',
    reviewer_firm: 'Example Builders',
    rating_overall: 4,
    rating_onboarding: 3,
    title: 'A stub review for the error prevention check',
    body: 'This review is answered by a stub, so no real review is moderated.',
    role_at_company: null,
    years_using: null,
    would_recommend: 'yes',
    locale: 'en-US',
    status,
    toxicity_score: null,
    rejection_reason: null,
    moderated_at: status === 'pending' ? null : '2026-11-20T00:00:00.000Z',
    created_at: '2026-11-01T00:00:00.000Z',
  };
}

/** The queue's list read answers one stub review in whatever status the tab asks for. */
async function stubQueue(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/admin/reviews',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const status = new URL(route.request().url()).searchParams.get('status') ?? 'pending';
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ data: [stubReview(status)], page: 1, perPage: 50, total: 1 }),
      });
    },
  );
}

test.describe('error prevention: moderation', () => {
  test.beforeEach(async ({ context }) => {
    await prepareSurface(context, ADMIN_REVIEWS, fixturesPresent);
  });

  test(
    'reject asks for a reason and a "Confirm rejection" before it sends',
    surfaceAnnotations(ADMIN_REVIEWS),
    async ({ page }) => {
      await blockWrites(page);
      const writes = countWrites(page);
      await stubQueue(page);
      await openSurface(page, ADMIN_REVIEWS);
      const reject = page.getByRole('button', { name: 'Reject', exact: true });
      await untilHydrated(reject);
      await reject.click();
      await expect(page.getByRole('button', { name: 'Confirm rejection' })).toBeVisible();
      await quiet(page);
      expect(writes.list, 'opening the reject form sends nothing').toEqual([]);
    },
  );

  test(
    'remove asks for a reason, then "Remove permanently", before it sends',
    surfaceAnnotations(ADMIN_REVIEWS),
    async ({ page }) => {
      await blockWrites(page);
      const writes = countWrites(page);
      await stubQueue(page);
      await openSurface(page, ADMIN_REVIEWS);
      const approvedTab = page.getByRole('button', { name: 'Approved', exact: true });
      await untilHydrated(approvedTab);
      await approvedTab.click();
      const remove = page.getByRole('button', { name: 'Remove from the page' });
      await expect(remove).toBeVisible();
      await remove.click();
      await page
        .getByRole('textbox', { name: /Why you are removing it/ })
        .fill('AECI-1882 error prevention check');
      await page.getByRole('button', { name: 'Continue to removal' }).click();
      await expect(page.getByText('Remove this review permanently?')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Remove permanently' })).toBeVisible();
      await quiet(page);
      expect(writes.list, 'the first submit only shows the confirm').toEqual([]);
    },
  );

  test(
    'a ban opens a dialog that asks for a reason and "Confirm ban"',
    surfaceAnnotations(ADMIN_REVIEWS),
    async ({ page }) => {
      await blockWrites(page);
      const writes = countWrites(page);
      await stubQueue(page);
      // The reject that raises "Consider a ban" is answered by a stub.
      await page.route(`**/api/admin/reviews/${REVIEW_ID}`, async (route) => {
        if (route.request().method() !== 'PATCH') return route.fallback();
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            review: stubReview('rejected'),
            repeat_offender: {
              reviewer_id: '00000000-0000-4000-8000-0000000c1882',
              reviewer_email: 'repeat-offender@example.test',
              rejected_count: 3,
            },
          }),
        });
      });
      await openSurface(page, ADMIN_REVIEWS);
      const reject = page.getByRole('button', { name: 'Reject', exact: true });
      await untilHydrated(reject);
      await reject.click();
      await page
        .getByRole('textbox', { name: 'Reason for rejection' })
        .fill('AECI-1882 error prevention check');
      await page.getByRole('button', { name: 'Confirm rejection' }).click();
      const open = page.getByRole('button', { name: 'Ban reviewer' });
      await expect(open).toBeVisible();
      await open.click();
      // The dialog's role sits on a wrapper with no box of its own, so the check
      // reads its title and its confirm.
      await expect(page.getByRole('heading', { name: 'Ban this reviewer?' })).toBeVisible();
      const confirm = page.getByRole('button', { name: 'Confirm ban' });
      await expect(confirm).toBeVisible();
      await quiet(page);
      expect(writes.list, 'only the stubbed reject was sent, no ban').toEqual([
        `PATCH /api/admin/reviews/${REVIEW_ID}`,
      ]);
      await page.keyboard.press('Escape');
      await expect(confirm).toBeHidden();
      await untilAppStable(page);
    },
  );

  // AECI-2121: Chris ruled on 2026-11-26 that Approve must confirm before it
  // sends. Today one click sends it, so this is a known barrier until the fix.
  test(
    'approve has a confirm step before it sends',
    surfaceAnnotations(ADMIN_REVIEWS),
    async ({ page }) => {
      await blockWrites(page);
      const writes = countWrites(page);
      await stubQueue(page);
      const approve = await stubWrite(page, `**/api/admin/reviews/${REVIEW_ID}`, {
        status: 200,
        json: { review: stubReview('approved'), repeat_offender: null },
      });
      await openSurface(page, ADMIN_REVIEWS);
      const button = page.getByRole('button', { name: 'Approve', exact: true });
      await untilHydrated(button);
      // Marked only once the setup has passed: a broken setup stays red.
      knownFailure(
        'AECI-2121',
        'one click on Approve sends the approve, with no confirm step (ruled 2026-11-26)',
      );
      await button.click();
      await quiet(page);
      expect(approve.calls, 'one click on Approve sent the approve, with no confirm').toBe(0);
      expect(writes.list).toEqual([]);
      // Nothing sent is not enough: a dead Approve button sends nothing too. The
      // click must open a confirm step. The dialog role sits on a wrapper with no
      // box (as the ban dialog's does), so the check reads a confirm control in it.
      await expect(
        page
          .getByRole('dialog')
          .or(page.getByRole('alertdialog'))
          .getByRole('button', { name: /approve|confirm/i }),
        'the click on Approve opens a confirm step',
      ).toBeVisible();
    },
  );
});

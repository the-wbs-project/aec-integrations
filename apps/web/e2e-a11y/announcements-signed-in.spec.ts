/**
 * AECI-1880: status messages and form errors on the signed-in surfaces: review
 * submission, the account page, the two admin queues and the vendor portal.
 * The method is `announcements-public.spec.ts`'s, including the split of a flow
 * with a known barrier into an unmarked test and a marked hearing test.
 * `docs/TESTING_STRATEGY.md` §8.4.4.
 *
 * Each test signs in as its surface's persona (`prepareSurface`) and skips when
 * that session cannot be minted. No test reaches another route to a session.
 *
 * No real writes. `blockWrites` aborts every request that is not a read, so the
 * shared test accounts cannot be changed, deleted or signed out, and no review or
 * moderation decision is stored. Each test then stubs the one write it answers.
 * The account delete is confirmed only against a stubbed `DELETE /api/account`:
 * the handler, which erases the account and emails the person, is never reached.
 * The sign-out that follows a stubbed delete is aborted too, so the test
 * account's session stays valid. The admin tests stub the queue's list read, and
 * the approve, so no review is moderated.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { untilHydrated } from '../e2e/hydration';
import { knownFailure } from './known-failure';
import {
  blockWrites,
  expectFieldErrorWired,
  activate,
  stubWrite,
} from './support/announcement-flows';
import {
  describe as describeRecord,
  expectHeardOnce,
  heard,
  liveRegions,
  recordAnnouncements,
  recordAnnouncementsFromLoad,
} from './support/announcements';
import {
  openSurface,
  phase2FixturesPresent,
  prepareSurface,
  surfaceAnnotations,
} from './support/surface-page';
import { SURFACES, type A11ySurface } from './surfaces';

function surface(id: string): A11ySurface {
  const found = SURFACES.find((s) => s.id === id);
  if (!found) throw new Error(`No manifest surface "${id}"`);
  return found;
}

const REVIEW = surface('review-submission');
const ACCOUNT = surface('account');
const ADMIN_REVIEWS = surface('admin-reviews');
const ADMIN_REQUESTS = surface('admin-requests');
const VENDOR_INTEGRATIONS = surface('vendor-integrations');

// A known failure that times out turns red, because a timeout is not the failure it
// expects. Pages can take a minute to render on a loaded runner, so allow for it.
test.describe.configure({ timeout: 90_000 });

let fixturesPresent = false;
test.beforeAll(async () => {
  fixturesPresent = await phase2FixturesPresent();
});

// --- Review submission ----------------------------------------------------------

test.describe('Announcements: review submission', () => {
  const submit = (page: Page) => page.getByRole('button', { name: 'Submit review' });

  /** Submit the empty form. Asserts focus in the first rating and the wiring of two errors. */
  async function emptySubmit(page: Page) {
    const { aborted } = await blockWrites(page);
    const post = await stubWrite(page, '**/api/reviews', { status: 201, json: {} });
    await openSurface(page, REVIEW);
    await untilHydrated(submit(page));

    const rec = await recordAnnouncements(page);
    await activate(page, submit(page));
    const overall = page.locator('ul[aria-labelledby="overall-label"]');
    await expect(overall.locator('[role="option"]:focus')).toHaveCount(1);
    const overallError = await expectFieldErrorWired(overall, /\S/);
    const titleError = await expectFieldErrorWired(page.locator('#review-title-input'), /\S/);
    return { record: await rec.settle(), overallError, titleError, post, aborted };
  }

  test(
    'a sent review announces "Review received" once, by focus',
    surfaceAnnotations(REVIEW),
    async ({ page, context }) => {
      await prepareSurface(context, REVIEW, fixturesPresent);
      await blockWrites(page);
      const post = await stubWrite(page, '**/api/reviews', {
        status: 201,
        json: { id: 'rev-a11y-nightly', status: 'pending', message: 'ok' },
      });
      await openSurface(page, REVIEW);
      await untilHydrated(submit(page));
      await page.locator('ul[aria-labelledby="overall-label"] [role="option"]').nth(3).click();
      await page.locator('ul[aria-labelledby="onboarding-label"] [role="option"]').nth(4).click();
      await page.locator('#review-title-input').fill('Reliable Revit connector');
      await page
        .locator('#review-body')
        .fill(
          'We rolled this out across three offices and the model sync held up under heavy load. ' +
            'Onboarding took a couple of calls but support was responsive.',
        );

      const rec = await recordAnnouncements(page);
      await activate(page, submit(page));
      await expect(page.getByRole('heading', { name: 'Review received' })).toBeFocused();
      expectHeardOnce(await rec.settle(), 'Review received', 'focus');
      expect(post.calls).toBe(1);
    },
  );

  test(
    'an empty submit wires the errors, focuses the first rating, and posts nothing',
    surfaceAnnotations(REVIEW),
    async ({ page, context }) => {
      await prepareSurface(context, REVIEW, fixturesPresent);
      const run = await emptySubmit(page);
      expect(run.post.calls, `an invalid review posts nothing. Aborted: ${run.aborted}`).toBe(0);
    },
  );

  test(
    "an empty submit speaks only the focused rating's error",
    surfaceAnnotations(REVIEW),
    async ({ page, context }) => {
      await prepareSurface(context, REVIEW, fixturesPresent);
      knownFailure(
        'AECI-1859',
        'every field error is role="alert", so the empty submit speaks all four errors, not the focused rating\'s',
      );
      const run = await emptySubmit(page);
      expectHeardOnce(run.record, run.overallError, 'focus');
      const others = heard(run.record).filter(
        (a) =>
          a.channel === 'live' && (a.text.includes(run.titleError) || a.politeness === 'assertive'),
      );
      expect(
        others,
        `only the focused field's error is spoken. Record: ${describeRecord(run.record)}`,
      ).toEqual([]);
    },
  );
});

// --- Account --------------------------------------------------------------------

test.describe('Announcements: account', () => {
  const deleteTrigger = (page: Page) =>
    page.getByRole('button', { name: 'Delete account', exact: true });
  const deleteDialog = (page: Page) => page.getByRole('dialog', { name: 'Delete your account?' });

  /** Save a display name against a stub. Asserts the stub was hit and the message shows. */
  async function saveName(page: Page) {
    await blockWrites(page);
    // Answer the PATCH with the profile as it stands, read from the local API.
    let patches = 0;
    await page.route('**/api/account', async (route: Route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      patches++;
      const current = await page.request.get(route.request().url());
      await route.fulfill({ response: current });
    });
    await openSurface(page, ACCOUNT);
    const name = page.locator('#account-display-name');
    await expect(name).toBeVisible();
    await name.fill('A11y Nightly Reviewer');
    const save = page.getByRole('button', { name: 'Save', exact: true });
    await untilHydrated(save);

    const rec = await recordAnnouncements(page);
    await activate(page, save);
    await expect(page.getByText('Display name updated.')).toBeVisible();
    expect(patches, 'the save reached the stub, once').toBe(1);
    return rec.settle();
  }

  /** Open the delete dialog with its confirm answered by `status`. */
  async function openDelete(page: Page, status: number) {
    const { aborted } = await blockWrites(page);
    const del = await stubWrite(page, '**/api/account', { status, json: {} });
    await openSurface(page, ACCOUNT);
    const trigger = deleteTrigger(page);
    await trigger.scrollIntoViewIfNeeded();
    await untilHydrated(trigger);
    await trigger.click();
    await expect(deleteDialog(page)).toBeVisible();
    const confirm = deleteDialog(page).getByRole('button', { name: 'Delete my account' });
    await expect(confirm).toBeEnabled();
    return { del, confirm, aborted };
  }

  test(
    'a display-name save reaches the stub and shows its message',
    surfaceAnnotations(ACCOUNT),
    async ({ page, context }) => {
      await prepareSurface(context, ACCOUNT, fixturesPresent);
      await saveName(page);
    },
  );

  test(
    'a saved display name is announced once, politely',
    surfaceAnnotations(ACCOUNT),
    async ({ page, context }) => {
      await prepareSurface(context, ACCOUNT, fixturesPresent);
      knownFailure(
        'AECI-1858',
        'the "Display name updated." status is inserted with its text already in it',
      );
      expectHeardOnce(await saveName(page), 'Display name updated.', 'polite');
    },
  );

  test(
    'the delete dialog takes focus on open and gives it back on Escape',
    surfaceAnnotations(ACCOUNT),
    async ({ page, context }) => {
      await prepareSurface(context, ACCOUNT, fixturesPresent);
      await blockWrites(page);
      await openSurface(page, ACCOUNT);
      const trigger = deleteTrigger(page);
      await trigger.scrollIntoViewIfNeeded();
      await untilHydrated(trigger);

      const rec = await recordAnnouncements(page);
      await activate(page, trigger);
      const dialog = deleteDialog(page);
      await expect(dialog).toBeVisible();
      await expect
        .poll(() => dialog.evaluate((d) => d.contains(document.activeElement)), {
          message: 'focus moves into the dialog',
        })
        .toBe(true);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      const record = await rec.settle();
      const live = heard(record).filter((a) => a.channel === 'live');
      expect(
        live,
        `opening and closing the dialog says nothing through a live region. Record: ${describeRecord(record)}`,
      ).toEqual([]);
    },
  );

  test(
    'a failed delete is announced once in the dialog, as an alert',
    surfaceAnnotations(ACCOUNT),
    async ({ page, context }) => {
      await prepareSurface(context, ACCOUNT, fixturesPresent);
      const { del, confirm } = await openDelete(page, 500);
      const rec = await recordAnnouncements(page);
      await activate(page, confirm);
      await expect(
        deleteDialog(page).getByText('Something went wrong. Please try again.'),
      ).toBeVisible();
      expectHeardOnce(await rec.settle(), 'Something went wrong. Please try again.', 'assertive');
      expect(del.calls, 'the confirm reached the stub, once').toBe(1);
      await expect(deleteDialog(page), 'the dialog stays open for a retry').toBeVisible();
    },
  );

  test(
    'a delete the stub accepts leaves for the home page',
    surfaceAnnotations(ACCOUNT),
    async ({ page, context }) => {
      await prepareSurface(context, ACCOUNT, fixturesPresent);
      const { del, confirm, aborted } = await openDelete(page, 200);
      await confirm.click();
      await page.waitForURL((url) => url.pathname === '/');
      expect(del.calls, 'the confirm reached the stub, once').toBe(1);
      // The sign-out after a delete is a Supabase write, so the guard aborted it and
      // the shared test account stays signed in.
      expect(aborted.join(' '), 'the sign-out never left the browser').toMatch(/\/logout/);
    },
  );
});

// --- Admin queues: the moderation outcome, and empty, loading and error ----------

const EMPTY_PAGE = { data: [], page: 1, perPage: 50, total: 0 };

/** One pending review, shaped as `AdminReviewSchema`, for the moderation queue's list. */
const PENDING_REVIEW = {
  id: '00000000-0000-4000-8000-0000000a1880',
  product: {
    id: '00000000-0000-4000-8000-0000000b1880',
    name: 'Fixture Procore',
    slug: 'fixture-procore',
  },
  reviewer_email: 'reviewer@example.test',
  reviewer_firm: 'Example Builders',
  rating_overall: 4,
  rating_onboarding: 3,
  title: 'A stub review for the announcement check',
  body: 'This review is answered by a stub. It exists so the approve outcome can be announced.',
  role_at_company: null,
  years_using: null,
  would_recommend: 'yes',
  locale: 'en-US',
  status: 'pending',
  toxicity_score: null,
  rejection_reason: null,
  moderated_at: null,
  created_at: '2026-11-01T00:00:00.000Z',
};

test.describe('Announcements: the moderation outcome', () => {
  test(
    'an approve is announced once, politely',
    surfaceAnnotations(ADMIN_REVIEWS),
    async ({ page, context }) => {
      await prepareSurface(context, ADMIN_REVIEWS, fixturesPresent);
      await blockWrites(page);
      await page.route(
        (url) => url.pathname === '/api/admin/reviews',
        async (route) => {
          if (route.request().method() !== 'GET') return route.fallback();
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ data: [PENDING_REVIEW], page: 1, perPage: 50, total: 1 }),
          });
        },
      );
      const approve = await stubWrite(page, `**/api/admin/reviews/${PENDING_REVIEW.id}`, {
        status: 200,
        json: { review: { ...PENDING_REVIEW, status: 'approved' }, repeat_offender: null },
      });
      await openSurface(page, ADMIN_REVIEWS);
      const button = page.getByRole('button', { name: 'Approve', exact: true });
      await expect(button).toHaveCount(1);
      await untilHydrated(button);

      const rec = await recordAnnouncements(page);
      await activate(page, button);
      await expect(page.getByText(PENDING_REVIEW.title)).toHaveCount(0);
      expectHeardOnce(await rec.settle(), 'Review approved.', 'polite');
      expect(approve.calls, 'the approve reached the stub, once').toBe(1);
    },
  );
});

for (const queue of [
  {
    surface: ADMIN_REVIEWS,
    list: '/api/admin/reviews',
    loading: 'Loading the moderation queue…',
    failed: "We couldn't load the moderation queue.",
    empty: 'No reviews are waiting for moderation.',
  },
  {
    surface: ADMIN_REQUESTS,
    list: '/api/admin/requests',
    loading: 'Loading the requests queue…',
    failed: "We couldn't load the requests queue.",
    empty: 'No requests match this filter.',
  },
] as const) {
  test.describe(`Announcements: ${queue.surface.name}`, () => {
    /** Answer the queue's list read: first with a failure, then with an empty page after a delay. */
    async function routeList(page: Page): Promise<{ calls: number }> {
      const counter = { calls: 0 };
      await page.route(
        (url) => url.pathname === queue.list,
        async (route) => {
          if (route.request().method() !== 'GET') return route.fallback();
          counter.calls++;
          if (counter.calls === 1) {
            await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
            return;
          }
          await new Promise((r) => setTimeout(r, 2_000));
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(EMPTY_PAGE),
          });
        },
      );
      return counter;
    }

    /** Fail the first load, then press Try again. Asserts both reads hit the stub. */
    async function retryToEmpty(page: Page) {
      await blockWrites(page);
      const list = await routeList(page);
      await openSurface(page, queue.surface);
      await expect(page.getByText(queue.failed)).toBeVisible();
      const retry = page.getByRole('button', { name: 'Try again' });
      await untilHydrated(retry);

      const rec = await recordAnnouncements(page);
      await activate(page, retry);
      await expect(page.getByText(queue.empty)).toBeVisible({ timeout: 15_000 });
      expect(list.calls, 'the first load and the retry both reached the stub').toBe(2);
      return rec.settle();
    }

    test(
      'a failed load is announced once, as an alert',
      surfaceAnnotations(queue.surface),
      async ({ page, context }) => {
        await prepareSurface(context, queue.surface, fixturesPresent);
        await blockWrites(page);
        await routeList(page);
        const rec = await recordAnnouncementsFromLoad(page);
        await openSurface(page, queue.surface);
        await expect(page.getByText(queue.failed)).toBeVisible();
        expectHeardOnce(await rec.settle(), queue.failed, 'assertive');
      },
    );

    test(
      'Try again reloads the list and shows the empty queue',
      surfaceAnnotations(queue.surface),
      async ({ page, context }) => {
        await prepareSurface(context, queue.surface, fixturesPresent);
        await retryToEmpty(page);
      },
    );

    test(
      'Try again announces loading, then the empty queue, once each, politely',
      surfaceAnnotations(queue.surface),
      async ({ page, context }) => {
        await prepareSurface(context, queue.surface, fixturesPresent);
        knownFailure(
          'AECI-2082',
          'the loading and empty paragraphs are not live regions, and the Try again button that had focus is removed',
        );
        const record = await retryToEmpty(page);
        expectHeardOnce(record, queue.loading, 'polite');
        expectHeardOnce(record, queue.empty, 'polite');
      },
    );
  });
}

// --- Vendor portal ------------------------------------------------------------------

test.describe('Announcements: vendor portal', () => {
  test(
    'the shell has one polite channel, and it stays the same node across a section change',
    surfaceAnnotations(VENDOR_INTEGRATIONS),
    async ({ page, context }) => {
      await prepareSurface(context, VENDOR_INTEGRATIONS, fixturesPresent);
      await blockWrites(page);
      await openSurface(page, VENDOR_INTEGRATIONS);
      const channels = async () =>
        (await liveRegions(page)).filter((r) => r.srOnly && r.role === 'status');
      const before = await channels();
      expect(before, 'exactly one announcement channel').toHaveLength(1);
      expect(before[0]!.politeness, 'the channel is polite, never assertive').toBe('polite');
      const node = await page.locator('[role="status"].sr-only').elementHandle();

      // The product's own section row (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.11).
      const overview = page
        .getByRole('navigation', { name: /sections$/ })
        .getByRole('link', { name: 'Product Overview', exact: true });
      await untilHydrated(overview);
      const rec = await recordAnnouncements(page);
      await activate(page, overview);
      await expect(overview).toHaveAttribute('aria-current', 'page');
      const record = await rec.settle();
      expect(await channels(), 'still one channel after the section change').toHaveLength(1);
      expect(
        await page.locator('[role="status"].sr-only').evaluate((el, old) => el === old, node),
        'the channel is the same node: the shell outlives the section',
      ).toBe(true);
      const assertive = heard(record).filter(
        (a) => a.channel === 'live' && a.politeness === 'assertive',
      );
      expect(
        assertive,
        `a section change is never an alert. Record: ${describeRecord(record)}`,
      ).toEqual([]);
    },
  );
});

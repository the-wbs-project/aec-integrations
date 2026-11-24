/**
 * AECI-1880: status messages and form errors on the signed-in surfaces: review
 * submission, the account page, the two admin queues and the vendor portal.
 * The method is `announcements-public.spec.ts`'s. `docs/TESTING_STRATEGY.md` §8.4.4.
 *
 * Each test signs in as its surface's persona (`prepareSurface`) and skips when
 * that session cannot be minted. No test reaches another route to a session.
 *
 * No real writes. `blockWrites` aborts every request that is not a read, so the
 * shared test accounts cannot be changed, deleted or signed out, and no review or
 * moderation decision is stored. Each test stubs the one write it answers. The
 * account delete dialog is opened and closed with Escape. It is never confirmed.
 * The admin tests stub only reads, to put the queues in their empty, loading and
 * error states.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { untilHydrated } from '../e2e/hydration';
import { blockWrites, expectFieldErrorWired, stubWrite } from './support/announcement-flows';
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

let fixturesPresent = false;
test.beforeAll(async () => {
  fixturesPresent = await phase2FixturesPresent();
});

// --- Review submission ----------------------------------------------------------

test.describe('Announcements: review submission', () => {
  const submit = (page: Page) => page.getByRole('button', { name: 'Submit review' });

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
      await submit(page).click();
      await expect(page.getByRole('heading', { name: 'Review received' })).toBeFocused();
      expectHeardOnce(await rec.settle(), 'Review received', 'focus');
      expect(post.calls).toBe(1);
    },
  );

  test(
    'an empty submit wires every error, focuses the first, and speaks only its error',
    surfaceAnnotations(REVIEW),
    async ({ page, context }) => {
      await prepareSurface(context, REVIEW, fixturesPresent);
      await blockWrites(page);
      const post = await stubWrite(page, '**/api/reviews', { status: 201, json: {} });
      await openSurface(page, REVIEW);
      await untilHydrated(submit(page));

      const rec = await recordAnnouncements(page);
      await submit(page).click();
      const overall = page.locator('ul[aria-labelledby="overall-label"]');
      await expect(overall.locator('[role="option"]:focus')).toHaveCount(1);
      const overallError = await expectFieldErrorWired(overall, /\S/);
      const titleError = await expectFieldErrorWired(page.locator('#review-title-input'), /\S/);
      const record = await rec.settle();
      expectHeardOnce(record, overallError, 'focus');
      const others = heard(record).filter(
        (a) =>
          a.channel === 'live' && (a.text.includes(titleError) || a.politeness === 'assertive'),
      );
      expect(
        others,
        `only the focused field's error is spoken. Record: ${describeRecord(record)}`,
      ).toEqual([]);
      expect(post.calls, 'an invalid review posts nothing').toBe(0);
    },
  );
});

// --- Account --------------------------------------------------------------------

test.describe('Announcements: account', () => {
  test(
    'a saved display name is announced once, politely',
    surfaceAnnotations(ACCOUNT),
    async ({ page, context }) => {
      await prepareSurface(context, ACCOUNT, fixturesPresent);
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
      await save.click();
      await expect(page.getByText('Display name updated.')).toBeVisible();
      expectHeardOnce(await rec.settle(), 'Display name updated.', 'polite');
      expect(patches).toBe(1);
    },
  );

  test(
    'the delete dialog takes focus on open and gives it back on Escape, never confirmed',
    surfaceAnnotations(ACCOUNT),
    async ({ page, context }) => {
      await prepareSurface(context, ACCOUNT, fixturesPresent);
      await blockWrites(page);
      await openSurface(page, ACCOUNT);
      const trigger = page.getByRole('button', { name: 'Delete account', exact: true });
      await trigger.scrollIntoViewIfNeeded();
      await untilHydrated(trigger);

      const rec = await recordAnnouncements(page);
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Delete your account?' });
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
});

// --- Admin queues: empty, loading and error ---------------------------------------

const EMPTY_PAGE = { data: [], page: 1, perPage: 50, total: 0 };

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
    async function routeList(page: Page): Promise<void> {
      let calls = 0;
      await page.route(
        (url) => url.pathname === queue.list,
        async (route) => {
          if (route.request().method() !== 'GET') return route.fallback();
          calls++;
          if (calls === 1) {
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
      'Try again announces loading, then the empty queue, once each, politely',
      surfaceAnnotations(queue.surface),
      async ({ page, context }) => {
        await prepareSurface(context, queue.surface, fixturesPresent);
        await blockWrites(page);
        await routeList(page);
        await openSurface(page, queue.surface);
        await expect(page.getByText(queue.failed)).toBeVisible();
        const retry = page.getByRole('button', { name: 'Try again' });
        await untilHydrated(retry);

        const rec = await recordAnnouncements(page);
        await retry.click();
        await expect(page.getByText(queue.empty)).toBeVisible({ timeout: 15_000 });
        const record = await rec.settle();
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
        .getByRole('link', { name: 'Overview', exact: true });
      await untilHydrated(overview);
      const rec = await recordAnnouncements(page);
      await overview.click();
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

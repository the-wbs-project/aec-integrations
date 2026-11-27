import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { untilAppStable } from './hydration';

/**
 * AECI-2129: seat "Remove" and invite "Revoke" open an inline confirm in their row, on
 * the ungated dev preview (`/preview/vendor-dashboard/seats`). Each confirm is
 * axe-scanned at 1440, 390 and 320, and neither may scroll the page sideways. The
 * seat confirm sits in a row of the roster table, which scrolls inside its own region
 * below 32rem, so the confirm is pinned to the region's visible width. AECI-2186 gave
 * the claim "Decline" in "Wants to join" the same confirm.
 *
 * NOTHING IS REMOVED OR REVOKED ON A SERVER. The preview's API is an in-page fake that
 * drops the row, so no write leaves the page. Even so, every non-GET to
 * `/api/vendor/seats*` is refused with a 403, and every host but the local stack is
 * aborted (PostHog is answered locally).
 *
 * The full focus contract (Cancel, next, previous, heading, refusal, busy) is in
 * `vendor-seat-roster.component.spec.ts`. This spec checks the rendered surface.
 */
const PATH = '/preview/vendor-dashboard/seats';
const PRIYA = '00000000-0000-4000-8000-0000000052b2';
const BANNED = '00000000-0000-4000-8000-0000000052b3';
const JORDAN = '00000000-0000-4000-8000-0000000052c1';
const AGENCY = '00000000-0000-4000-8000-0000000052c2';
const RILEY = '00000000-0000-4000-8000-0000000052d1';

test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      if (/\/api\/vendor\/seats/.test(url.pathname) && req.method() !== 'GET') {
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

/** Click until the confirm shows: a click between SSR paint and hydration is dropped. */
async function open(page: Page, opener: string, confirm: string): Promise<void> {
  await expect(async () => {
    await page.locator(opener).click();
    await expect(page.locator(confirm)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

async function load(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(PATH);
  await expect(page.locator(`#vendor-seat-remove-start-${PRIYA}`)).toBeVisible({
    timeout: 15_000,
  });
  await untilAppStable(page);
  await unstickSwitcher(page);
}

const CONFIRMS = [
  {
    name: 'seat Remove confirm',
    opener: `#vendor-seat-remove-start-${PRIYA}`,
    confirm: `[data-seat-confirm="${PRIYA}"]`,
    question: `#vendor-seat-remove-confirm-${PRIYA}`,
    yes: 'Remove seat',
  },
  {
    name: 'invite Revoke confirm',
    opener: `#vendor-invite-revoke-start-${JORDAN}`,
    confirm: `[data-invite-confirm="${JORDAN}"]`,
    question: `#vendor-invite-revoke-confirm-${JORDAN}`,
    yes: 'Revoke invite',
  },
  {
    name: 'claim Decline confirm',
    opener: `#vendor-claim-decline-start-${RILEY}`,
    confirm: `[data-claim-confirm="${RILEY}"]`,
    question: `#vendor-claim-decline-confirm-${RILEY}`,
    yes: 'Decline request',
  },
] as const;

for (const width of [1440, 390, 320]) {
  for (const c of CONFIRMS) {
    test(`${c.name} at ${width}px: readable in full, axe clean, no sideways page scroll`, async ({
      page,
    }) => {
      await load(page, width);
      await open(page, c.opener, c.confirm);

      await expect(page.locator(c.question)).toBeFocused();
      const yes = page.locator(c.confirm).getByRole('button', { name: new RegExp(`^${c.yes}`) });
      const cancel = page.locator(c.confirm).getByRole('button', { name: 'Cancel' });
      await expect(yes).toHaveAttribute('data-variant', 'danger');
      await expect(cancel).toHaveAttribute('data-variant', 'secondary');
      // The whole confirm is inside the viewport: the seat one does not ride off
      // with the table's sideways scroll.
      for (const box of [yes, cancel, page.locator(c.question)]) {
        const b = (await box.boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(width);
      }

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth, `${c.name} page width at ${width}px`).toBeLessThanOrEqual(width);
      expect(await axeSerious(page), `${c.name} at ${width}px`).toEqual([]);
    });
  }
}

test('Cancel closes the seat confirm and returns focus to Remove', async ({ page }) => {
  await load(page, 1440);
  await open(page, `#vendor-seat-remove-start-${PRIYA}`, `[data-seat-confirm="${PRIYA}"]`);

  await page
    .locator(`[data-seat-confirm="${PRIYA}"]`)
    .getByRole('button', { name: 'Cancel' })
    .click();

  await expect(page.locator('[data-seat-confirm]')).toHaveCount(0);
  await expect(page.locator(`#vendor-seat-remove-start-${PRIYA}`)).toBeFocused();
});

test('a confirmed removal drops the row, says so and focuses the next Remove', async ({ page }) => {
  await load(page, 1440);
  await open(page, `#vendor-seat-remove-start-${PRIYA}`, `[data-seat-confirm="${PRIYA}"]`);

  await page.getByRole('button', { name: 'Remove seat Priya Natarajan' }).click();

  await expect(page.locator(`[data-seat-row="${PRIYA}"]`)).toHaveCount(0);
  await expect(page.locator('[data-seats-status]')).toHaveText('Seat removed for Priya Natarajan.');
  await expect(page.locator(`#vendor-seat-remove-start-${BANNED}`)).toBeFocused();
});

test('a confirmed revoke drops the invite, says so and focuses the next Revoke', async ({
  page,
}) => {
  await load(page, 1440);
  await open(page, `#vendor-invite-revoke-start-${JORDAN}`, `[data-invite-confirm="${JORDAN}"]`);

  await page.getByRole('button', { name: 'Revoke invite jordan@summitbim.example.com' }).click();

  await expect(page.locator(`[data-invite-row="${JORDAN}"]`)).toHaveCount(0);
  await expect(page.locator('[data-seats-status]')).toHaveText(
    'Invite to jordan@summitbim.example.com revoked.',
  );
  // The next invite's Resend is cooling down (disabled), so its Revoke takes focus.
  await expect(page.locator(`#vendor-invite-revoke-start-${AGENCY}`)).toBeFocused();
});

test('a confirmed decline drops the only claim, says so and focuses the Seats heading', async ({
  page,
}) => {
  await load(page, 1440);
  await open(page, `#vendor-claim-decline-start-${RILEY}`, `[data-claim-confirm="${RILEY}"]`);

  await page.getByRole('button', { name: 'Decline request Riley Chen' }).click();

  await expect(page.getByRole('heading', { name: 'Wants to join' })).toHaveCount(0);
  await expect(page.locator('[data-seats-status]')).toHaveText(
    'Declined the request from Riley Chen.',
  );
  await expect(page.locator('#vendor-seats-heading')).toBeFocused();
});

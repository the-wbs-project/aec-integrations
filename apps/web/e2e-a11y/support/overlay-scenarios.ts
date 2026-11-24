/**
 * AECI-1877: overlays a Tab walk cannot find on a fresh load.
 *
 * Some dialogs open only after an earlier step. Each scenario names the
 * manifest surface it runs on, the routes it needs, and the key presses that
 * bring its trigger into the Tab order. It never confirms a destructive action.
 * `guardWrites` (`./page-guards.ts`) is installed first, so a stray write is
 * aborted anyway.
 */
import { expect, type Page } from '@playwright/test';
import type { OverlayPlan } from './overlay-check';
import { tabWalk, type TabStop } from './tab-walk';

export interface OverlayScenario {
  /** The `A11ySurface.id` it runs on. */
  readonly surfaceId: string;
  readonly name: string;
  /** Install routes before the page loads. */
  prepare(page: Page): Promise<void>;
  /** From a hydrated, fresh page: reach the trigger with real key presses. */
  reach(page: Page): Promise<TabStop>;
  readonly plan: OverlayPlan;
}

/** Walk forward until a stop matches, or fail with what the walk saw. */
async function walkUntil(
  page: Page,
  what: string,
  match: (s: TabStop) => boolean,
): Promise<TabStop> {
  const walk = await tabWalk(page, { until: match });
  const found = walk.stops.at(-1);
  expect(walk.end, `reach ${what} by Tab (walk ended ${walk.end})`).toBe('matched');
  return found!;
}

export const OVERLAY_SCENARIOS: readonly OverlayScenario[] = [
  {
    // AECI-218: the ban dialog opens from the "Consider a ban" banner, which a
    // reject raises when it is the reviewer's third. The reject is stubbed: the
    // queue row stays in the D1, so the next run sees the same page, and no
    // review is moderated. The dialog is closed with Escape, never confirmed.
    surfaceId: 'admin-reviews',
    name: 'the ban dialog',
    async prepare(page) {
      await page.route('**/api/admin/reviews/*', async (route) => {
        if (route.request().method() !== 'PATCH') return route.fallback();
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            review: {},
            repeat_offender: {
              reviewer_id: '00000000-0000-4000-8000-0000000a1877',
              reviewer_email: 'repeat-offender@example.test',
              rejected_count: 3,
            },
          }),
        });
      });
    },
    async reach(page) {
      await walkUntil(
        page,
        'the first Reject button',
        (s) => s.role === 'button' && s.name === 'Reject',
      );
      await page.keyboard.press('Enter');
      await walkUntil(page, 'the rejection reason', (s) => s.role === 'textbox' && s.inMain);
      await page.keyboard.type('AECI-1877 keyboard check');
      await walkUntil(
        page,
        'Confirm rejection',
        (s) => s.role === 'button' && s.name === 'Confirm rejection',
      );
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Ban reviewer' })).toBeVisible();
      return walkUntil(
        page,
        'Ban reviewer',
        (s) => s.role === 'button' && s.name === 'Ban reviewer',
      );
    },
    plan: { kind: 'dialog', open: ['Enter'], focusOnOpen: 'inside', containment: 'trap' },
  },
];

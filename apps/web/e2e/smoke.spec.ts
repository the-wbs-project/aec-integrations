import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Smoke spec for AECI-33 / Phase 1.19.
// Guards: the SSR Worker boots, the Angular shell mounts at `/`, and axe-core
// reports zero violations on the rendered page. New routes should add their
// own spec files; this one stays minimal.

test.describe('home page (smoke)', () => {
  test('renders the shell at /', async ({ page }) => {
    const res = await page.goto('/');
    expect(res, 'GET / must return a response').not.toBeNull();
    expect(res!.status(), 'GET / must return 200').toBe(200);

    // The Angular shell element is in index.html and gets hydrated by the
    // bundle. Its presence proves SSR returned a page with the app root.
    await expect(page.locator('app-root')).toBeAttached();

    // Stable copy seeded by `apps/web/src/app/home/home.ts` until the real
    // home page lands. If/when home content changes, update this assertion.
    await expect(page.getByRole('heading', { name: 'Coming soon' })).toBeVisible();
  });

  test('has no accessibility violations at /', async ({ page }) => {
    await page.goto('/');
    // Wait for Angular hydration to settle before axe runs so the rendered
    // DOM matches what real users see.
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    // Acceptance criteria: smoke spec fails on any axe violation.
    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });
});

function formatViolations(
  violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations'],
): string {
  if (violations.length === 0) return '';
  return violations
    .map(
      (v) =>
        `[${v.impact ?? '?'}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n` +
        v.nodes.map((n) => `  - ${n.target.join(', ')}\n    ${n.failureSummary ?? ''}`).join('\n'),
    )
    .join('\n\n');
}

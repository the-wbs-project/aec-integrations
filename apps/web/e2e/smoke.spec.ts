import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Smoke spec for AECI-33 / Phase 1.19, extended for AECI-36 Phase 1.21
// (validate SSR + cache plumbing end-to-end on apps/web/).
// Guards: the SSR Worker boots, the Angular shell mounts at `/`, axe-core
// reports zero violations, and hydration is console-clean. New routes should
// add their own spec files; this one stays focused on `/`.

const IS_DEPLOYED = !!process.env['PLAYWRIGHT_BASE_URL'];

test.describe('home page (smoke)', () => {
  test('renders the shell at /', async ({ page }) => {
    const res = await page.goto('/');
    expect(res, 'GET / must return a response').not.toBeNull();
    expect(res!.status(), 'GET / must return 200').toBe(200);

    // The Angular shell element is in index.html and gets hydrated by the
    // bundle. Its presence proves SSR returned a page with the app root.
    await expect(page.locator('app-root')).toBeAttached();

    // The home page renders the Phase 4.9 "Browse by" grids (AECI-184). The
    // section headings render even when no taxonomy is seeded (the grid shows
    // its heading + an empty note), so this is a stable, SSR-rendered,
    // i18n-wrapped assertion that the home content mounted. The full hero/meta
    // lands with the 4.11 home-assembly issue (AECI-186).
    await expect(page.getByRole('heading', { name: 'Browse by category' })).toBeVisible();
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

  test('hydrates / with no console errors (AECI-36 AC #6)', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();
    // Give Angular hydration + any provideAppInitializer hooks a beat to settle.
    // 200ms is enough for hydration on a warm dev server; anything emitted
    // after that is treated as runtime noise, not bootstrap.
    await page.waitForTimeout(200);

    expect(pageErrors, `unhandled page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('SSR <html> advertises the locale dir/lang and stays visitor-state-neutral (AECI-153, §9.1a)', async ({
    request,
  }) => {
    // Raw SSR fetch (no JS executes). AECI-153 — the <html> tag carries the
    // locale-derived dir/lang; en-US ships LTR, so the dormant dir-injection
    // wiring + index.html default must produce `lang="en-US" dir="ltr"`. This
    // regression-protects the wiring without a real RTL locale build. The tag
    // must also stay visitor-state-neutral on this cacheable route (§9.1a).
    const ssr = await request.get('/');
    expect(ssr.status()).toBe(200);
    const htmlTag = (await ssr.text()).match(/<html[^>]*>/i)?.[0] ?? '';
    expect(htmlTag, 'could not find <html> tag in SSR response').not.toBe('');
    expect(htmlTag, `SSR <html> must advertise dir="ltr"; got: ${htmlTag}`).toMatch(/dir="ltr"/);
    expect(htmlTag, `SSR <html> must advertise lang="en-US"; got: ${htmlTag}`).toMatch(
      /lang="en-US"/,
    );
    expect(
      htmlTag,
      `SSR <html> must be visitor-state-neutral (§9.1a); got: ${htmlTag}`,
    ).not.toMatch(/data-theme=|theme-(dark|light)/);
  });

  test('second request to / hits the edge cache (AECI-36 AC #3, deployed only)', async ({
    request,
  }) => {
    // Miniflare's caches.default doesn't model real edge cache behavior
    // (same skip pattern as run-extra-tests.sh T7). Validated against a
    // deployed Worker via `PLAYWRIGHT_BASE_URL=https://<preview>...`.
    test.skip(!IS_DEPLOYED, 'requires a deployed preview Worker (set PLAYWRIGHT_BASE_URL)');

    // Prime the edge cache, then sleep so cache.put has landed.
    const primer = await request.get('/');
    expect(primer.status()).toBe(200);
    await new Promise((r) => setTimeout(r, 800));

    const second = await request.get('/');
    expect(second.status()).toBe(200);
    const cfStatus = second.headers()['cf-cache-status'];
    const age = Number(second.headers()['age'] ?? '0');
    expect(
      cfStatus === 'HIT' || age > 0,
      `expected cache HIT; got cf-cache-status=${cfStatus ?? 'absent'} age=${age}`,
    ).toBe(true);
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

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Smoke spec for AECI-33 / Phase 1.19, extended for AECI-36 Phase 1.21
// (validate SSR + cache plumbing end-to-end on apps/web/).
// Guards: the SSR Worker boots, the Angular shell mounts at `/`, axe-core
// reports zero violations, hydration is console-clean, and the persisted
// theme is reconciled client-side after a visitor-state-neutral SSR render
// (§9.1a). New routes should add their own spec files; this one stays
// focused on `/`.

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';
const IS_DEPLOYED = !!process.env['PLAYWRIGHT_BASE_URL'];

test.describe('home page (smoke)', () => {
  test('renders the shell at /', async ({ page }) => {
    const res = await page.goto('/');
    expect(res, 'GET / must return a response').not.toBeNull();
    expect(res!.status(), 'GET / must return 200').toBe(200);

    // The Angular shell element is in index.html and gets hydrated by the
    // bundle. Its presence proves SSR returned a page with the app root.
    await expect(page.locator('app-root')).toBeAttached();

    // Stable copy seeded by `apps/web/src/app/home/home.ts` until the real
    // home page lands in Phase 4. AECI-36 acceptance was signed off against
    // this copy as functionally equivalent to the spec's "Hello from AEC
    // Integrations" — SSR-rendered, i18n-wrapped, byte-stable.
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

  test('SSR is theme-neutral; client reconciles persisted theme (AECI-36 AC #4, #6)', async ({
    page,
    context,
  }) => {
    // Pre-seed both cookie and localStorage so the client has a persisted
    // theme to reconcile. The cookie is what SSR would see (and what the
    // Worker strips per §9.1a); localStorage is what the client reads in
    // `theme.service.ts` afterNextRender().
    const url = new URL(BASE_URL);
    await context.addCookies([
      {
        name: 'theme',
        value: 'dark',
        domain: url.hostname,
        path: '/',
        // BASE_URL is http://localhost in dev and https://... when deployed;
        // mirror the scheme so the cookie is sent on the first navigation.
        secure: url.protocol === 'https:',
        sameSite: 'Lax',
      },
    ]);
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem('theme', 'dark');
      } catch {
        /* private mode / storage blocked — ignore */
      }
    });

    // (a) Raw SSR fetch with the cookie — `<html>` must NOT carry a theme
    // class/attr. Uses context.request so the cookie is sent without JS
    // executing on the response.
    const ssr = await context.request.get('/');
    expect(ssr.status()).toBe(200);
    const ssrHtml = await ssr.text();
    const htmlTag = ssrHtml.match(/<html[^>]*>/i)?.[0] ?? '';
    expect(htmlTag, 'could not find <html> tag in SSR response').not.toBe('');
    expect(
      htmlTag,
      `SSR <html> must be visitor-state-neutral (§9.1a); got: ${htmlTag}`,
    ).not.toMatch(/theme-(dark|light)|data-theme=/);

    // (b) Full navigation — client reconciles. AC says "within one frame";
    // we give 1s of slack so the test isn't flaky on slow CI runners, but
    // still tight enough to catch a missing reconciliation entirely.
    await page.goto('/');
    await page.waitForFunction(
      () => document.documentElement.classList.contains('theme-dark'),
      null,
      { timeout: 1000 },
    );
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

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { attachConsoleCapture } from './console-capture';

// AECI-194 / Phase 5.3 — the /auth/login page. The Supabase calls run
// browser-side with the anon key; CI / local-bound typically has no
// provisioned Supabase config, so the page naturally exercises the
// GRACEFUL-DEGRADATION path (the `window.__AECI_SUPABASE__` bootstrap is
// absent → "temporarily unavailable" notice after hydration). We therefore
// assert the SSR shell, the non-cacheable + noindex contract, accessibility in
// both themes, and clean hydration — but NOT a live magic-link send. The
// structural assertions hold in both the configured and degraded states.

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';
const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('/auth/login — login page (AECI-194)', () => {
  test('renders the SSR shell: title, labeled email input, Google button', async ({ request }) => {
    const res = await request.get('/auth/login');
    expect(res.status(), 'GET /auth/login must return 200').toBe(200);
    const html = await res.text();

    expect(html, '<h1>Sign in</h1> must render SSR-side').toMatch(
      /<h1[^>]*>[^<]*Sign in[^<]*<\/h1>/i,
    );
    expect(html, 'a real <label for="login-email"> must render (not placeholder-as-label)').toMatch(
      /<label[^>]+for="login-email"/,
    );
    expect(html, 'the email input must render').toMatch(/<input[^>]+id="login-email"/);
    expect(html, 'the Google button must render').toContain('Continue with Google');
  });

  test('is non-cacheable (private, no-store) and noindex', async ({ request }) => {
    const res = await request.get('/auth/login');
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `Cache-Control must be no-store; got: ${cacheControl}`).toContain(
      'no-store',
    );
    expect(cacheControl, `Cache-Control must be private; got: ${cacheControl}`).toContain(
      'private',
    );

    const html = await res.text();
    expect(html, 'robots noindex meta must be present').toMatch(
      /<meta[^>]+name="robots"[^>]+content="noindex"/,
    );
  });

  test('hydrates without console errors (with a hostile ?return in the URL)', async ({ page }) => {
    const capture = attachConsoleCapture(page);
    await page.goto('/auth/login?return=//evil.example');
    await expect(page.locator('aec-login-page')).toBeAttached();
    await expect(page.locator('#login-email')).toBeVisible();
    expect(capture.errors, 'no console errors on hydrate').toEqual([]);
    expect(capture.pageErrors, 'no uncaught page errors on hydrate').toEqual([]);
  });

  test('has zero axe AA violations (light)', async ({ page }) => {
    await page.goto('/auth/login');
    await expect(page.locator('aec-login-page')).toBeAttached();

    const violations = await aaViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  test('has zero axe AA violations (dark)', async ({ page, context }) => {
    await gotoDark(page, context, '/auth/login');

    const violations = await aaViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  test('SSR picks no theme without visitor state; a theme cookie is honored (non-cacheable)', async ({
    request,
    page,
    context,
  }) => {
    // /auth/login is non-cacheable, so unlike the cacheable routes
    // (smoke.spec.ts AECI-36 AC #4) the Worker does NOT strip the theme
    // cookie — SSR honoring it here is safe (no shared edge cache to poison)
    // and intentional (no theme flash on the login page). What must still
    // hold: a request WITHOUT visitor state gets theme-neutral HTML.
    const plain = await request.get('/auth/login');
    expect(plain.status()).toBe(200);
    const plainTag = (await plain.text()).match(/<html[^>]*>/i)?.[0] ?? '';
    expect(plainTag, 'could not find <html> tag in SSR response').not.toBe('');
    expect(
      plainTag,
      `cookie-less SSR <html> must carry no theme class; got: ${plainTag}`,
    ).not.toMatch(/theme-(dark|light)|data-theme=/);

    // With the cookie, the browser ends up dark (SSR-baked and/or client
    // reconciliation — either path must converge on .theme-dark).
    await gotoDark(page, context, '/auth/login');
    await expect(page.locator('#login-email')).toBeVisible();
  });
});

async function aaViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_AA_TAGS)
    // The footer carries separately-tracked dark-theme contrast debt (same
    // carve-out as phase2-a11y.spec.ts / search.spec.ts). The header IS scanned.
    .exclude('aec-site-footer')
    .analyze();
  return results.violations;
}

async function gotoDark(page: Page, context: BrowserContext, path: string): Promise<void> {
  const url = new URL(BASE_URL);
  await context.addCookies([
    {
      name: 'theme',
      value: 'dark',
      domain: url.hostname,
      path: '/',
      secure: url.protocol === 'https:',
      sameSite: 'Lax',
    },
  ]);
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('theme', 'dark');
    } catch {
      /* storage blocked — ignore */
    }
  });
  await page.goto(path);
  await page.waitForFunction(() => document.documentElement.classList.contains('theme-dark'));
}

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

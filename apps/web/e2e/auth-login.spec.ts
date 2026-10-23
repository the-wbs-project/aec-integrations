import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { attachConsoleCapture } from './console-capture';

// AECI-194 / Phase 5.3 — the /auth/login page. The Supabase calls run
// browser-side with the anon key; CI / local-bound typically has no
// provisioned Supabase config, so the page naturally exercises the
// GRACEFUL-DEGRADATION path (the `window.__AECI_SUPABASE__` bootstrap is
// absent → "temporarily unavailable" notice after hydration). We therefore
// assert the SSR shell, the non-cacheable + noindex contract, accessibility,
// and clean hydration — but NOT a live magic-link send. The structural
// assertions hold in both the configured and degraded states.
//
// The one exception is the AECI-829 focus test, which plants a stub config with
// `addInitScript` and fulfils the Supabase OTP call with `page.route`, so the
// submit and the "Check your email" swap run without sending a real email.

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

  // AECI-829 (WCAG 4.1.3): the swap destroys the focused submit button. The
  // confirmation heading must take focus, or a screen reader announces nothing.
  test('a sent link moves focus to "Check your email", and back to the field on reset', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as { __AECI_SUPABASE__: unknown }).__AECI_SUPABASE__ = {
        url: 'https://stub.supabase.test',
        anonKey: 'e2e-anon-key',
      };
    });
    // Any host: CI has no config and uses the stub above, but a local run with a
    // configured `.dev.vars` injects the real one after the init script.
    await page.route('**/auth/v1/otp**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );

    await page.goto('/auth/login');
    const email = page.locator('#login-email');
    const submit = page.getByRole('button', { name: 'Email me a sign-in link' });
    // `goto` resolves on the SSR HTML. A fill before hydration never reaches the
    // form model, so the button stays disabled: retry the fill until it enables.
    await expect(async () => {
      await email.fill('pm@example.com');
      await expect(submit).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: 15000 });
    await submit.click();

    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeFocused();
    // The separate axe test only sees the default render; scan the sent state too.
    const violations = await aaViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);

    await page.getByRole('button', { name: 'Use a different email' }).click();
    await expect(email).toBeFocused();
  });

  test('has zero axe AA violations', async ({ page }) => {
    await page.goto('/auth/login');
    await expect(page.locator('aec-login-page')).toBeAttached();

    const violations = await aaViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});

async function aaViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
  return results.violations;
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

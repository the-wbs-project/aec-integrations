import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { attachConsoleCapture } from './console-capture';
import { expectNoSidewaysScroll } from './no-sideways-scroll';

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

    // The heading wraps the site name in a no-wrap span, so match across inner tags.
    expect(html, '<h1>Sign in to AEC Integrations</h1> must render SSR-side').toMatch(
      /<h1[^>]*>\s*Sign in to (?:<[^>]+>)*AEC Integrations(?:<\/[^>]+>)*\s*<\/h1>/i,
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
    // Any host. The Content-Security-Policy allows only the real Supabase host, so this
    // test needs it in `.dev.vars` (CI writes it). A worktree without `.dev.vars` fails here.
    await page.route('**/auth/v1/otp**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );

    await page.goto('/auth/login');
    const email = page.locator('#login-email');
    const submit = page.getByRole('button', { name: 'Email me a sign-in link' });
    // `goto` resolves on the SSR HTML. The button is disabled until hydration
    // (AECI-831), so wait for it before filling: a fill on the SSR HTML never
    // reaches the form model.
    await expect(submit).toBeEnabled({ timeout: 15000 });
    await email.fill('pm@example.com');
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

  // AECI-1805: inside the card at 320px, "Continue with Google" broke onto two lines away
  // from its G mark. The web fonts are blocked and a wide face is forced, so the check
  // holds whatever font the runner falls back to (Verdana is the widest common sans; the
  // generic families cover a runner that has none of the named ones). One page load
  // serves every face: each step removes the previous face's style tag first.
  const FACES = ['Verdana', 'DejaVu Sans', 'Arial', 'sans-serif'];
  test('at 320px "Continue with Google" stays one 44px line beside its mark, in every forced font', async ({
    page,
  }) => {
    await page.route('**/fonts/**', (route) => route.abort());
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/auth/login');
    let faceStyle: Awaited<ReturnType<Page['addStyleTag']>> | null = null;

    for (const face of FACES) {
      await test.step(`at 320px "Continue with Google" stays one 44px line beside its mark (${face})`, async () => {
        await faceStyle?.evaluate((el) => (el as Element).remove());
        faceStyle = await page.addStyleTag({
          content: `body, body * { font-family: "${face}", sans-serif !important; }`,
        });
        const google = page.getByRole('button', { name: 'Continue with Google' });
        await expect(google).toBeVisible();

        const m = await google.evaluate((button) => {
          const label = [...button.querySelectorAll('span')].find((s) =>
            s.textContent?.includes('Google'),
          ) as HTMLElement;
          const mark = button.querySelector('svg') as SVGElement;
          const b = button.getBoundingClientRect();
          const l = label.getBoundingClientRect();
          const g = mark.getBoundingClientRect();
          return {
            buttonH: b.height,
            buttonW: b.width,
            parentW: (button.parentElement as HTMLElement).getBoundingClientRect().width,
            labelH: l.height,
            lineH: parseFloat(getComputedStyle(label).lineHeight),
            labelInside: l.left >= b.left && l.right <= b.right,
            markBesideLabel: g.right <= l.left && g.top < l.bottom && g.bottom > l.top,
          };
        });
        expect(m.labelH, 'the label is one line').toBeLessThanOrEqual(m.lineH + 1);
        expect(m.buttonH).toBeGreaterThanOrEqual(44);
        expect(m.buttonH).toBeLessThanOrEqual(46);
        expect(m.buttonW, 'the button is full width').toBeCloseTo(m.parentW, 0);
        expect(m.labelInside, 'the label stays inside the button').toBe(true);
        expect(m.markBesideLabel, 'the G mark sits beside the label').toBe(true);
        await expectNoSidewaysScroll(page);

        const termsLine = page.getByTestId('login-terms-line');
        await expect(termsLine.getByRole('link', { name: 'Terms of Service' })).toBeVisible();
        await expect(termsLine.getByRole('link', { name: 'Privacy Policy' })).toBeVisible();
      });
    }
  });

  for (const width of [320, 390]) {
    test(`has zero axe AA violations at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/auth/login');
      await expect(page.locator('aec-login-page')).toBeAttached();
      const violations = await aaViolations(page);
      expect(violations, formatViolations(violations)).toEqual([]);
    });
  }
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

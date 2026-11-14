/**
 * AECI-1655: the SSR HTML hydrates, and carries Angular's event-replay contract.
 *
 * Angular stamps `ngSkipHydration` on every component whose template uses
 * `i18n` unless `provideClientHydration(withI18nSupport())` is on. Here that
 * was the header, the footer and every page body. Skipped views were destroyed
 * and re-rendered on the client. No listener was annotated, so the server
 * removed the `#ng-event-dispatch-contract` script and a pre-hydration click
 * was never replayed.
 *
 * Three guards:
 *   - raw HTML (no browser): no `ngskiphydration`, the contract script and its
 *     `__jsaction_bootstrap(` call are present, and listeners carry `jsaction`;
 *   - browser: an SSR-rendered header link is the SAME DOM node after hydration
 *     (a destructive re-render would disconnect it), with no console errors.
 *     The skip used to hide hydration mismatches (NG05xx). Now they would surface;
 *   - browser: a button clicked while the main bundle is held back takes effect
 *     once the app hydrates. Before AECI-1655 that click was dropped;
 *   - browser: a section-nav link clicked before hydration still jumps when it
 *     is clicked again after hydration. An anchor that owns a click listener is
 *     default-prevented on every later click once it took an early one, so
 *     `SectionNav` keeps its listener on the host (`section-nav.ts`).
 */
import { expect, test } from '@playwright/test';

import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';
import { untilHydrated } from './hydration';

// AECI-1687 adds '/accessibility' here when it publishes the statement.
const STATIC_PATHS = ['/', '/about', '/products', '/docs', '/vendor-program'];

async function firstProductSlug(
  request: import('@playwright/test').APIRequestContext,
): Promise<string | null> {
  const res = await request.get('/api/products?perPage=1&page=1');
  if (!res.ok()) return null;
  const body = await res.json();
  const slug = body?.data?.[0]?.slug;
  return typeof slug === 'string' ? slug : null;
}

function expectHydratableHtml(html: string, path: string): void {
  expect(html.toLowerCase(), `${path}: no component may skip hydration`).not.toContain(
    'ngskiphydration',
  );
  expect(html, `${path}: event-dispatch contract script`).toContain(
    'id="ng-event-dispatch-contract"',
  );
  expect(html, `${path}: contract bootstrap call`).toContain('window.__jsaction_bootstrap(');
  expect(html, `${path}: listeners annotated with jsaction`).toMatch(/\sjsaction="/);
}

test.describe('SSR hydration contract (AECI-1655)', () => {
  for (const path of STATIC_PATHS) {
    test(`raw SSR HTML for ${path} is hydratable and carries the replay contract`, async ({
      request,
    }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      expectHydratableHtml(await res.text(), path);
    });
  }

  test('raw SSR HTML for a product detail page is hydratable', async ({ request }) => {
    const slug = await firstProductSlug(request);
    test.skip(slug === null, 'no product in the DB under test');
    const path = `/products/${slug}`;
    const res = await request.get(path);
    expect(res.status()).toBe(200);
    expectHydratableHtml(await res.text(), path);
  });

  test('hydration keeps the SSR header DOM instead of re-rendering it', async ({ page }) => {
    // Grab the first header link the moment the parser creates it, before any
    // app script runs. After hydration it must still be connected.
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      const grab = () => {
        const a = document.querySelector('aec-site-header a[href]');
        if (a && !w['__aeciSsrLink']) w['__aeciSsrLink'] = a;
        return Boolean(a);
      };
      const mo = new MutationObserver(() => {
        if (grab()) mo.disconnect();
      });
      mo.observe(document, { childList: true, subtree: true });
    });

    const capture = attachConsoleCapture(page);
    const res = await page.goto('/about');
    expect(res?.status()).toBe(200);
    await waitForHydrationSettle(page);

    const state = await page.evaluate(() => {
      const a = (window as unknown as Record<string, unknown>)['__aeciSsrLink'] as
        | Element
        | undefined;
      return { captured: Boolean(a), connected: Boolean(a?.isConnected) };
    });
    expect(state.captured, 'an SSR header link was captured during parse').toBe(true);
    expect(state.connected, 'the SSR header link survived hydration').toBe(true);
    expectConsoleClean(capture, 'GET /about');
  });

  test('a button clicked before hydration is replayed after it', async ({ page }) => {
    // The mobile menu toggle only renders below `lg`.
    await page.setViewportSize({ width: 390, height: 800 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Hold the main bundle back so the click lands on SSR HTML with no listener.
    await page.route(/\/main-[A-Z0-9]+\.js$/, async (route) => {
      await gate;
      await route.continue();
    });

    await page.goto('/about', { waitUntil: 'commit' });
    const trigger = page.locator('aec-site-header [data-nav-menu-toggle]');
    await trigger.waitFor({ state: 'attached' });
    await expect(trigger).toHaveAttribute('jsaction', /click/);
    await trigger.click({ force: true, noWaitAfter: true });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    release();
    await expect(page.locator('aec-site-header [data-nav-menu-toggle]')).toHaveAttribute(
      'aria-expanded',
      'true',
      { timeout: 15_000 },
    );
  });

  test('a section-nav link clicked before hydration still jumps after it', async ({
    page,
    request,
  }) => {
    const slug = await firstProductSlug(request);
    test.skip(slug === null, 'no product in the DB under test');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/main-[A-Z0-9]+\.js$/, async (route) => {
      await gate;
      await route.continue();
    });

    await page.goto(`/products/${slug}`, { waitUntil: 'commit' });
    const nav = page.locator('aec-section-nav');
    const link = nav.locator('a').last();
    await link.waitFor({ state: 'attached' });
    expect(await link.getAttribute('jsaction'), 'the anchor carries no listener').toBeNull();
    await link.click({ force: true, noWaitAfter: true });

    release();
    await untilHydrated(nav);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

    await link.click();
    // The jump is the proof. The highlight is not asserted: the scrollspy can
    // name an earlier section mid-scroll (covered in section-nav.component.spec.ts).
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });
});

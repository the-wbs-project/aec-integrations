/**
 * AECI-237 / Phase 7.2 — `/legal/*` end-to-end coverage.
 *
 * The legal pages are static, indexable, CACHEABLE content pages (§3.1: 24h
 * edge), SSR-rendered from Markdown. Per page this pins the real HTTP 200, the §4
 * static-page cache headers (`s-maxage=86400`, `max-age=3600`, `Cache-Tag:
 * route:index`), that the body actually SSR-renders (no empty hydration shell),
 * the self-referential canonical with no noindex, the footer Legal link in, a
 * clean axe pass, and clean hydration. A final test pins that an unknown
 * `/legal/*` 404s with NOT_FOUND_TTL + `Cache-Tag: route:404`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';

const PAGES = [
  {
    path: '/legal/terms',
    title: 'Terms of Service · AEC Integrations',
    heading: 'Terms of Service',
    footerLink: 'Terms',
    bodyMarker: 'How listings are sourced',
  },
  {
    path: '/legal/privacy',
    title: 'Privacy Policy · AEC Integrations',
    heading: 'Privacy Policy',
    footerLink: 'Privacy',
    bodyMarker: 'Lawful basis',
  },
  {
    path: '/legal/review-guidelines',
    title: 'Review Guidelines · AEC Integrations',
    heading: 'Review Guidelines',
    footerLink: 'Review guidelines',
    bodyMarker: 'Moderation process',
  },
  {
    path: '/legal/listing-accuracy',
    title: 'Listing Accuracy Policy · AEC Integrations',
    heading: 'Listing Accuracy Policy',
    footerLink: 'Listing accuracy',
    bodyMarker: 'Requesting a correction',
  },
  {
    path: '/legal/vendor-terms',
    title: 'Vendor Terms · AEC Integrations',
    heading: 'Vendor Terms',
    footerLink: 'Vendor terms',
    bodyMarker: 'Who may claim',
  },
  {
    path: '/legal/managed-plan-agreement',
    title: 'Managed Plan Agreement · AEC Integrations',
    heading: 'Managed Plan Agreement',
    footerLink: 'Managed plan agreement',
    bodyMarker: 'Renewal notice',
  },
] as const;

/**
 * Presets a consent decision before any page script runs, so the analytics
 * consent banner never mounts over the footer (AECI-1359). The key mirrors
 * `CONSENT_STORAGE_KEY` in `src/app/analytics/consent.ts`.
 */
async function presetConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    globalThis.localStorage.setItem('aeci_analytics_consent', 'denied');
  });
}

for (const pageDef of PAGES) {
  test.describe(`${pageDef.path} — Phase 7.2 (AECI-237)`, () => {
    test('returns 200 with the 24h-edge static-page cache headers + route:index tag', async ({
      request,
    }) => {
      const res = await request.get(pageDef.path, { maxRedirects: 0 });
      expect(res.status()).toBe(200);

      const cacheControl = res.headers()['cache-control'] ?? '';
      expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=86400');
      expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=3600');

      expect(res.headers()['cache-tag'] ?? '').toContain('route:index');
    });

    test('SSR-renders the document body (no empty hydration shell)', async ({ request }) => {
      const html = await (await request.get(pageDef.path)).text();
      // The page title (h1) and a section marker both appear in the raw SSR HTML.
      expect(html).toContain(pageDef.heading);
      expect(html).toContain(pageDef.bodyMarker);
      // The pre-launch draft notice ships visibly until counsel approval. Case-insensitive:
      // the Privacy Policy's banner reads "Pending Legal Review" (Google OAuth brand review).
      expect(html.toLowerCase()).toContain('pending legal review');
    });

    test('is indexable — self-referential canonical, no noindex robots meta', async ({
      page,
      request,
    }) => {
      const html = await (await request.get(pageDef.path)).text();
      expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);

      await page.goto(pageDef.path);
      await expect(page).toHaveTitle(pageDef.title);
      const canonical = page.locator('head link[rel="canonical"]');
      await expect(canonical).toHaveCount(1);
      await expect(canonical).toHaveAttribute('href', new RegExp(`${pageDef.path}$`));
      await expect(page.locator('head meta[property="og:type"]')).toHaveAttribute(
        'content',
        'website',
      );
    });

    test('is reachable from the footer Legal nav', async ({ page }) => {
      await presetConsent(page);
      await page.goto('/');
      await expect(page.locator('app-root')).toBeAttached();

      const legal = page.getByRole('navigation', { name: 'Legal' });
      await legal.getByRole('link', { name: pageDef.footerLink, exact: true }).click();

      await expect(page).toHaveURL(new RegExp(`${pageDef.path}$`));
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(pageDef.heading);
    });

    test('has zero axe violations at WCAG AA', async ({ page }) => {
      await page.goto(pageDef.path);
      await expect(page.locator('app-root')).toBeAttached();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();

      expect(results.violations).toEqual([]);
    });

    test('renders with no console errors or page errors', async ({ page }) => {
      const capture = attachConsoleCapture(page);
      const res = await page.goto(pageDef.path);
      expect(res?.status()).toBe(200);
      await expect(page.locator('app-root')).toBeAttached();
      await waitForHydrationSettle(page);
      expectConsoleClean(capture, `GET ${pageDef.path}`);
    });
  });
}

test.describe('/legal/privacy — signed-in activity disclosure (AECI-1211)', () => {
  test('discloses the first-party daily activity record', async ({ request }) => {
    const html = await (await request.get('/legal/privacy')).text();
    expect(html).toContain(
      'When you are signed in, we keep a record of the days you use AEC Integrations, which parts of the site you use, and how you arrived.',
    );
  });
});

test.describe('/legal/* — unknown slug', () => {
  test('an unknown /legal/* path 404s with NOT_FOUND_TTL + route:404 (no stale 24h cache)', async ({
    request,
  }) => {
    const res = await request.get('/legal/does-not-exist', { maxRedirects: 0 });
    expect(res.status()).toBe(404);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=60');
    expect(cacheControl, `got: ${cacheControl}`).not.toContain('s-maxage=86400');

    expect(res.headers()['cache-tag'] ?? '').toContain('route:404');
  });
});

test.describe('/legal/terms/v1.0 — archived version (AECI-1361)', () => {
  const ARCHIVE = '/legal/terms/v1.0';

  test('returns 200 on the /legal/* cache rules with X-Robots-Tag noindex', async ({ request }) => {
    const res = await request.get(ARCHIVE, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control'] ?? '').toContain('s-maxage=86400');
    expect(res.headers()['cache-tag'] ?? '').toContain('route:index');
    // Stamped in every env, the indexed one included (`NOINDEX_PATH_PREFIXES`).
    expect(res.headers()['x-robots-tag']).toBe('noindex, nofollow');
  });

  test('SSR-renders the 1.0 text under the superseded notice, noindex, canonical to current', async ({
    page,
    request,
  }) => {
    const html = await (await request.get(ARCHIVE)).text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
    expect(html).toContain('Version 1.0');
    expect(html).not.toContain('State of Florida');

    await page.goto(ARCHIVE);
    const notice = page.getByTestId('legal-superseded');
    await expect(notice).toContainText('This is version 1.0, superseded on October 14, 2026.');
    await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute(
      'href',
      /\/legal\/terms$/,
    );
    await notice.getByRole('link', { name: 'Read the current version.' }).click();
    await expect(page).toHaveURL(/\/legal\/terms$/);
    await expect(page.getByTestId('legal-superseded')).toHaveCount(0);
  });

  test('has zero axe violations at WCAG AA', async ({ page }) => {
    await page.goto(ARCHIVE);
    await expect(page.locator('app-root')).toBeAttached();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('an unknown version on a known slug 404s', async ({ request }) => {
    const res = await request.get('/legal/terms/v9.9', { maxRedirects: 0 });
    expect(res.status()).toBe(404);
    expect(res.headers()['cache-tag'] ?? '').toContain('route:404');
  });

  test('the current page links the archive from its change history', async ({ request }) => {
    const html = await (await request.get('/legal/terms')).text();
    expect(html).toContain('href="/legal/terms/v1.0"');
  });
});

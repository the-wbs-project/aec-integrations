/**
 * AECI-237 / Phase 7.2 — `/legal/*` end-to-end coverage.
 *
 * The legal pages are static, indexable, CACHEABLE content pages (§3.1: 24h
 * edge), SSR-rendered from Markdown. Per page this pins the real HTTP 200, the §4
 * static-page cache headers (`s-maxage=86400`, `max-age=3600`, `Cache-Tag:
 * route:index`), that the body actually SSR-renders (no empty hydration shell),
 * the self-referential canonical with no noindex, a clean axe pass, and clean
 * hydration. The footer Legal link in is clicked for Terms only. A final test pins that an unknown
 * `/legal/*` 404s with NOT_FOUND_TTL + `Cache-Tag: route:404`.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';
import { untilHydrated } from './hydration';
import { LEGAL_CURRENT_VERSIONS } from '../src/app/legal/legal-manifest';

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
    bodyMarker: 'Why we are allowed to use it',
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

    // One page load for both checks (AECI-2027). Console capture is attached
    // before the load, and the console check runs last, after hydration.
    test('is indexable and renders console-clean', async ({ page, request }) => {
      const capture = attachConsoleCapture(page);

      await test.step('is indexable — self-referential canonical, no noindex robots meta', async () => {
        const html = await (await request.get(pageDef.path)).text();
        expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);

        const res = await page.goto(pageDef.path);
        expect(res?.status()).toBe(200);
        await expect(page).toHaveTitle(pageDef.title);
        const canonical = page.locator('head link[rel="canonical"]');
        await expect(canonical).toHaveCount(1);
        await expect(canonical).toHaveAttribute('href', new RegExp(`${pageDef.path}$`));
        await expect(page.locator('head meta[property="og:type"]')).toHaveAttribute(
          'content',
          'website',
        );
      });

      await test.step('renders with no console errors or page errors', async () => {
        await expect(page.locator('app-root')).toBeAttached();
        await waitForHydrationSettle(page);
        expectConsoleClean(capture, `GET ${pageDef.path}`);
      });
    });

    // One footer click-through is enough (AECI-2027). The six hrefs, in order, are
    // pinned in `site-footer.component.spec.ts`, and each page's own title is
    // checked above. Terms stands in for the column.
    if (pageDef.path === '/legal/terms') {
      test('is reachable from the footer Legal nav', async ({ page }) => {
        await presetConsent(page);
        await page.goto('/');
        await expect(page.locator('app-root')).toBeAttached();

        const legal = page.getByRole('navigation', { name: 'Legal' });
        await legal.getByRole('link', { name: pageDef.footerLink, exact: true }).click();

        await expect(page).toHaveURL(new RegExp(`${pageDef.path}$`));
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(pageDef.heading);
      });
    }

    test('has zero axe violations at WCAG AA', async ({ page }) => {
      await page.goto(pageDef.path);
      await expect(page.locator('app-root')).toBeAttached();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();

      expect(results.violations).toEqual([]);
    });
  });
}

test.describe('/legal — the index of every document (AECI-2237)', () => {
  test('returns 200 on the /legal/* cache rules, SSR-rendered, indexable', async ({ request }) => {
    const res = await request.get('/legal', { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=86400');
    expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=3600');
    expect(res.headers()['cache-tag'] ?? '').toContain('route:index');
    const html = await res.text();
    for (const pageDef of PAGES) expect(html).toContain(`href="${pageDef.path}"`);
    expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
  });

  test('lists the six documents in order, each link resolves, console-clean', async ({
    page,
    request,
  }) => {
    const capture = attachConsoleCapture(page);
    const res = await page.goto('/legal');
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle('Legal · AEC Integrations');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Legal');
    const links = page.getByTestId('legal-index').getByRole('link');
    await expect(links).toHaveText(PAGES.map((p) => p.heading));
    const hrefs = await links.evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(hrefs).toEqual(PAGES.map((p) => p.path));
    for (const href of hrefs) {
      expect((await request.get(href!, { maxRedirects: 0 })).status(), href!).toBe(200);
    }
    await waitForHydrationSettle(page);
    expectConsoleClean(capture, 'GET /legal');
  });

  test('is reachable from the footer Legal nav', async ({ page }) => {
    await presetConsent(page);
    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();
    const legal = page.getByRole('navigation', { name: 'Legal' });
    await legal.getByRole('link', { name: 'All legal documents', exact: true }).click();
    await expect(page).toHaveURL(/\/legal$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Legal');
  });

  test('has zero axe violations at WCAG AA', async ({ page }) => {
    await page.goto('/legal');
    await expect(page.locator('app-root')).toBeAttached();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

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
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
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

// AECI-1610 — a change notice links `/legal/<slug>/v<version>`, so the current
// version is served at its own address too. The version comes from the manifest.
test.describe('the current Vendor Terms at their own address (AECI-1610)', () => {
  const VERSION = LEGAL_CURRENT_VERSIONS['vendor-terms'];
  const OWN = `/legal/vendor-terms/v${VERSION}`;

  test('returns 200 with X-Robots-Tag noindex and a canonical to /legal/vendor-terms', async ({
    request,
  }) => {
    const res = await request.get(OWN, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-tag'] ?? '').toContain('route:index');
    expect(res.headers()['x-robots-tag']).toBe('noindex, nofollow');
    const html = await res.text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
    expect(html).toMatch(/<link[^>]+rel="canonical"[^>]+href="[^"]*\/legal\/vendor-terms"/);
  });

  test('says which version the address shows, without calling it in force', async ({ page }) => {
    await page.goto(OWN);
    const callout = page.getByTestId('legal-fixed-current');
    await expect(callout).toContainText(`This address always shows version ${VERSION}.`);
    await expect(callout).not.toContainText(/in force/i);
    const link = callout.getByRole('link', { name: 'Vendor Terms' });
    await untilHydrated(link);
    await link.click();
    await expect(page).toHaveURL(/\/legal\/vendor-terms$/);
    await expect(page.getByTestId('legal-fixed-current')).toHaveCount(0);
  });
});

// AECI-1720 layout pass: from lg an "On this page" list of the page's own h2s fills
// the column beside the 42rem article. The article keeps its measure, and a link
// jumps in place to the heading's id.
test.describe('/legal "On this page" (AECI-1720)', () => {
  test('lists the h2s beside the article and jumps in place', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/legal/terms');
    const article = page.locator('article.aec-prose');
    const toc = page.locator('aec-page-toc nav');
    await expect(toc).toBeVisible();
    const h2s = await article.locator('h2').allTextContents();
    await expect(toc.getByRole('link')).toHaveText(h2s.map((t) => t.trim()));
    const a = (await article.boundingBox())!;
    const t = (await toc.boundingBox())!;
    expect(a.width).toBeLessThanOrEqual(42 * 16 + 1);
    expect(t.x).toBeGreaterThan(a.x + a.width);
    // The host owns the click listener (highlight only); wait for it to hydrate.
    await untilHydrated(page.locator('aec-page-toc'));
    const link = toc.getByRole('link', { name: 'Disputes' });
    await expect(link).toHaveAttribute('href', '/legal/terms#disputes');
    await link.click();
    await expect(page).toHaveURL(/\/legal\/terms#disputes$/);
    await expect(article.locator('#disputes')).toBeInViewport();
  });

  test('is not rendered below lg', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/legal/terms');
    await expect(page.locator('aec-page-toc')).toBeHidden();
  });
});

// AECI-1720 review, WCAG 2.4.11: a stuck box does not scroll, so the list sticks only
// on a viewport tall enough to show all of it (`aec-page-toc` in styles.css). Tab to
// the last link of the tallest list and check it is in view and clear of the banner.
test.describe('/legal "On this page" never hides a focused link (AECI-1720)', () => {
  for (const [height, banner] of [
    [768, true],
    [600, false],
    [900, true],
  ] as const) {
    test(`Tab reaches the last link in view at 1024x${height}, banner ${banner ? 'shown' : 'dismissed'}`, async ({
      page,
    }) => {
      if (!banner) {
        await page.addInitScript(() =>
          globalThis.localStorage.setItem('aeci_analytics_consent', 'denied'),
        );
      }
      await page.setViewportSize({ width: 1024, height });
      await page.goto('/legal/vendor-terms');
      await untilHydrated(page.locator('aec-page-toc'));
      const links = page.locator('aec-page-toc nav a');
      const count = await links.count();
      expect(count).toBeGreaterThanOrEqual(20);
      // Read well down the page first, where a stuck list would be the one in view.
      await page.evaluate(() => window.scrollTo({ top: 2500, behavior: 'instant' }));
      await links.first().focus();
      for (let i = 1; i < count; i++) await page.keyboard.press('Tab');
      const last = links.last();
      await expect(last).toBeFocused();
      await expect(last).toBeInViewport({ ratio: 1 });
      const box = (await last.boundingBox())!;
      const reserve = await page.evaluate(() =>
        parseFloat(document.documentElement.style.getPropertyValue('--aec-consent-reserve') || '0'),
      );
      if (banner) expect(reserve).toBeGreaterThan(0);
      expect(box.y + box.height).toBeLessThanOrEqual(height - reserve);
    });
  }

  // The thresholds in styles.css (46rem, 54rem with the banner) must still clear the
  // tallest list. A new heading that makes a list taller fails here first.
  test('the sticky thresholds clear every legal list at 1024px', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    let banner = 0;
    for (const slug of [
      'terms',
      'privacy',
      'review-guidelines',
      'listing-accuracy',
      'vendor-terms',
      'managed-plan-agreement',
    ]) {
      await page.goto(`/legal/${slug}`);
      const toc = (await page.locator('aec-page-toc').boundingBox())!;
      banner = Math.max(
        banner,
        await page.evaluate(() =>
          parseFloat(
            document.documentElement.style.getPropertyValue('--aec-consent-reserve') || '0',
          ),
        ),
      );
      expect(32 + toc.height, `${slug} list fits under 46rem`).toBeLessThanOrEqual(46 * 16);
      expect(
        32 + toc.height + banner,
        `${slug} list fits under 54rem with the banner`,
      ).toBeLessThanOrEqual(54 * 16);
    }
  });
});

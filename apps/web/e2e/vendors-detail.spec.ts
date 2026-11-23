/**
 * AECI-59 / Phase 2.13 — vendor detail page end-to-end coverage.
 *
 * Two paths are covered here without depending on seeded data:
 *   1. 404 path (`/vendors/:slug` with a slug that isn't in the dev DB).
 *      Asserts the inline NotFound panel renders, the response is a real
 *      HTTP 404 (not the pinned-404 trap — see Stage 1 Spec §9.1b), and the
 *      cache headers honour `NOT_FOUND_TTL`.
 *   2. Claim/correction request forms (`/vendors/:slug/claim`,
 *      `/vendors/:slug/correction`, AECI-128) render the `RequestForm` with
 *      `<meta name="robots" content="noindex">`.
 *
 * The success-path coverage (hero / breadcrumbs / Cache-Tag with embedded
 * product tags / second-visit cache HIT) lives in the Phase 2.18 crawler
 * (AECI-64) and Phase 2.19 Lighthouse/axe harness (AECI-65) once those land
 * — they run against a seeded dev DB / staging where the
 * assertions have data to bite on. This file is intentionally seed-free so
 * it stays green on `pnpm dev:bound` against an empty local DB. The AECI-1797 band
 * shell block at the end reads the seeded fixtures and skips when they are missing.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext } from '@playwright/test';

/** The label a sighted reader sees: the element's text without its `.sr-only` parts. */
const visibleLabel = (el: Element): string => {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('.sr-only').forEach((n) => n.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
};

test.describe('vendor detail — 404 path', () => {
  test('GET /vendors/<bogus> returns a real HTTP 404 with NOT_FOUND_TTL', async ({ request }) => {
    const res = await request.get('/vendors/no-such-slug-aeci-59', {
      maxRedirects: 0,
    });

    expect(res.status(), 'must be a real 404 — never the pinned-404 trap').toBe(404);

    // §8.3 / §9.1b / AECI-62 AC — 404s on cacheable routes carry a short edge
    // TTL but no browser cache, so a re-navigation after admin fixes the
    // entity revalidates immediately.
    expect(res.headers()['cache-control']).toBe('public, max-age=0, s-maxage=60');

    // AECI-62 AC — single sentinel tag so admin can bulk-purge negative
    // responses after a config fix.
    expect(res.headers()['cache-tag']).toBe('route:404');
  });

  test('404 body renders the global NotFound shell (i18n copy)', async ({ page }) => {
    const res = await page.goto('/vendors/no-such-slug-aeci-59');
    expect(res?.status()).toBe(404);

    // Eyebrow + headline from `not-found.ts` (AECI-62).
    await expect(page.getByText('404: Not found', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: "We couldn't find that page." })).toBeVisible();

    // The four AC-pinned recovery links live inside the 404 shell's directory
    // nav landmark — scope to it so the site-header's primary nav doesn't
    // double-match.
    const directory = page.getByRole('navigation', { name: 'Browse the directory' });
    await expect(directory.getByRole('link', { name: /Products/ })).toHaveAttribute(
      'href',
      /\/products$/,
    );
    await expect(directory.getByRole('link', { name: /Audiences/ })).toHaveAttribute(
      'href',
      /\/audiences$/,
    );
    await expect(directory.getByRole('link', { name: /Phases/ })).toHaveAttribute(
      'href',
      /\/phases$/,
    );
    await expect(directory.getByRole('link', { name: /Categories/ })).toHaveAttribute(
      'href',
      /\/categories$/,
    );
    await expect(page.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
  });

  test('404 panel carries noindex robots meta in the SSR HTML', async ({ request }) => {
    // Stage 1 Spec §9.1b + §20.7 — 404s must not be indexed.
    const res = await request.get('/vendors/no-such-slug-aeci-59');
    const html = await res.text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
  });

  test('404 page has zero axe violations at WCAG AA', async ({ page }) => {
    await page.goto('/vendors/no-such-slug-aeci-59');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });
});

test.describe('vendor detail — claim/correction request forms (AECI-128)', () => {
  test('GET /vendors/<slug>/claim renders the claim form', async ({ page }) => {
    await page.goto('/vendors/anything/claim');
    await expect(page.getByRole('heading', { name: 'Claim your company' })).toBeVisible();
    await expect(page.locator('#claim-email')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send claim' })).toBeVisible();
  });

  test('GET /vendors/<slug>/claim ships noindex robots meta', async ({ request }) => {
    const html = await (await request.get('/vendors/anything/claim')).text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
  });

  test('GET /vendors/<slug>/correction renders the correction form', async ({ page }) => {
    await page.goto('/vendors/anything/correction');
    await expect(page.getByRole('heading', { name: 'Suggest a correction' })).toBeVisible();
    await expect(page.locator('#correction-body')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send correction' })).toBeVisible();
  });

  test('GET /vendors/<slug>/correction ships noindex robots meta', async ({ request }) => {
    const html = await (await request.get('/vendors/anything/correction')).text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
  });
});

/**
 * AECI-1797: the vendor page on the band shell (mock-up 11, rulings of 2026-11-16). This
 * block reads the seed: `fixture-procore-technologies` is claimed (`auth-fixtures.sql`
 * stamps `owned_at`) and `autodesk` is unclaimed. Each test skips loudly without it.
 */
test.describe('vendor detail — band shell (AECI-1797)', () => {
  const CLAIMED = 'fixture-procore-technologies';
  const UNCLAIMED = 'autodesk';

  interface Vendor {
    claim_status?: string;
    company_name: string;
    products: { slug: string }[];
  }

  async function vendorOf(request: APIRequestContext, slug: string): Promise<Vendor | null> {
    const res = await request.get(`/api/vendors/${slug}`);
    return res.ok() ? ((await res.json()) as Vendor) : null;
  }

  test('a claimed vendor: Forest hero, facts card, ordered products, one h1', async ({
    page,
    request,
  }) => {
    const v = await vendorOf(request, CLAIMED);
    test.skip(v?.claim_status !== 'claimed', `seed missing: ${CLAIMED}`);
    await page.goto(`/vendors/${CLAIMED}`);

    await expect(page.locator('[data-shell=bands]')).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('aec-hero-band h1')).toHaveText(v!.company_name);
    await expect(page.getByTestId('vendor-hero-mark')).toBeVisible();
    await expect(page.locator('aec-unclaimed-note')).toHaveCount(0);
    await expect(page.locator('aec-section-nav')).toHaveCount(0);

    const card = page.getByTestId('vendor-facts');
    await expect(card.getByRole('heading', { name: 'At a glance' })).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Actions' })).toBeVisible();
    // AECI-1925: the label reads "Claim Vendor"; the name stays in the accessible name.
    const claim = card.getByRole('link', { name: `Claim Vendor ${v!.company_name}`, exact: true });
    await expect(claim).toBeVisible();
    await expect(claim).toHaveAccessibleName(`Claim Vendor ${v!.company_name}`);
    expect(await claim.evaluate(visibleLabel)).toBe('Claim Vendor');
    await expect(card.locator('aec-company-facts-note')).toBeVisible();

    // The caption states the API's order, and the rows follow it.
    await expect(page.getByTestId('vendor-products-order')).toHaveText('A to Z by name.');
    const hrefs = await page
      .locator('table[aria-label=Products] tbody tr a[href^="/products/"]')
      .evaluateAll((links) => links.map((a) => a.getAttribute('href')));
    expect(hrefs).toEqual(v!.products.map((p) => `/products/${p.slug}`));

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('an unclaimed vendor: no large mark, the note beside a 32px mark', async ({
    page,
    request,
  }) => {
    const v = await vendorOf(request, UNCLAIMED);
    test.skip(v?.claim_status !== 'unclaimed', `seed missing: ${UNCLAIMED}`);
    await page.goto(`/vendors/${UNCLAIMED}`);

    await expect(page.getByTestId('vendor-hero-mark')).toHaveCount(0);
    const note = page.locator('aec-hero-band aec-unclaimed-note');
    await expect(note).toHaveCount(1);
    const box = await note.locator('xpath=preceding-sibling::aec-logo-or-initial[1]').boundingBox();
    expect(box?.width).toBeLessThanOrEqual(32);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  // Ruling 77 (2026-11-16): below 640px the lede steps down one ramp role, 20px to
  // 16px, so a long description does not make the hero a wall. No word is hidden.
  test('the lede is 16px on a phone and 20px from 640px, with every word shown', async ({
    page,
    request,
  }) => {
    const res = await request.get(`/api/vendors/${CLAIMED}`);
    const description = res.ok()
      ? ((await res.json()) as { description?: string }).description
      : null;
    test.skip(!description, `seed missing a description: ${CLAIMED}`);

    const lede = page.getByTestId('vendor-description');
    const sizeOf = () =>
      lede.evaluate((p) => {
        const cs = getComputedStyle(p);
        return {
          fontSize: cs.fontSize,
          lineHeight: cs.lineHeight,
          clamp: cs.webkitLineClamp,
          overflow: cs.overflow,
        };
      });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/vendors/${CLAIMED}`);
    expect(await sizeOf()).toEqual({
      fontSize: '16px',
      lineHeight: '25.6px',
      clamp: 'none',
      overflow: 'visible',
    });
    await expect(lede).toHaveText(description!.trim());

    await page.setViewportSize({ width: 1440, height: 900 });
    expect((await sizeOf()).fontSize).toBe('20px');
  });
});

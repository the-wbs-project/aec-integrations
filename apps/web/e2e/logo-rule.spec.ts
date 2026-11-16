/**
 * AECI-1769: the logo rule, end to end (ADR 0056 floor 3, counsel's ruling 9).
 *
 * An unclaimed product shows an initial tile everywhere except the slot on its own
 * page where "Unclaimed · not affiliated with or endorsed by this vendor" sits beside
 * the mark. The seed gives one claimed and one unclaimed product:
 *
 * - `fixture-procore` is claimed. `auth-fixtures.sql` stamps its vendor's `owned_at`.
 * - `fixture-acme-connector` is unclaimed. Its vendor holds no seat.
 *
 * The seed stores no logos, so CI never fetches an outside image (phase2-fixtures.sql).
 * The last test therefore gives the unclaimed product a logo on the client-side read,
 * through `page.route`, and checks that the page shows it only beside the note. The
 * per-site rule is pinned by the component specs and `logo-or-initial.callers.spec.ts`.
 *
 * The vendor page (AECI-1797) has the same two slots: a claimed vendor's logo is the band
 * hero's mark, and an unclaimed vendor (`autodesk`) shows its logo only at 32px beside the
 * note. Its own two tests inject the logo the same way.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';

import { untilHydrated } from './hydration';

const CLAIMED = 'fixture-procore';
const UNCLAIMED = 'fixture-acme-connector';
const NOTE = 'aec-unclaimed-note';
const LOGO = 'https://logos.e2e.invalid/acme-connector.png';
// A 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function claimStatus(request: APIRequestContext, slug: string): Promise<string | null> {
  const res = await request.get(`/api/products/${slug}`);
  if (!res.ok()) return null;
  return ((await res.json()) as { claim_status?: string }).claim_status ?? null;
}

test.describe('logo rule (AECI-1769)', () => {
  test.beforeEach(async ({ request }) => {
    const [claimed, unclaimed] = await Promise.all([
      claimStatus(request, CLAIMED),
      claimStatus(request, UNCLAIMED),
    ]);
    test.skip(
      claimed !== 'claimed' || unclaimed !== 'unclaimed',
      `seed missing: ${CLAIMED}=${claimed}, ${UNCLAIMED}=${unclaimed}`,
    );
  });

  test('the pair page marks only the unclaimed side, with its mark beside the note', async ({
    page,
  }) => {
    await page.goto(`/products/${CLAIMED}/integrations/${UNCLAIMED}`);
    const notes = page.locator(NOTE);
    await expect(notes).toHaveCount(1);
    // AECI-1798: each product is a card in the hero diagram, and only its name links.
    // The note sits in the unclaimed product's card.
    const side = page.locator('aec-hero-band [data-testid="pair-side-other"]');
    await expect(side.locator(NOTE)).toHaveCount(1);
    await expect(side.locator('a').first()).toHaveAttribute(
      'href',
      new RegExp(`/products/${UNCLAIMED}$`),
    );
    await expect(notes.first().locator('xpath=preceding-sibling::aec-logo-or-initial')).toHaveCount(
      1,
    );
  });

  test('the pair hero diagram shows no unclaimed image above 32px', async ({ page }) => {
    await page.goto(`/products/${CLAIMED}/integrations/${UNCLAIMED}`);
    const side = page.locator('aec-hero-band [data-testid="pair-side-other"]');
    await expect(side).toBeVisible();
    // The 64px mark of the unclaimed side is the initial tile, never an image.
    const large = side.locator('aec-logo-or-initial').first();
    await expect(large.locator('img')).toHaveCount(0);
    await expect(large.locator('span[aria-hidden="true"]')).toHaveText(/^[A-Z0-9·]$/);
    const widths = await side
      .locator('img')
      .evaluateAll((imgs) =>
        imgs.map((i) => (i as HTMLImageElement).getBoundingClientRect().width),
      );
    for (const w of widths) expect(w).toBeLessThanOrEqual(32);
  });

  test('the unclaimed product page carries the note, the claimed one does not', async ({
    page,
  }) => {
    await page.goto(`/products/${UNCLAIMED}`);
    await expect(page.locator(NOTE)).toHaveCount(1);
    await page.goto(`/products/${CLAIMED}`);
    await expect(page.locator(NOTE)).toHaveCount(0);
  });

  test('an unclaimed product logo shows only beside its note, on its own page', async ({
    page,
  }) => {
    await page.route('https://logos.e2e.invalid/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    );
    // The client-side read of the product. SSR reads the API over the service
    // binding, which `page.route` cannot see, so the page is reached by an in-app click.
    await page.route(`**/api/products/${UNCLAIMED}`, async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ response: res, json: { ...body, logo_url: LOGO } });
    });

    await page.goto(`/products/${CLAIMED}/integrations/${UNCLAIMED}`);
    const link = page.locator(`a[href$="/products/${UNCLAIMED}"]`).first();
    await untilHydrated(link);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/products/${UNCLAIMED}$`));

    const logos = page.locator(`img[src="${LOGO}"]`);
    await expect(logos).toHaveCount(1);
    await expect(logos).toHaveAttribute('width', '32');
    await expect(
      logos.first().locator('xpath=ancestor::aec-logo-or-initial[1]/following-sibling::*[1]'),
    ).toHaveJSProperty('tagName', 'AEC-UNCLAIMED-NOTE');
  });

  // AECI-1797: the vendor page's band hero. A claimed vendor's logo is the hero mark. An
  // unclaimed vendor has no large mark, so its logo shows once, at 32px, beside the note.
  test('an unclaimed vendor logo shows only beside its note, on its own page', async ({
    page,
    request,
  }) => {
    const VENDOR = 'autodesk';
    const res = await request.get(`/api/vendors/${VENDOR}`);
    const vendor = res.ok()
      ? ((await res.json()) as { claim_status?: string; products: { slug: string }[] })
      : null;
    test.skip(
      vendor?.claim_status !== 'unclaimed' || vendor.products.length === 0,
      `seed missing: ${VENDOR} unclaimed with a product`,
    );
    await page.route('https://logos.e2e.invalid/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    );
    await page.route(`**/api/vendors/${VENDOR}`, async (route) => {
      const r = await route.fetch();
      const body = (await r.json()) as Record<string, unknown>;
      await route.fulfill({ response: r, json: { ...body, logo_url: LOGO } });
    });

    await page.goto(`/products/${vendor!.products[0].slug}`);
    const link = page.locator(`aec-hero-band a[href="/vendors/${VENDOR}"]`).first();
    await untilHydrated(link);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/vendors/${VENDOR}$`));

    await expect(page.getByTestId('vendor-hero-mark')).toHaveCount(0);
    const logos = page.locator(`img[src="${LOGO}"]`);
    await expect(logos).toHaveCount(1);
    await expect(logos).toHaveAttribute('width', '32');
    await expect(
      logos.first().locator('xpath=ancestor::aec-logo-or-initial[1]/following-sibling::*[1]'),
    ).toHaveJSProperty('tagName', 'AEC-UNCLAIMED-NOTE');
  });

  test('a claimed vendor logo is the hero mark, with no note', async ({ page, request }) => {
    const VENDOR = 'fixture-procore-technologies';
    const res = await request.get(`/api/vendors/${VENDOR}`);
    const vendor = res.ok() ? ((await res.json()) as { claim_status?: string }) : null;
    test.skip(vendor?.claim_status !== 'claimed', `seed missing: ${VENDOR} claimed`);
    await page.route('https://logos.e2e.invalid/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    );
    await page.route(`**/api/vendors/${VENDOR}`, async (route) => {
      const r = await route.fetch();
      const body = (await r.json()) as Record<string, unknown>;
      await route.fulfill({ response: r, json: { ...body, logo_url: LOGO } });
    });

    await page.goto(`/products/${CLAIMED}`);
    const link = page.locator(`aec-hero-band a[href="/vendors/${VENDOR}"]`).first();
    await untilHydrated(link);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/vendors/${VENDOR}$`));

    await expect(page.locator(NOTE)).toHaveCount(0);
    const mark = page.getByTestId('vendor-hero-mark').locator(`img[src="${LOGO}"]`);
    await expect(mark).toHaveAttribute('width', '104');
  });

  test('the pair page shows an unclaimed logo only in its subject slot, beside the note', async ({
    page,
  }) => {
    const CLAIMED_LOGO = 'https://logos.e2e.invalid/procore.png';
    await page.route('https://logos.e2e.invalid/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    );
    // Both sides get a logo on the client-side pair read. Every product link in the
    // payload that names either side gets it too, so an off-slot render would show.
    await page.route(`**/api/products/${CLAIMED}/integrations/${UNCLAIMED}**`, async (route) => {
      const res = await route.fetch();
      const text = await res.text();
      const withLogos = JSON.parse(text, (_key, value: unknown) => {
        if (value && typeof value === 'object' && 'slug' in value && 'logo_url' in value) {
          const v = value as { slug: string };
          if (v.slug === UNCLAIMED) return { ...v, logo_url: LOGO };
          if (v.slug === CLAIMED) return { ...v, logo_url: CLAIMED_LOGO };
        }
        return value;
      }) as Record<string, unknown>;
      await route.fulfill({ response: res, json: withLogos });
    });

    await page.goto(`/products/${CLAIMED}`);
    const link = page.locator(`a[href$="/products/${CLAIMED}/integrations/${UNCLAIMED}"]`).first();
    await untilHydrated(link);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/products/${CLAIMED}/integrations/${UNCLAIMED}$`));

    const unclaimed = page.locator(`img[src="${LOGO}"]`);
    await expect(unclaimed).toHaveCount(1);
    await expect(unclaimed).toHaveAttribute('width', '32');
    await expect(
      unclaimed.first().locator('xpath=ancestor::aec-logo-or-initial[1]/following-sibling::*[1]'),
    ).toHaveJSProperty('tagName', 'AEC-UNCLAIMED-NOTE');
    // The claimed side keeps its logo, so the injection reached the page.
    await expect(page.locator(`img[src="${CLAIMED_LOGO}"]`).first()).toBeVisible();
  });
});

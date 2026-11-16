/**
 * AECI-1891 and AECI-1788: filtering the product page's connector lists.
 *
 * Runs against whatever D1 the stack under test reads. Each case looks for a product
 * with the shape it needs and skips when the database has none, as
 * `detail-deferred-hydration.spec.ts` does. The committed seed has neither shape, so
 * seed one locally to exercise them.
 *
 * What it proves in a real browser:
 *  - AECI-1891: on a page with a Via lane and more than 20 rows, a filter typed on a
 *    freshly loaded page, before the reader scrolls, leaves only the matching cards.
 *    The 20-row deferred cut used to leave the dehydrated tail on the page.
 *  - The same for "Integrations it powers" on a connector with more than 20 pairs.
 *  - Every pair link of both lists is in the raw server HTML.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { untilHydrated } from './hydration';

const DEFER_THRESHOLD = 20;

interface Edge {
  source: { slug: string; name: string };
  target: { slug: string; name: string };
  via?: unknown;
  powered_by_product?: { id: string } | null;
}

interface Detail {
  slug: string;
  integrations_as_source?: Edge[];
  integrations_as_target?: Edge[];
  integrations_as_connector?: Edge[];
}

/** Scan the product list for the first detail that `match` accepts. */
async function findProduct(
  request: APIRequestContext,
  match: (detail: Detail) => boolean,
): Promise<Detail | null> {
  for (let page = 1; page <= 5; page++) {
    const res = await request.get(`/api/products?perPage=100&page=${page}`);
    if (!res.ok()) return null;
    const body = await res.json();
    const items: Array<{ slug: string; integration_count?: number }> = body.data ?? [];
    for (const item of items) {
      if (Number(item.integration_count ?? 0) <= DEFER_THRESHOLD) continue;
      const detail = (await (await request.get(`/api/products/${item.slug}`)).json()) as Detail;
      if (match(detail)) return detail;
    }
    if (page * 100 >= Number(body.total ?? 0)) break;
  }
  return null;
}

const endpointEdges = (d: Detail) => [
  ...(d.integrations_as_source ?? []),
  ...(d.integrations_as_target ?? []),
];

/** A page with a Via lane and more than 20 endpoint edges. */
const hasLongViaLane = (d: Detail) => {
  const edges = endpointEdges(d);
  return edges.length > DEFER_THRESHOLD && edges.some((e) => e.via || e.powered_by_product);
};

/** A connector that powers more than 20 edges. */
const powersMany = (d: Detail) => (d.integrations_as_connector ?? []).length > DEFER_THRESHOLD;

/** "Showing 3 of 60" gives 3. */
async function shownCount(page: Page, section: string): Promise<number> {
  const status = page.locator(`${section} [role=status]`).first();
  await expect(status).toContainText('Showing');
  const match = ((await status.textContent()) ?? '').match(/Showing (\d+) of (\d+)/);
  return Number(match?.[1] ?? NaN);
}

async function duplicateIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const seen = new Map<string, number>();
    for (const el of document.querySelectorAll('[id]')) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
    return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  });
}

test.describe('product page: a Via lane past the 20-row cut (AECI-1891)', () => {
  let target: Detail | null = null;

  test.beforeAll(async ({ request }) => {
    target = await findProduct(request, hasLongViaLane);
  });

  test.beforeEach(() => {
    test.skip(target === null, 'no product with a Via lane and more than 20 rows');
  });

  test('every row is a pair-page link in the raw server HTML', async ({ request }) => {
    const { slug } = target!;
    const html = await (await request.get(`/products/${slug}`)).text();
    const partners = new Set(
      endpointEdges(target!).map((e) => (e.source.slug === slug ? e.target.slug : e.source.slug)),
    );
    for (const partner of partners) {
      expect(html, partner).toContain(`href="/products/${slug}/integrations/${partner}"`);
    }
  });

  test('a filter on a freshly loaded page leaves only the matching cards', async ({ page }) => {
    await page.goto(`/products/${target!.slug}`);
    const search = page.locator('#integrations-filter');
    await untilHydrated(search);
    // The LAST card's partner, typed before the reader scrolls. It sits in a Via lane past
    // the 20-row cut, so its lane survives the filter and the lane's tail must go.
    const name = (await page.locator('#integrations .aec-partner-link').last().textContent())!;
    await search.fill(name.trim());
    const shown = await shownCount(page, '#integrations');
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(DEFER_THRESHOLD);
    await expect(page.locator('#integrations li[aec-product-integration-card]')).toHaveCount(shown);
    expect(await duplicateIds(page)).toEqual([]);

    // Clearing the filter brings every row back.
    await search.fill('');
    const cards = page.locator('#integrations li[aec-product-integration-card]');
    await expect(cards).not.toHaveCount(shown);
    expect(await cards.count()).toBeGreaterThan(DEFER_THRESHOLD);
    expect(await cards.count()).toBeLessThanOrEqual(endpointEdges(target!).length);
  });
});

test.describe('product page: "Integrations it powers" past 20 pairs (AECI-1788)', () => {
  let target: Detail | null = null;

  test.beforeAll(async ({ request }) => {
    target = await findProduct(request, powersMany);
  });

  test.beforeEach(() => {
    test.skip(target === null, 'no connector that powers more than 20 edges');
  });

  test('every powered pair is a link in the raw server HTML', async ({ request }) => {
    const { slug } = target!;
    const html = await (await request.get(`/products/${slug}`)).text();
    // Either orientation: the section links the canonical one. Self-references render in
    // the Integrations section instead (§13.4(2)), so they are not counted here.
    const pairs = (target!.integrations_as_connector ?? []).filter(
      (e) => e.source.slug !== slug && e.target.slug !== slug,
    );
    expect(pairs.length).toBeGreaterThan(DEFER_THRESHOLD);
    for (const e of pairs) {
      const a = `href="/products/${e.source.slug}/integrations/${e.target.slug}"`;
      const b = `href="/products/${e.target.slug}/integrations/${e.source.slug}"`;
      expect(html.includes(a) || html.includes(b), `${e.source.slug} and ${e.target.slug}`).toBe(
        true,
      );
    }
  });

  test('a filter on a freshly loaded page leaves only the matching cards', async ({ page }) => {
    await page.goto(`/products/${target!.slug}`);
    const search = page.locator('#powers-filter');
    await untilHydrated(search);
    const rows = page.locator('#powered-integrations [role=region] li');
    const before = await rows.count();
    expect(before).toBeGreaterThan(DEFER_THRESHOLD);
    // The last row's link text starts with its partner name: one word of it is enough.
    const label = (await page
      .locator('#powered-integrations [role=region] li a')
      .last()
      .getAttribute('aria-label'))!;
    const word = label
      .replace(/^View the /, '')
      .split(' and ')[1]!
      .split(' ')[0]!;
    await search.fill(word);
    const shown = await shownCount(page, '#powered-integrations');
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(before);
    await expect(rows).toHaveCount(shown);
    expect(await duplicateIds(page)).toEqual([]);

    // "Clear filters" (ruled 2026-11-17): every row back, status empty, focus on the field.
    const clear = page.getByTestId('powers-filter-clear');
    await expect(clear).toHaveText('Clear filters');
    await clear.click();
    await expect(rows).toHaveCount(before);
    await expect(search).toHaveValue('');
    await expect(search).toBeFocused();
    await expect(clear).toHaveCount(0);
    await expect(page.locator('#powered-integrations [role=status]').first()).toHaveText('');
  });
});

/**
 * AECI-1891 and AECI-1788: filtering the product page's connector lists.
 *
 * Runs against the committed seed (`apps/api/seed/connector-lists-fixtures.sql`):
 * `fixture-hybrid-via` has a Via lane past 20 rows, and `fixture-connector-hub`
 * powers 39 pairs. Nothing skips: a database without them fails, so CI always runs
 * every case.
 *
 * What it proves in a real browser:
 *  - AECI-1891: on a page with a Via lane and more than 20 rows, a filter typed on a
 *    freshly loaded page, before the reader scrolls, leaves only the matching cards.
 *    The 20-row deferred cut used to leave the dehydrated tail on the page.
 *  - The same for "Integrations it powers" on a connector with more than 20 pairs.
 *  - Every pair link of both lists is in the raw server HTML.
 */
import { expect, test, type APIRequestContext, type Page } from './fixtures';

import { untilHydrated } from './hydration';
import { expectNoSidewaysScroll } from './no-sideways-scroll';

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

/** The fixture's product detail. A missing fixture fails the case, it never skips. */
async function fixture(request: APIRequestContext, slug: string): Promise<Detail> {
  const res = await request.get(`/api/products/${slug}`);
  expect(res.ok(), `seed fixture ${slug} (seed/connector-lists-fixtures.sql)`).toBe(true);
  return (await res.json()) as Detail;
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
    target = await fixture(request, 'fixture-hybrid-via');
    expect(hasLongViaLane(target), 'fixture-hybrid-via has a Via lane past 20 rows').toBe(true);
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
    target = await fixture(request, 'fixture-connector-hub');
    expect(powersMany(target), 'fixture-connector-hub powers more than 20 pairs').toBe(true);
  });

  for (const width of [320, 390, 768, 1024, 1440]) {
    test(`no sideways scroll at ${width}px, with the filter on too`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/products/${target!.slug}`);
      await expectNoSidewaysScroll(page, `connector page at ${width}px`);
      const search = page.locator('#powers-filter');
      await untilHydrated(search);
      await search.fill('a');
      await expect(page.getByTestId('powers-filter-clear')).toBeVisible();
      await expectNoSidewaysScroll(page, `connector page at ${width}px, filtered`);
    });
  }

  // WCAG 2.4.11, as accessibility.spec.ts checks it (AECI-1818): with the consent
  // banner up, Tab from the search box through the powered cards and "Clear filters"
  // never leaves the focused control wholly under the banner.
  test('with the consent banner up, focus in the powered section is never under it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/products/${target!.slug}`);
    await expect(page.getByRole('region', { name: 'Analytics consent' })).toBeVisible();
    const search = page.locator('#powers-filter');
    await untilHydrated(search);
    const underBanner = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        const card = document.querySelector('[aria-label="Analytics consent"] .aec-popover');
        if (!el || !card || card.contains(el) || el === document.body) return null;
        const r = el.getBoundingClientRect();
        const b = card.getBoundingClientRect();
        const under = r.top >= b.top && r.bottom <= b.bottom + 1;
        return under ? (el.getAttribute('aria-label') || el.innerText || el.tagName).trim() : null;
      });
    const hidden: string[] = [];
    await search.focus();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const covered = await underBanner();
      if (covered) hidden.push(covered);
    }
    // "Clear filters" hands focus back to the search box, which must stay visible too.
    await search.fill('Partner 0');
    const clear = page.getByTestId('powers-filter-clear');
    await clear.focus();
    const onClear = await underBanner();
    if (onClear) hidden.push(onClear);
    await page.keyboard.press('Enter');
    await expect(search).toBeFocused();
    const onSearch = await underBanner();
    if (onSearch) hidden.push(onSearch);
    expect(hidden, 'focused controls fully hidden under the consent banner').toEqual([]);
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
    // The last row's partner, whole: its link name is "View the {hub} and {partner}
    // integration, ...", and the partner's full name matches that one row.
    const label = (await page
      .locator('#powered-integrations [role=region] li a')
      .last()
      .getAttribute('aria-label'))!;
    const word = label.split(' and ').at(-1)!.split(' integration')[0]!;
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

// AECI-1924: "Integrations it powers" offers the Integrations section's Cards and Table
// toggle. One toggle sets every hub. The table lists the same rows in the same order as
// the cards, under the same filter and "Showing n of m". Cards render on the server.
for (const slug of ['fixture-connector-hub', 'fixture-hybrid-via']) {
  test.describe(`"Integrations it powers" Cards and Table on ${slug} (AECI-1924)`, () => {
    const section = '#powered-integrations';
    const viewButton = (page: Page, name: 'Cards' | 'Table') =>
      page.locator(`${section} [aria-label="Choose a view"] button`, { hasText: name });
    const cardNames = (page: Page) =>
      page
        .locator(`${section} a[data-testid="powered-card"]`)
        .evaluateAll((as) => as.map((a) => a.getAttribute('aria-label')));
    const tableNames = (page: Page) =>
      page
        .locator(`${section} a[data-testid="powered-table-link"]`)
        .evaluateAll((as) => as.map((a) => a.getAttribute('aria-label')));

    test.beforeAll(async ({ request }) => {
      const d = await fixture(request, slug);
      expect((d.integrations_as_connector ?? []).length, `${slug} powers pairs`).toBeGreaterThan(0);
    });

    test('the server renders cards and no table, the same for every visitor', async ({
      request,
    }) => {
      const html = await (await request.get(`/products/${slug}`)).text();
      const start = html.search(/<section[^>]*id="powered-integrations"/);
      expect(start).toBeGreaterThan(-1);
      const body = html.slice(start, html.indexOf('</section>', start));
      expect(body).toContain('data-testid="powered-card"');
      expect(body).not.toContain('<table');
      expect(body).toContain('aria-label="Choose a view"');
    });

    // One page load for both checks. The first step ends back on Cards with no filter,
    // which is the state a fresh load starts in.
    test('Table matches the cards, and the filter is the same in both views', async ({ page }) => {
      await page.goto(`/products/${slug}`);
      const search = page.locator('#powers-filter');
      await untilHydrated(search);

      await test.step('Table shows the same rows in the same order, named by each hub', async () => {
        const cards = await cardNames(page);
        expect(cards.length).toBeGreaterThan(0);
        await expect(viewButton(page, 'Cards')).toHaveAttribute('aria-pressed', 'true');

        const table = viewButton(page, 'Table');
        await table.click();
        await expect(table).toHaveAttribute('aria-pressed', 'true');
        await expect(table).toBeFocused();
        await expect(page.locator(`${section} a[data-testid="powered-table-link"]`)).toHaveCount(
          cards.length,
        );
        expect(await tableNames(page)).toEqual(cards);
        await expect(page.locator(`${section} a[data-testid="powered-card"]`)).toHaveCount(0);

        // One table per group card, named by that card's heading (the hub).
        const tables = page.locator(`${section} table`);
        const n = await tables.count();
        expect(n).toBeGreaterThan(0);
        for (let i = 0; i < n; i++) {
          const id = (await tables.nth(i).getAttribute('aria-labelledby'))!;
          const heading = page.locator(`[id="${id}"]`);
          await expect(heading).toHaveCount(1);
          // The heading's accessible name, as the browser computes it.
          const snapshot = await heading.ariaSnapshot();
          const name = /"([^"]+)"/.exec(snapshot)?.[1] ?? '';
          expect(name.length, snapshot).toBeGreaterThan(0);
          await expect(tables.nth(i)).toHaveAccessibleName(name);
        }
        expect(await duplicateIds(page)).toEqual([]);

        // Back to cards: the same rows again, and focus stays on the toggle.
        const cardsButton = viewButton(page, 'Cards');
        await cardsButton.click();
        await expect(cardsButton).toBeFocused();
        await expect(page.locator(`${section} a[data-testid="powered-card"]`)).toHaveCount(
          cards.length,
        );
        expect(await cardNames(page)).toEqual(cards);
      });

      await test.step('the filter and "Showing n of m" are the same in both views', async () => {
        const word = (
          (await page
            .locator(`${section} [data-testid="powered-card-name"]`)
            .last()
            .textContent()) ?? ''
        ).trim();
        expect(word.length).toBeGreaterThan(0);
        await search.fill(word);
        const shownInCards = await shownCount(page, section);
        const cards = await cardNames(page);
        expect(cards).toHaveLength(shownInCards);

        await viewButton(page, 'Table').click();
        await expect(page.locator(`${section} a[data-testid="powered-table-link"]`)).toHaveCount(
          shownInCards,
        );
        expect(await shownCount(page, section)).toBe(shownInCards);
        expect(await tableNames(page)).toEqual(cards);

        // Clearing the filter in the table brings every row back, still as a table.
        await page.getByTestId('powers-filter-clear').click();
        await expect(search).toBeFocused();
        await expect(
          page.locator(`${section} a[data-testid="powered-table-link"]`),
        ).not.toHaveCount(shownInCards);
        await expect(page.locator(`${section} a[data-testid="powered-card"]`)).toHaveCount(0);
      });
    });

    // Chris, 2026-11-19: no curved header inside a square card, and more columns.
    // One width per column band of the table: 1440 (five columns, from lg), 768 (four,
    // from md) and 320 (two, below md). The table has no breakpoint below md, so 390
    // showed the same two columns as 320. At 320 this is also the check that the table
    // never scrolls the page sideways: it opens the table and ends with that check.
    for (const width of [1440, 768, 320]) {
      test(`the hub table has square corners inside its card at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/products/${slug}`);
        await untilHydrated(page.locator('#powers-filter'));
        await viewButton(page, 'Table').click();
        const frames = page.locator(`${section} [data-testid="powered-table-frame"]`);
        await expect(frames.first()).toBeVisible();
        const radii = await frames.evaluateAll((els) =>
          els.map((el) => {
            const style = getComputedStyle(el);
            return [style.borderTopLeftRadius, style.borderTopRightRadius, style.boxShadow];
          }),
        );
        for (const [left, right, shadow] of radii) {
          expect([left, right, shadow]).toEqual(['0px', '0px', 'none']);
        }
        // The visible column headers at this width, the Integrations table's way.
        const heads = await page
          .locator(`${section} table`)
          .first()
          .locator('thead th:visible')
          .allInnerTexts();
        const expected =
          width >= 1024
            ? ['Integrates with', 'Direction', 'How it connects', 'Types of data', 'Details']
            : width >= 768
              ? ['Integrates with', 'Direction', 'How it connects', 'Details']
              : ['Integrates with', 'Details'];
        expect(heads.map((h) => h.trim())).toEqual(expected);
        await expectNoSidewaysScroll(page, `${slug} table at ${width}px`);
      });
    }
  });
}

// Chris, 2026-11-19: a Via lane's table sits inside its lane card, so it has no rounded
// frame of its own either. The standalone Integrations table keeps its rounded frame.
test('a Via lane table has square corners inside its lane card (AECI-1924)', async ({ page }) => {
  await page.goto('/products/fixture-hybrid-via');
  const integrations = page.locator('#integrations');
  await untilHydrated(page.locator('#integrations-filter'));
  await integrations.locator('[aria-label="Choose a view"] button', { hasText: 'Table' }).click();
  const frames = integrations.locator('[data-testid="integrations-table-frame"]');
  await expect(frames.first()).toBeVisible();
  const radii = await frames.evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).borderTopLeftRadius),
  );
  expect(radii.length).toBeGreaterThan(0);
  expect(new Set(radii)).toEqual(new Set(['0px']));
});

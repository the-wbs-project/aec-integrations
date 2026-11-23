import { expect, test, type Page } from '@playwright/test';

import { routeFakeAlgolia } from './fake-algolia';
import { untilHydrated } from './hydration';

// AECI-1906: on a slow connection, "Load more" pressed while a filter's search
// was still in flight asked for page 2 of the NEW filter state before its page 1
// landed. InstantSearch caches a page only when no other search is pending, so
// page 1 was never kept and the reader saw filtered rows 25 to 48 under
// "Showing 24 of 70". Once the first page is in and hydrated, every answer is
// held back 1.5 s by the fixed catalogue in `fake-algolia.ts`, so the race
// happens on every run. The first load is not held back (AECI-2027): the helper
// reads `delayMs` on each request, so the test turns it on before its clicks.

/** Read on each request, so a test can turn the delay on after the first load. */
type FakeAlgoliaOptions = NonNullable<Parameters<typeof routeFakeAlgolia>[1]>;

const DELAY_MS = 1_500;
/**
 * The second click must land before the first answer does. Well inside the
 * delay, and loose enough for a loaded CI runner (200 ms flaked locally).
 */
const SECOND_CLICK_MS = 1_000;
const FILTER = 'Field Management';
/** The fixture's Field Management products are 010 to 079: 70 of them. */
const FILTERED_TOTAL = 70;
const filteredRows = (n: number) =>
  Array.from({ length: n }, (_, i) => `Zz Fake Product ${String(10 + i).padStart(3, '0')}`);
const FILTERED_FIRST_PAGE = filteredRows(24);

const cards = (page: Page) => page.locator('aec-search-product-card');

function filterBox(page: Page, group: string, value: string) {
  return page
    .locator('aec-search-refinement-list fieldset')
    .filter({ has: page.locator('legend', { hasText: group }) })
    .getByRole('checkbox', { name: value });
}

const loadMore = (page: Page) => page.getByRole('button', { name: 'Load more' });

/** The product names on screen, in order. */
async function names(page: Page): Promise<string[]> {
  const texts = await cards(page).allInnerTexts();
  return texts.map((t) => t.match(/Zz Fake Product \d{3}/)?.[0] ?? t);
}

async function expectFilteredFirstPage(page: Page): Promise<void> {
  // The filtered answer lands after the delay. Its first 24 rows must be the
  // filtered first page, in order. The scroll sentinel may append page 2 after
  // that, so only the first 24 are pinned.
  await expect
    .poll(async () => (await names(page)).slice(0, 24), { timeout: DELAY_MS * 4 })
    .toEqual(FILTERED_FIRST_PAGE);
  // The footer is not left on its spinner.
  await expect(page.getByText('Loading…')).toHaveCount(0, { timeout: DELAY_MS * 3 });
  const count = await cards(page).count();
  await expect(page.getByText(`Showing ${count} of ${FILTERED_TOTAL}`)).toBeVisible();
}

test.describe('/search: Load more during a pending search (AECI-1906)', () => {
  test('Load more pressed while a filter search is in flight keeps the filtered first page', async ({
    page,
  }) => {
    const filteredPages: number[] = [];
    const fake: FakeAlgoliaOptions = {
      delayMs: 0,
      onQuery: (q) => {
        const filtered = q.facetFilters.some((g) =>
          (Array.isArray(g) ? g : [g]).includes(`categories:${FILTER}`),
        );
        if (filtered && !q.indexName.includes('vendors') && q.hitsPerPage > 1) {
          filteredPages.push(q.page);
        }
      },
    };
    await routeFakeAlgolia(page, fake);
    await page.goto('/search');
    await expect(cards(page)).toHaveCount(24, { timeout: 15_000 });

    const box = filterBox(page, 'Categories', FILTER);
    await untilHydrated(box);
    await untilHydrated(loadMore(page));
    fake.delayMs = DELAY_MS;
    await box.click();
    await loadMore(page).click({ timeout: SECOND_CLICK_MS });

    // Before the filtered page 1 lands, no later page of the new state is asked for.
    // A page-2 request would leave on the click itself; 100 ms is ample, and
    // still well before the filtered answer (and any legitimate sentinel load).
    // A fixed wait on purpose. The test proves that no page-2 request leaves, and
    // no condition marks the end of "nothing happened".
    await page.waitForTimeout(100);
    expect(
      filteredPages.filter((p) => p > 0),
      'no page-2 request for the new filter',
    ).toEqual([]);

    await expectFilteredFirstPage(page);

    // The press was deferred, not dropped: once page 1 is in, page 2 follows
    // without another click or scroll, so infinite scroll cannot stall.
    await expect
      .poll(async () => (await names(page)).slice(0, 48), { timeout: DELAY_MS * 4 })
      .toEqual(filteredRows(48));
  });

  test('a filter ticked while a Load more page is in flight still shows the filtered first page', async ({
    page,
  }) => {
    const fake: FakeAlgoliaOptions = { delayMs: 0 };
    await routeFakeAlgolia(page, fake);
    await page.goto('/search');
    await expect(cards(page)).toHaveCount(24, { timeout: 15_000 });

    const box = filterBox(page, 'Categories', FILTER);
    await untilHydrated(box);
    await untilHydrated(loadMore(page));
    fake.delayMs = DELAY_MS;
    await loadMore(page).click();
    await box.click({ timeout: SECOND_CLICK_MS });

    await expectFilteredFirstPage(page);
  });
});

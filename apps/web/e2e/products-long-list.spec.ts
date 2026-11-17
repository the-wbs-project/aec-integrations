/**
 * AECI-1783: the long integration list on the product page.
 *
 * Runs against the committed e2e fixture `fixture-long-list`
 * (`apps/api/seed/long-list-fixtures.sql`, AECI-1868): 14 integrations to 14
 * partners in three local-only categories plus one uncategorised partner, so the
 * section groups (13 rows or more, fewer groups than half the rows, no Via lane).
 * Group sizes: Alpha 8 (longer than the 6-card peek), Beta 4, Gamma 2, none 1.
 * Partner 01 sits in Alpha and Beta, so 14 rows print 15 cards.
 *
 * The spec skips only where the fixture is absent: a deployed tier never seeds it.
 *
 * What it proves in a real browser:
 *  - every row is a crawlable pair-page link in the raw server HTML, hidden or not;
 *  - the rail, the group heading and the filter chip print one count per category;
 *  - a rail link moves focus to its group heading;
 *  - "Show more" reveals rows already in the DOM, with no network request;
 *  - "One list" shows 12 and "Load more" adds 12;
 *  - the rail and the page do not overflow sideways at 320px;
 *  - a filter on a freshly loaded page leaves no stale group and no duplicate id;
 *  - after a client-side navigation a rail link still reaches its group;
 *  - "Show more" moves focus to the first card it revealed;
 *  - a text-fragment link to a hidden card opens its group, and it stays open.
 */
import { expect, test, type Page } from '@playwright/test';

import { untilHydrated } from './hydration';
import { expectNoSidewaysScroll } from './no-sideways-scroll';

/** The seeded fixture: its slug, its row count and its groups (heading → cards). */
const FIXTURE = {
  slug: 'fixture-long-list',
  rows: 14,
  groups: {
    'Zz Fixture Category Alpha': 8,
    'Zz Fixture Category Beta': 4,
    'Zz Fixture Category Gamma': 2,
    'No category on record': 1,
  } as Record<string, number>,
};

const text = async (page: Page, selector: string) =>
  (await page.locator(selector).allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());

test.describe('product page: long integration lists (AECI-1783)', () => {
  let seeded = false;
  const target = { slug: FIXTURE.slug, rows: FIXTURE.rows };

  test.beforeAll(async ({ request }) => {
    const res = await request.get(`/api/products/${FIXTURE.slug}`);
    // Only a 404 means "not seeded here". Any other failure is a real error, not a skip.
    if (res.status() === 404) return;
    expect(res.status(), `GET /api/products/${FIXTURE.slug}`).toBe(200);
    seeded = true;
    // The fixture is the contract: its shape must hold, or every test below is moot.
    const detail = await res.json();
    const edges = [
      ...(detail.integrations_as_source ?? []),
      ...(detail.integrations_as_target ?? []),
    ];
    expect(edges, 'fixture-long-list rows').toHaveLength(FIXTURE.rows);
  });

  test.beforeEach(() => {
    test.skip(!seeded, 'fixture-long-list is not seeded here (a deployed tier, not the e2e seed)');
  });

  test('the fixture prints its four groups with their card counts', async ({ page }) => {
    await page.goto(`/products/${target.slug}`);
    const groups = page.locator('section[aec-product-integration-category-group]');
    await expect(groups).toHaveCount(Object.keys(FIXTURE.groups).length);
    const seen: Record<string, number> = {};
    for (const group of await groups.all()) {
      const name = (await group.locator('h3').textContent())!.trim();
      seen[name] = await group.locator(':scope > ul > li').count();
    }
    expect(seen).toEqual(FIXTURE.groups);
  });

  test('every row is a crawlable pair-page link in the raw server HTML', async ({ request }) => {
    const { slug, rows } = target;
    const html = await (await request.get(`/products/${slug}`)).text();
    const links = new Set(
      [...html.matchAll(new RegExp(`href="/products/${slug}/integrations/([a-z0-9-]+)"`, 'g'))].map(
        (m) => m[1],
      ),
    );
    expect(links.size).toBe(rows);
    // A group longer than its 6-card peek keeps its rest in the HTML, hidden until found.
    // A list whose every group fits its peek (13 rows in groups of 6 or fewer) has none.
    const showMore = html.includes('data-testid="integration-category-group-toggle"');
    expect(html.includes('hidden="until-found"')).toBe(showMore);
    expect(html).toContain('data-testid="integrations-rail"');
  });

  test('rail, group heading and chip counts agree; a rail link focuses its heading', async ({
    page,
  }) => {
    await page.goto(`/products/${target.slug}`);
    const rail = page.getByTestId('integrations-rail-link');
    await untilHydrated(rail.nth(1));

    const groups = page.locator('section[aec-product-integration-category-group]');
    const count = await groups.count();
    expect(count).toBeGreaterThan(1);
    for (let i = 0; i < count; i++) {
      const group = groups.nth(i);
      const name = (await group.locator('h3').textContent())!.trim();
      const heading = (await group
        .getByTestId('integration-category-group-count')
        .locator('[aria-hidden]')
        .textContent())!.trim();
      const railCount = (await rail.nth(i).locator('[aria-hidden]').textContent())!.trim();
      expect(railCount, name).toBe(heading);
      const chip = page
        .locator('[aria-labelledby="integrations-filter-categories"] button')
        .filter({ hasText: name });
      if ((await chip.count()) === 1) {
        expect(
          (await chip.getByTestId('integrations-chip-count').textContent())!.trim(),
          name,
        ).toBe(heading);
      }
    }

    await rail.nth(1).click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id ?? ''))
      .toMatch(/^integrations-(cat-.+|uncategorised)-title$/);
    const focused = await page.evaluate(() => document.activeElement!.id);
    await expect(page.locator(`#${focused}`)).toBeInViewport();
  });

  test('"Show more" reveals rows already in the DOM, without a request', async ({ page }) => {
    await page.goto(`/products/${target.slug}`);
    const group = page
      .locator('section[aec-product-integration-category-group]')
      .filter({ has: page.getByTestId('integration-category-group-toggle') })
      .first();
    await expect(group, 'the Alpha group is longer than its peek').toHaveCount(1);
    const toggle = group.getByTestId('integration-category-group-toggle');
    await untilHydrated(toggle);
    const hiddenBefore = await group.locator('ul > li[hidden]').count();
    expect(hiddenBefore).toBeGreaterThan(0);

    const requests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/')) requests.push(r.url());
    });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(group.locator('ul > li[hidden]')).toHaveCount(0);
    expect(requests).toEqual([]);
  });

  test('"One list" shows 12, and "Load more" adds 12', async ({ page }) => {
    await page.goto(`/products/${target.slug}`);
    const oneList = page.getByRole('button', { name: 'One list' });
    await untilHydrated(oneList);
    await oneList.click();
    const list = page.locator('aec-product-integration-one-list');
    const visible = list.locator(':scope > ul > li:not([hidden])');
    await expect(visible).toHaveCount(Math.min(12, target.rows));
    await expect(list.locator('[aria-live="polite"]')).toHaveText(`Showing 12 of ${target.rows}`);
    await page.getByTestId('integrations-load-more').click();
    await expect(visible).toHaveCount(Math.min(24, target.rows));
  });

  test('nothing overflows sideways at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`/products/${target.slug}`);
    await page.getByTestId('integrations-rail').scrollIntoViewIfNeeded();
    await expectNoSidewaysScroll(page);
    const names = await text(page, '[data-testid="integrations-rail-link"]');
    expect(names.length).toBeGreaterThan(1);
  });

  test('a filter on a freshly loaded page leaves no stale group and no duplicate id', async ({
    page,
  }) => {
    await page.goto(`/products/${target.slug}`);
    const search = page.locator('#integrations input[type=search]');
    await untilHydrated(page.getByTestId('integrations-rail-link').first());
    // One partner's name, typed before the reader scrolls anywhere: most groups drop.
    const name = (await page.locator('.aec-partner-link').first().textContent())!.trim();
    await search.fill(name);
    await expect(page.locator('#integrations [role=status]')).toContainText('Showing');
    const railCount = await page.getByTestId('integrations-rail-link').count();
    await expect(page.locator('section[aec-product-integration-category-group]')).toHaveCount(
      railCount,
    );
    const duplicates = await page.evaluate(() => {
      const seen = new Map<string, number>();
      for (const el of document.querySelectorAll('[id]'))
        seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
      return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    });
    expect(duplicates).toEqual([]);
  });

  test('after a client-side navigation, the last rail link reaches its group', async ({ page }) => {
    await page.goto('/');
    await untilHydrated(page.locator('a[href="/products"]').first());
    // Navigate inside the app, as a reader coming from search or browse does.
    await page.evaluate((slug) => {
      history.pushState({}, '', `/products/${slug}`);
      dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    }, target.slug);
    const rail = page.getByTestId('integrations-rail-link');
    await expect(rail.first()).toBeVisible();
    await rail.last().click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id ?? ''))
      .toMatch(/^integrations-(cat-.+|uncategorised)-title$/);
    const focused = await page.evaluate(() => document.activeElement!.id);
    await expect(page.locator(`#${focused}`)).toBeInViewport();
  });

  test('"Show more" moves focus to the first card it revealed', async ({ page }) => {
    await page.goto(`/products/${target.slug}`);
    const group = page
      .locator('section[aec-product-integration-category-group]')
      .filter({ has: page.getByTestId('integration-category-group-toggle') })
      .first();
    await expect(group, 'the Alpha group is longer than its peek').toHaveCount(1);
    const toggle = group.getByTestId('integration-category-group-toggle');
    await untilHydrated(toggle);
    await toggle.focus();
    await page.keyboard.press('Enter');
    const revealed = group.locator(':scope > ul > li').nth(6).locator('.aec-partner-link');
    await expect(revealed).toBeFocused();
    await expect(revealed).toBeInViewport();
  });

  test('a text-fragment link to a hidden card opens its group, and it stays open', async ({
    page,
  }) => {
    await page.goto(`/products/${target.slug}`);
    // A hidden card in the last group with a toggle, whose name occurs once on the page.
    const pick = await page.evaluate(() => {
      const groups = [
        ...document.querySelectorAll('section[aec-product-integration-category-group]'),
      ]
        .filter((s) => s.querySelector('[data-testid=integration-category-group-toggle]'))
        .reverse();
      // Every card name on the page. A name that is part of no other card's name is
      // matched by the fragment in this card only.
      const names = [...document.querySelectorAll('.aec-partner-link')].map(
        (a) => a.textContent?.trim() ?? '',
      );
      for (const section of groups) {
        for (const li of section.querySelectorAll(':scope > ul > li[hidden]')) {
          const name = li.querySelector('.aec-partner-link')?.textContent?.trim() ?? '';
          if (name && names.filter((n) => n.includes(name)).length === 1) {
            return { id: section.id, name };
          }
        }
      }
      return null;
    });
    expect(pick, 'a hidden card whose name is unique on the page').not.toBeNull();
    const fragment = encodeURIComponent(pick!.name).replace(/-/g, '%2D');
    // A fresh load, as from a search result, not a same-document jump.
    await page.goto('about:blank');
    await page.goto(`/products/${target.slug}#:~:text=${fragment}`);
    const group = page.locator(`#${pick!.id}`);
    const toggle = group.getByTestId('integration-category-group-toggle');
    await untilHydrated(toggle);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(group.locator(':scope > ul > li[hidden]')).toHaveCount(0);
    // Still open once everything has settled: hydration does not hide it again.
    await page.waitForTimeout(1000);
    await expect(group.locator(':scope > ul > li[hidden]')).toHaveCount(0);
  });
});

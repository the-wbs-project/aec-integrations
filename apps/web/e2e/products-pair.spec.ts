/**
 * AECI-303 (§9) — the product-PAIR page's version selectors, end to end.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT TEST ────────────────────────────────────────
 * The diff itself. No environment has a pair with releases: promote does not ingest
 * versions (§11), and the only writer is `/api/vendor/products/:id/versions`, which
 * needs a Verified-vendor session. Exercising `added`/`removed` here would mean
 * seeding both releases AND version-stamped attestations through the vendor API in a
 * fixture step — that belongs to the vendor-portal persona, not to a read-path spec.
 * The diff logic is proved in `packages/shared/src/version-diff.spec.ts` and
 * `apps/api/src/routes/product-pair.spec.ts`.
 *
 * What IS asserted is the part that only a real request can prove, and it is exactly
 * the risk surface:
 *
 *   1. **The launch-reality default** — with no releases anywhere, the page renders
 *      with NO version chrome at all. That is AECI-303's headline acceptance
 *      criterion, and a regression here would be visible on every pair page in the
 *      catalog.
 *   2. **Graceful degradation + the SEO contract** — a bogus `?context_version=`
 *      must be a 200 with default content, a param-free canonical, and NO `noindex`
 *      (the resolver follows the RESPONSE, not the request). A 404 here would render
 *      the NotFound shell for a valid page.
 *   3. **axe-clean**, because this surface is gaining its first combobox.
 *
 * Paths are `baseURL`-relative on purpose: `playwright.config.ts` honours
 * `AECI_WEB_PORT`. A spec that needs an absolute origin imports it from
 * `./base-url`; never write a `localhost:8788` literal (AECI-1449).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { untilHydrated } from './hydration';
import { expectNoSidewaysScroll } from './no-sideways-scroll';

/** Resolve a real pair from the live catalog, so the spec doesn't pin fixture slugs. */
async function findPair(
  request: import('@playwright/test').APIRequestContext,
): Promise<{ context: string; other: string } | null> {
  const res = await request.get('/api/integrations?perPage=25');
  if (!res.ok()) return null;
  // `IntegrationListItem` hydrates its endpoints as `source` / `target`
  // (`ProductLink`), not `source_product` / `target_product` — that spelling is the
  // pair RESPONSE's, which is a different shape.
  const body = (await res.json()) as {
    data?: { source?: { slug?: string }; target?: { slug?: string } }[];
  };
  for (const row of body.data ?? []) {
    const context = row.source?.slug;
    const other = row.target?.slug;
    if (context && other && context !== other) return { context, other };
  }
  return null;
}

test.describe('product-PAIR page — version selectors (AECI-303)', () => {
  test('renders with NO version chrome when no product has releases', async ({ request }) => {
    const pair = await findPair(request);
    test.skip(pair === null, 'no integration in the local catalog to build a pair from');

    const path = `/products/${pair!.context}/integrations/${pair!.other}`;
    const res = await request.get(path);
    expect(res.status()).toBe(200);
    const html = await res.text();

    // The whole suppression rule is `version_diff: null`, so none of the §9 chrome
    // may reach the HTML.
    expect(html).not.toContain('aec-pair-version-select');
    expect(html).not.toContain('Show the latest versions');
    expect(html).not.toContain('Changes from');
    // …while the rest of the page's furniture is untouched. Since AECI-1666 the
    // provenance panel replaces the header chip; its host is always in the HTML.
    expect(html).toContain('aec-listing-provenance');
    expect(html).not.toMatch(/<header[^>]*>[\s\S]*?aec-maintenance-marker[\s\S]*?<\/header>/);
  });

  test('the API reports version_diff: null for a pair with no releases', async ({ request }) => {
    const pair = await findPair(request);
    test.skip(pair === null, 'no integration in the local catalog to build a pair from');

    const res = await request.get(`/api/products/${pair!.context}/integrations/${pair!.other}`);
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { version_diff: unknown }).version_diff).toBeNull();
  });

  test('a bogus version label degrades to a 200 with a param-free canonical and no noindex', async ({
    page,
    request,
  }) => {
    const pair = await findPair(request);
    test.skip(pair === null, 'no integration in the local catalog to build a pair from');

    const path = `/products/${pair!.context}/integrations/${pair!.other}`;
    const res = await request.get(`${path}?context_version=aeci-303-no-such-version`);
    // The pair exists; only the selection is stale. A 404 would render NotFound.
    expect(res.status()).toBe(200);

    const html = await res.text();
    // The assertion must be on the page-level robots META, never `X-Robots-Tag` —
    // that header is the env-wide pre-launch block and is on every non-prod response.
    expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);

    await page.goto(`${path}?context_version=aeci-303-no-such-version`);
    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveCount(1);
    // Orientation-normalised and query-stripped: the canonical never carries a
    // version selection.
    await expect(canonical).not.toHaveAttribute('href', /context_version/);
  });

  test('the timeline endpoint answers for a pair with no attestation history', async ({
    request,
  }) => {
    const pair = await findPair(request);
    test.skip(pair === null, 'no integration in the local catalog to build a pair from');

    const res = await request.get(
      `/api/products/${pair!.context}/integrations/${pair!.other}/timeline`,
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { claims: unknown[]; diff_access: string };
    expect(Array.isArray(body.claims)).toBe(true);
    // The seam defaults open until AECI-304.
    expect(body.diff_access).toBe('full');
  });

  test('has no axe violations', async ({ page, request }) => {
    const pair = await findPair(request);
    test.skip(pair === null, 'no integration in the local catalog to build a pair from');

    await page.goto(`/products/${pair!.context}/integrations/${pair!.other}`);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toHaveLength(0);
  });
});

/**
 * The interaction half — **self-skipping**, in the shape `search.spec.ts` uses for
 * Algolia.
 *
 * These need a pair with releases AND version-stamped attestations, which no
 * environment has (promote does not ingest versions, and the only writer is the
 * Verified-vendor API). Rather than not covering the behaviour at all, the block
 * probes for a pair whose `version_diff` is non-null and skips when there is none —
 * so it runs for anyone who has seeded one locally and stays green in CI.
 *
 * What it covers is the part no unit test can: that a selector click actually
 * **refetches**. Angular's default `runGuardsAndResolvers` policy is `paramsChange`,
 * which "does not include query parameters" — so without the route's predicate the
 * URL would change and the resolver would never re-run, leaving the controls dead
 * until a reload. It also pins the inverse: `?view=` must stay client-side.
 */
async function findVersionedPair(
  request: import('@playwright/test').APIRequestContext,
): Promise<{ context: string; other: string } | null> {
  const res = await request.get('/api/integrations?perPage=50');
  if (!res.ok()) return null;
  const body = (await res.json()) as {
    data?: { source?: { slug?: string }; target?: { slug?: string } }[];
  };
  for (const row of body.data ?? []) {
    const context = row.source?.slug;
    const other = row.target?.slug;
    if (!context || !other || context === other) continue;
    const pairRes = await request.get(`/api/products/${context}/integrations/${other}`);
    if (!pairRes.ok()) continue;
    const pair = (await pairRes.json()) as { version_diff: unknown };
    if (pair.version_diff !== null) return { context, other };
  }
  return null;
}

test.describe('product-PAIR page — version selection interaction (AECI-303)', () => {
  test('a selector click navigates AND refetches, while ?view= stays client-side', async ({
    page,
    request,
  }) => {
    const pair = await findVersionedPair(request);
    test.skip(
      pair === null,
      'no pair in this environment has version-stamped attestations (see the block comment)',
    );
    const path = `/products/${pair!.context}/integrations/${pair!.other}`;

    const apiCalls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes(`/api/products/${pair!.context}/integrations/${pair!.other}`)) {
        apiCalls.push(r.url());
      }
    });

    await page.goto(path);
    const selectors = page.locator('aec-pair-version-select');
    await expect(selectors.first()).toBeVisible();

    const before = apiCalls.length;
    await page.locator('#pair-version-trigger-context').click();
    await page.getByRole('option').nth(1).click();

    await expect(page).toHaveURL(/context_version=/);
    // The refetch IS the assertion — see the block comment.
    await expect.poll(() => apiCalls.length).toBeGreaterThan(before);
    await expect(page.getByText('Show the latest versions')).toBeVisible();

    // The Basic/Detailed toggle must NOT refetch: the route predicate is
    // selector-only precisely so `?view=` stays a client-side disclosure.
    const beforeView = apiCalls.length;
    await page.locator('[role="group"][aria-label="Choose a view"] button').first().click();
    await page.waitForTimeout(400);
    expect(apiCalls.length, '?view= must not re-run the resolver').toBe(beforeView);

    // The way home from a deep-linked historical URL.
    await page.getByText('Show the latest versions').click();
    await expect(page).not.toHaveURL(/context_version/);
  });

  test('the provenance popover shows provenance only and fetches nothing', async ({
    page,
    request,
  }) => {
    const pair = await findVersionedPair(request);
    test.skip(pair === null, 'no pair in this environment has version-stamped attestations');

    const timelineCalls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/timeline')) timelineCalls.push(r.url());
    });

    await page.goto(`/products/${pair!.context}/integrations/${pair!.other}`);
    await page.locator('aec-claim-provenance button').last().click();
    await expect(page.getByText('Sources', { exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    // The pair page no longer renders the History section, so it never calls the
    // timeline endpoint.
    expect(timelineCalls).toHaveLength(0);
    await expect(page.getByText('History', { exact: true })).toHaveCount(0);
  });

  test('a version selector is operable by keyboard alone', async ({ page, request }) => {
    const pair = await findVersionedPair(request);
    test.skip(pair === null, 'no pair in this environment has version-stamped attestations');

    await page.goto(`/products/${pair!.context}/integrations/${pair!.other}`);
    await page.locator('#pair-version-trigger-context').focus();
    await page.keyboard.press('Enter');
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible();
    // Opening the popup moves the active option onto the selected one. A key pressed
    // before that lands is overwritten, and Enter then re-selects the current version, so
    // the URL never changes. Wait for the active option, as a reader's eye would.
    const options = listbox.getByRole('option');
    await expect(options.first()).toHaveAttribute('data-active', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('data-active', 'true');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/context_version=/);
  });
});

// AECI-1777: the one `aec-breadcrumb` on the pair page and the product page. The pair trail
// reads Home, context product, Integrations, other product, and the order is load-bearing.
test.describe('breadcrumb on the pair and product pages (AECI-1777)', () => {
  const crumbs = (page: import('@playwright/test').Page) =>
    page.getByRole('navigation', { name: 'Breadcrumb' }).first().getByRole('listitem');

  test('the pair page reads Home, product, Integrations, product', async ({ page, request }) => {
    const pair = await findPair(request);
    test.skip(pair === null, 'no integration in the local catalog to build a pair from');
    await page.goto(`/products/${pair!.context}/integrations/${pair!.other}`);

    const items = crumbs(page);
    await expect(items).toHaveCount(4);
    await expect(items.nth(0)).toHaveText(/Home/);
    await expect(items.nth(1).getByRole('link')).toHaveAttribute(
      'href',
      `/products/${pair!.context}`,
    );
    await expect(items.nth(2)).toHaveText(/Integrations/);
    await expect(items.nth(2).getByRole('link')).toHaveAttribute(
      'href',
      `/products/${pair!.context}#integrations`,
    );
    await expect(items.nth(3).locator('[aria-current="page"]')).toBeVisible();
    await expect(items.nth(3).getByRole('link')).toHaveCount(0);
  });

  test('the product page reads Home, Products, the product', async ({ page, request }) => {
    const pair = await findPair(request);
    test.skip(pair === null, 'no integration in the local catalog to build a pair from');
    await page.goto(`/products/${pair!.context}`);

    const items = crumbs(page);
    await expect(items).toHaveCount(3);
    await expect(items.nth(0).getByRole('link')).toHaveAttribute('href', '/');
    await expect(items.nth(1).getByRole('link')).toHaveAttribute('href', '/products');
    await expect(items.nth(2).locator('[aria-current="page"]')).toBeVisible();
  });
});

/**
 * AECI-1827: the empty pair page (`STAGE_1_5_SPEC.md` §11.4). It finds two catalog
 * products with no integration, no evidenced pair and no move between them, so it needs
 * no seed. The legal review (item 1) puts the caveat wherever the statement appears, the
 * title and description included.
 */
async function findEmptyPair(
  request: import('@playwright/test').APIRequestContext,
): Promise<{ context: string; other: string } | null> {
  const res = await request.get('/api/products?perPage=24');
  if (!res.ok()) return null;
  const slugs = ((await res.json()) as { data?: { slug: string }[] }).data?.map((p) => p.slug);
  for (const context of slugs ?? []) {
    for (const other of slugs ?? []) {
      if (context >= other) continue;
      const pairRes = await request.get(`/api/products/${context}/integrations/${other}`);
      if (!pairRes.ok()) continue;
      const pair = (await pairRes.json()) as { mechanisms: unknown[]; moved_to: unknown };
      if (pair.mechanisms.length === 0 && pair.moved_to === null) return { context, other };
    }
  }
  return null;
}

/**
 * An empty pair whose closest matches are populated, from the seeded catalog. It prefers
 * a pair that opens on the "no-lane" state (the kept product has matches on neither of
 * the other's categories) while the other lane has cards, so one test covers both.
 */
async function findPopulatedEmptyPair(
  request: import('@playwright/test').APIRequestContext,
): Promise<{ context: string; other: string; opensEmpty: boolean } | null> {
  const res = await request.get('/api/products?perPage=24');
  if (!res.ok()) return null;
  const slugs = ((await res.json()) as { data?: { slug: string }[] }).data?.map((p) => p.slug);
  let fallback: { context: string; other: string; opensEmpty: boolean } | null = null;
  for (const context of slugs ?? []) {
    for (const other of slugs ?? []) {
      if (context >= other) continue;
      const pairRes = await request.get(`/api/products/${context}/integrations/${other}`);
      if (!pairRes.ok()) continue;
      const pair = (await pairRes.json()) as { mechanisms: unknown[]; moved_to: unknown };
      if (pair.mechanisms.length > 0 || pair.moved_to !== null) continue;
      const altRes = await request.get(
        `/api/products/${context}/integrations/${other}/alternatives`,
      );
      if (!altRes.ok()) continue;
      const { lanes } = (await altRes.json()) as {
        lanes: Record<'context' | 'other', { anchors: unknown[]; matches: unknown[] }>;
      };
      if (
        lanes.context.anchors.length > 0 &&
        lanes.context.matches.length === 0 &&
        lanes.other.matches.length > 0
      ) {
        return { context, other, opensEmpty: true };
      }
      if (lanes.context.matches.length > 0 && fallback === null) {
        fallback = { context, other, opensEmpty: false };
      }
    }
  }
  return fallback;
}

const CAVEAT = 'Not on record means we have not found one. It is not proof that none exists.';
const INTRO =
  'Linked as each vendor publishes them. What they say about building a connection is theirs, not ours.';

/** The HTML entities a meta attribute may carry for these strings. */
const decode = (value: string) => value.replace(/&#39;/g, "'").replace(/&amp;/g, '&');

test.describe('product-PAIR page — the empty pair (AECI-1827)', () => {
  test('is a 200 with noindex, no JSON-LD, and the caveat in the title and description', async ({
    request,
  }) => {
    const pair = await findEmptyPair(request);
    test.skip(pair === null, 'no empty pair in the local catalog');

    const res = await request.get(`/products/${pair!.context}/integrations/${pair!.other}`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
    expect(html).not.toContain('application/ld+json');
    const title = decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '');
    // Ruling 97: the two names, then the caveat, word for word.
    expect(title.endsWith(`: ${CAVEAT}`)).toBe(true);
    expect(title).not.toContain('integration:');
    for (const name of ['description', 'twitter:description', 'twitter:title']) {
      const content = html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1];
      expect(decode(content ?? ''), name).toContain(CAVEAT);
    }
    for (const property of ['og:title', 'og:description']) {
      const content = html.match(new RegExp(`<meta property="${property}" content="([^"]*)"`))?.[1];
      expect(decode(content ?? ''), property).toContain(CAVEAT);
    }
  });

  test('renders What you would be moving and the closest matches on the server (AECI-1829, AECI-1830)', async ({
    browser,
    request,
  }) => {
    const pair = await findEmptyPair(request);
    test.skip(pair === null, 'no empty pair in the local catalog');

    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`/products/${pair!.context}/integrations/${pair!.other}`);
    await expect(page.getByTestId('pair-empty-moving').locator('h2')).toHaveText(
      'The data each product already exchanges',
    );
    await expect(page.getByTestId('pair-empty-matches').locator('h2')).toHaveText(
      'Keep one product and swap the other',
    );
    await expect(page.getByTestId('pair-matches-keep-context')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('pair-matches-order')).toContainText(
      'Products run A to Z by name.',
    );
    await context.close();
  });

  test('the keep toggle switches the lane after hydration and the count is announced', async ({
    page,
    request,
  }) => {
    const pair = await findEmptyPair(request);
    test.skip(pair === null, 'no empty pair in the local catalog');

    await page.goto(`/products/${pair!.context}/integrations/${pair!.other}`, {
      waitUntil: 'networkidle',
    });
    await expect(page.getByTestId('pair-matches-count')).toHaveAttribute('aria-live', 'polite');
    const other = page.getByTestId('pair-matches-keep-other');
    await expect(async () => {
      await other.click();
      await expect(other).toHaveAttribute('aria-pressed', 'true', { timeout: 1000 });
    }).toPass();
    await expect(page.getByTestId('pair-matches-keep-context')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('server-renders the four legal-reviewed strings with JavaScript off', async ({
    browser,
    request,
  }) => {
    const pair = await findEmptyPair(request);
    test.skip(pair === null, 'no empty pair in the local catalog');

    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`/products/${pair!.context}/integrations/${pair!.other}`);
    await expect(page.getByTestId('pair-empty-status')).toHaveText('Not on record');
    await expect(page.locator('h1')).toHaveText(
      /^\s*We have no integration between .+ and .+ on record\.\s*$/,
    );
    await expect(page.getByTestId('pair-empty-caveat')).toHaveText(CAVEAT);
    await expect(page.getByTestId('pair-empty-look-it-up-intro')).toHaveText(INTRO);
    // Ruling 98: no "Integration" overline above the statement. AECI-1666 retired the
    // header chip: "About this listing" ends the last band instead (§4.5.8).
    await expect(page.locator('[heroKicker] .aec-overline')).toHaveCount(0);
    await expect(page.locator('[heroKicker] aec-maintenance-marker')).toHaveCount(0);
    await expect(
      page.getByTestId('pair-empty-look-it-up').getByTestId('listing-provenance'),
    ).toContainText('AEC Integrations maintained');
    // Ruling 96: the integrations row never shows a bare 0.
    for (const cell of await page
      .getByTestId('pair-empty-facts-integrations')
      .locator('[role="cell"]')
      .all()) {
      await expect(cell).not.toHaveText(/^\s*0\s*$/);
    }
    // AECI-1835: mock-up 5's diagram and correction entry are in the server HTML.
    await expect(page.getByTestId('pair-empty-medallion')).toHaveText('No integration on record');
    await expect(
      page.getByTestId('pair-empty-stage').locator('svg[viewBox="0 0 540 270"]'),
    ).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByTestId('pair-empty-correction')).toHaveText(/It does exist/);
    await context.close();
  });

  test('"It does exist" opens the correction drawer with an editable prefill and sends nothing', async ({
    page,
    request,
  }) => {
    const pair = await findEmptyPair(request);
    test.skip(pair === null, 'no empty pair in the local catalog');

    const writes: string[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET' && r.url().includes('/api/')) writes.push(r.url());
    });
    await page.goto(`/products/${pair!.context}/integrations/${pair!.other}`);
    const button = page.getByTestId('pair-empty-correction');
    await untilHydrated(button);
    await button.click();
    // The page hosts the drawer: without it the trigger cancels the click and nothing opens.
    const body = page.getByRole('dialog').getByRole('textbox', { name: 'What should we fix?' });
    await expect(body).toBeVisible();
    // The reader's own words to change: the pair named, no claim that one exists.
    await expect(body).toHaveValue(/^An integration between .+ and .+\. Where I saw it: $/);
    await body.fill('My own words');
    await expect(body).toHaveValue('My own words');
    expect(writes, 'nothing is sent before the reader submits').toEqual([]);
  });

  test('does not scroll sideways at 320, 390, 768, 1024 and 1440', async ({ page, request }) => {
    const pair = await findEmptyPair(request);
    test.skip(pair === null, 'no empty pair in the local catalog');

    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/products/${pair!.context}/integrations/${pair!.other}`);
      await expectNoSidewaysScroll(page, `the empty pair page at ${width}px`);
    }
  });

  test('has no axe violations', async ({ page, request }) => {
    const pair = await findEmptyPair(request);
    test.skip(pair === null, 'no empty pair in the local catalog');

    await page.goto(`/products/${pair!.context}/integrations/${pair!.other}`);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toHaveLength(0);
  });
});

/**
 * AECI-1829: an empty pair whose closest matches have cards, from the seeded catalog. The
 * filter runs in the browser and fetches nothing, so each step gates on the rendered count
 * line, never on `networkidle` (`docs/TESTING_STRATEGY.md` §14.3 (b), AECI-1909).
 */
test.describe('product-PAIR page — the empty pair with match cards (AECI-1829)', () => {
  test('renders match cards, narrows them by category, and keeps focus on the lane switch', async ({
    page,
    request,
  }) => {
    const pair = await findPopulatedEmptyPair(request);
    test.skip(pair === null, 'no empty pair with closest matches in the local catalog');

    await page.goto(`/products/${pair!.context}/integrations/${pair!.other}`);
    const cards = page.getByTestId('pair-matches-cards').locator('li');
    if (pair!.opensEmpty) {
      // The "no-lane" state: its button switches the lane, and focus lands on the toggle.
      const empty = page.getByTestId('pair-matches-empty');
      await expect(empty).toHaveAttribute('data-empty', 'no-lane');
      const button = empty.getByRole('button');
      await untilHydrated(button);
      await button.click();
      const toggle = page.getByTestId('pair-matches-keep-other');
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect(toggle).toBeFocused();
      // AECI-1818 (WCAG 2.4.11): the moved focus is not hidden under the consent banner.
      const banner = page
        .locator('aec-consent-banner [role="region"], aec-consent-banner > *')
        .first();
      if (await banner.isVisible()) {
        const [t, b] = await Promise.all([toggle.boundingBox(), banner.boundingBox()]);
        expect(t!.y + t!.height).toBeLessThanOrEqual(b!.y + 1);
      }
    }
    await expect(cards.first()).toBeVisible();
    const total = await cards.count();
    const count = page.getByTestId('pair-matches-count');
    await expect(count).toHaveText(new RegExp(`^\\s*Showing ${total} of ${total}\\s*$`));

    // Turning every category off leaves the designed empty state, and the count says 0.
    const anchors = page.getByTestId('pair-matches-anchors').getByRole('button');
    for (const anchor of await anchors.all()) {
      await untilHydrated(anchor);
      await anchor.click();
    }
    await expect(count).toHaveText(new RegExp(`^\\s*Showing 0 of ${total}\\s*$`));
    await expect(page.getByTestId('pair-matches-empty')).toHaveAttribute('data-empty', 'all-off');
  });

  test('tabs through the lane switch, the search, the categories, the list row, then the cards', async ({
    page,
    request,
  }) => {
    const pair = await findPopulatedEmptyPair(request);
    test.skip(pair === null, 'no empty pair with closest matches in the local catalog');

    await page.goto(`/products/${pair!.context}/integrations/${pair!.other}`);
    const first = page.getByTestId('pair-matches-keep-context');
    await untilHydrated(first);
    if (pair!.opensEmpty) {
      await page.getByTestId('pair-matches-keep-other').click();
    }
    await expect(page.getByTestId('pair-matches-cards').locator('li').first()).toBeVisible();
    await first.focus();
    // Name each stop by the part of the section it belongs to.
    const stops: string[] = [];
    for (let i = 0; i < 40; i++) {
      const where = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return 'none';
        const id = el.getAttribute('data-testid') ?? '';
        if (id.startsWith('pair-matches-keep-')) return 'lane';
        if (el.id === 'pair-matches-filter') return 'search';
        if (id.startsWith('pair-matches-anchor-')) return 'chip';
        if (el.closest('[data-testid="pair-matches-list-row"]')) return 'list-row';
        if (el.closest('[data-testid="pair-matches-order"]')) return 'order';
        if (id.startsWith('pair-match-link-')) return 'card';
        return 'other';
      });
      if (stops[stops.length - 1] !== where) stops.push(where);
      if (where === 'card') break;
      await page.keyboard.press('Tab');
    }
    expect(stops).toEqual(['lane', 'search', 'chip', 'list-row', 'order', 'card']);
  });

  test('has no axe violations and no sideways scroll with the cards on the page', async ({
    page,
    request,
  }) => {
    const pair = await findPopulatedEmptyPair(request);
    test.skip(pair === null, 'no empty pair with closest matches in the local catalog');

    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/products/${pair!.context}/integrations/${pair!.other}`);
      if (pair!.opensEmpty) {
        const toggle = page.getByTestId('pair-matches-keep-other');
        await untilHydrated(toggle);
        await toggle.click();
      }
      await expect(page.getByTestId('pair-matches-cards').locator('li').first()).toBeVisible();
      await expectNoSidewaysScroll(page, `the empty pair page with cards at ${width}px`);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const serious = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      );
      expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toHaveLength(0);
    }
  });
});

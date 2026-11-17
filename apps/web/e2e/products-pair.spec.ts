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
    // …while the pre-AECI-303 furniture is untouched.
    expect(html).toContain('aec-maintenance-marker');
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
    // Ruling 98: no "Integration" overline above the statement; the chip stays.
    await expect(page.locator('[heroKicker] .aec-overline')).toHaveCount(0);
    await expect(page.locator('[heroKicker] aec-maintenance-marker')).toHaveCount(1);
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
      page.getByTestId('pair-empty-stage').locator('svg[viewBox="0 0 540 280"]'),
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

  test('does not scroll sideways at 390, 768, 1024 and 1440', async ({ page, request }) => {
    const pair = await findEmptyPair(request);
    test.skip(pair === null, 'no empty pair in the local catalog');

    for (const width of [390, 768, 1024, 1440]) {
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
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(serious, serious.map((v) => `${v.id}: ${v.help}`).join('\n')).toHaveLength(0);
  });
});

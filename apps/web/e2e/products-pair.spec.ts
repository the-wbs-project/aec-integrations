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
 * `AECI_WEB_PORT`, and the nine specs that hardcode `localhost:8788` silently break
 * in a Conductor workspace on a non-default port pair. Don't add a tenth.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

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
    await page.locator('[role="group"] button').first().click();
    await page.waitForTimeout(400);
    expect(apiCalls.length, '?view= must not re-run the resolver').toBe(beforeView);

    // The way home from a deep-linked historical URL.
    await page.getByText('Show the latest versions').click();
    await expect(page).not.toHaveURL(/context_version/);
  });

  test('the provenance popover lazily loads the append-only history, once', async ({
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
    // Never fetched during SSR or hydration: history is the gateable depth (§9.3),
    // and the page lands in a shared edge-cache entry.
    expect(timelineCalls).toHaveLength(0);

    await page.locator('aec-claim-provenance button').last().click();
    await expect.poll(() => timelineCalls.length).toBe(1);
    await expect(page.getByText('History')).toBeVisible();

    // One request serves every popover on the page — that is why the endpoint is
    // pair-scoped rather than claim-scoped.
    await page.keyboard.press('Escape');
    await page.locator('aec-claim-provenance button').first().click();
    await page.waitForTimeout(300);
    expect(timelineCalls).toHaveLength(1);
  });

  test('a version selector is operable by keyboard alone', async ({ page, request }) => {
    const pair = await findVersionedPair(request);
    test.skip(pair === null, 'no pair in this environment has version-stamped attestations');

    await page.goto(`/products/${pair!.context}/integrations/${pair!.other}`);
    await page.locator('#pair-version-trigger-context').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/context_version=/);
  });
});

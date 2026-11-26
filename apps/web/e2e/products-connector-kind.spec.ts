/**
 * AECI-2037: the public label split, one connector page per kind.
 *
 * Runs against the committed seed (`apps/api/seed/connector-fixtures.sql`):
 * `fx-mindcloud` is an Integration platform and `fx-agave` a Sync Service. A
 * missing fixture fails the case, it never skips.
 *
 * What it proves in the served HTML: the hero's role chip names the kind. The
 * words come from `src/app/products/connector-kind-labels.ts`.
 */
import { expect, test } from '@playwright/test';

const CASES = [
  { slug: 'fx-mindcloud', label: 'Integration platform', kind: 'integration_platform' },
  { slug: 'fx-agave', label: 'Sync Service', kind: 'sync_service' },
] as const;

for (const { slug, label, kind } of CASES) {
  test(`${slug}: the role chip reads "${label}" (AECI-2037)`, async ({ page, request }) => {
    const api = await request.get(`/api/products/${slug}`);
    expect(api.ok(), `seed fixture ${slug} (seed/connector-fixtures.sql)`).toBe(true);
    const detail = (await api.json()) as { product_role: string; connector_kind: string | null };
    expect(detail.product_role).toBe('connector');
    expect(detail.connector_kind).toBe(kind);

    await page.goto(`/products/${slug}`);
    await expect(page.locator('aec-role-badge').first()).toHaveText(label);
    await expect(page.locator('aec-role-badge', { hasText: /^Connector$/ })).toHaveCount(0);
  });
}

// AECI-2043: one pair with two Sync Services (`fx-agave` and `fx-aardvark-sync`). The
// cards order A to Z by the offering vendor, case folded, so "aardvark Systems" comes
// before "Agave Inc.", and each card carries the "Not offered or endorsed by" line.
// Neither endpoint has a vendor on record, so the line names the two products.
test('a pair with two Sync Services: the order and the endorsement line (AECI-2043)', async ({
  page,
}) => {
  await page.goto('/products/fx-procore/integrations/fx-viewpoint-vista');
  const lines = page.locator('[data-testid="pair-not-endorsed"]');
  await expect(lines).toHaveCount(2);
  const tail = 'Not offered or endorsed by the vendors of Procore (fixture) or Viewpoint Vista.';
  await expect(lines.nth(0)).toHaveText(`Offered by aardvark Systems (fixture). ${tail}`);
  await expect(lines.nth(1)).toHaveText(`Offered by Agave Inc. (fixture). ${tail}`);
});

// AECI-1662: the "Connector type" filter on /products, against the same seed. It is
// one checkbox group with two options, and its list in the URL is a sorted CSV.
test('/products: the Connector type filter narrows the grid by kind (AECI-1662)', async ({
  page,
  request,
}) => {
  const api = await request.get('/api/products?connector_kind=sync_service&perPage=100');
  expect(api.ok()).toBe(true);
  const slugs = ((await api.json()) as { data: { slug: string }[] }).data.map((p) => p.slug);
  expect(slugs).toEqual(expect.arrayContaining(['fx-agave', 'fx-aardvark-sync']));
  expect(slugs).not.toContain('fx-mindcloud');

  await page.goto('/products?connector_kind=sync_service');
  const group = page.locator('aec-facet-sidebar fieldset', {
    has: page.locator('legend', { hasText: /^Connector type$/ }),
  });
  await expect(group.locator('label')).toHaveCount(2);
  await expect(group.locator('label').nth(0)).toContainText('Integration platform');
  await expect(group.locator('label').nth(1)).toContainText('Sync Service');
  await expect(group.locator('input[type="checkbox"]').nth(1)).toBeChecked();
  await expect(page.locator('a[href="/products/fx-agave"]').first()).toBeVisible();
  await expect(page.locator('a[href="/products/fx-mindcloud"]')).toHaveCount(0);

  // Hydration can lag the first paint, so retry the click until the URL moves.
  await expect(async () => {
    await group.locator('input[type="checkbox"]').nth(0).click();
    await expect(page).toHaveURL(/connector_kind=integration_platform(%2C|,)sync_service/, {
      timeout: 2000,
    });
  }).toPass();
  await expect(page.locator('a[href="/products/fx-mindcloud"]').first()).toBeVisible();
});

// AECI-2046: the Sync Service page. `fx-agave` carries three curated facts and a claimed
// pair whose owner removed Cost Codes (seed/sync-service-owner-fixtures.sql), so the
// "What it syncs" block lists the other two types of data and never Cost Codes. No
// connector page carries the hero pair finder. `fx-aardvark-sync` only delivers its
// pair, so it has no bare "Integrations" section and no nav link to one.
test('a Sync Service page: the What it syncs block and the connector fixes (AECI-2046)', async ({
  page,
}) => {
  await page.goto('/products/fx-agave');
  const block = page.locator('#what-it-syncs');
  await expect(block.getByRole('heading', { level: 2 })).toHaveText('What Agave (fixture) syncs');
  await expect(block.getByTestId('what-it-syncs-fact-sync_frequency')).toContainText(
    'Every 15 minutes',
  );
  await expect(block.getByTestId('what-it-syncs-facts-source')).toContainText(
    'Recorded by AEC Integrations on November 20, 2026.',
  );
  const objects = block.getByTestId('what-it-syncs-object');
  await expect(objects).toHaveCount(2);
  await expect(objects.nth(0)).toContainText('Budgets');
  await expect(objects.nth(1)).toContainText('Projects & Jobs');
  await expect(block).not.toContainText('Cost Codes');
  await expect(page.getByTestId('product-pair-finder')).toHaveCount(0);

  await page.goto('/products/fx-aardvark-sync');
  await expect(page.locator('#powered-integrations')).toHaveCount(1);
  await expect(page.locator('#integrations')).toHaveCount(0);
  await expect(page.locator('aec-section-nav a[href$="#integrations"]')).toHaveCount(0);
});

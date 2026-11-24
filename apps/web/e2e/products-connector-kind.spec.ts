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

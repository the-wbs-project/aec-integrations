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

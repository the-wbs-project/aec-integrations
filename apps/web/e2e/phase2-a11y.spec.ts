/**
 * AECI-65 / Phase 2.19 — accessibility (axe) success-path coverage for every
 * live Phase 2 page type, against the committed seed fixtures
 * (`supabase/fixtures/phase2-fixtures.sql`).
 *
 * This is the spec the per-entity detail specs deliberately defer their
 * success-path coverage to (see `products-detail.spec.ts` header). The 404 and
 * empty-state paths stay in those seed-free specs; this one needs data.
 *
 * COVERAGE — 13 representative URLs = zero WCAG-AA violations:
 *   product index/detail, vendor index/detail, integration index/detail,
 *   category/audience/phase browse, the three flat taxonomy indexes
 *   (/categories, /audiences, /phases — AECI-157), and the 404 page.
 *
 * FIXTURE GATING — the three detail pages (products/:slug, vendors/:slug,
 *   integrations/:id) 404 when their row is absent. A `beforeAll` probe checks
 *   whether the fixtures are seeded in the dev DB the app reads (shared
 *   `aeci-development` via Accelerate). If they aren't (e.g. DIRECT_URL_STAGING
 *   not yet configured so CI's seed step skipped), the detail cases self-skip
 *   with a loud warning rather than fail — so the harness lands safely and
 *   "lights up" automatically once the fixtures are present. Index / browse /
 *   flat-index / 404 pages need no fixtures and always run.
 *
 * SITE CHROME — both the HEADER (incl. the AECI-155 taxonomy-driven flyout nav,
 *   a new interactive a11y surface present on every page) and the FOOTER are in
 *   scope. The footer's former `.exclude('aec-site-footer')` carve-out was for
 *   dark-theme contrast debt only; AECI-226 removed the dark theme and verified
 *   the footer is WCAG-AA clean in the (now sole) light theme, so the carve-out
 *   was dropped.
 *
 * CONTRAST — AECI-166 fixed the detail-page design-token contrast debt
 *   (`--text-tertiary` labels → `--text-secondary`) at the source and removed
 *   the former foreground-color allowlist. The suite enforces zero AA violations
 *   across the whole page.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, request as playwrightRequest, test, type Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';

const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Fixture identities — the single source of truth is
 * `supabase/fixtures/phase2-fixtures.sql`. The taxonomy slugs are existing
 * reference data (`supabase/reference-data/taxonomy.sql`). Keep in sync with
 * `.lighthouserc.cjs`.
 */
const FIXTURE = {
  productSlug: 'fixture-procore',
  vendorSlug: 'fixture-procore-technologies',
  integrationId: '00000000-0000-4000-8000-000000000065',
  categorySlug: 'project-management',
  audienceSlug: 'general-contracting',
  phaseSlug: 'construction',
} as const;

interface Phase2Page {
  readonly name: string;
  readonly path: string;
  /** Detail pages 404 without their fixture row; gate them on the probe. */
  readonly needsFixture: boolean;
}

const PAGES: readonly Phase2Page[] = [
  { name: 'product index', path: '/products', needsFixture: false },
  { name: 'product detail', path: `/products/${FIXTURE.productSlug}`, needsFixture: true },
  { name: 'vendor index', path: '/vendors', needsFixture: false },
  { name: 'vendor detail', path: `/vendors/${FIXTURE.vendorSlug}`, needsFixture: true },
  { name: 'integration index', path: '/integrations', needsFixture: false },
  {
    name: 'integration detail',
    path: `/integrations/${FIXTURE.integrationId}`,
    needsFixture: true,
  },
  { name: 'category browse', path: `/categories/${FIXTURE.categorySlug}`, needsFixture: false },
  { name: 'audience browse', path: `/audiences/${FIXTURE.audienceSlug}`, needsFixture: false },
  { name: 'phase browse', path: `/phases/${FIXTURE.phaseSlug}`, needsFixture: false },
  { name: 'categories index', path: '/categories', needsFixture: false },
  { name: 'audiences index', path: '/audiences', needsFixture: false },
  { name: 'phases index', path: '/phases', needsFixture: false },
  { name: '404', path: '/aeci-65-no-such-page', needsFixture: false },
];

/** Set once in `beforeAll`; gates the three detail-page success cases. */
let fixturesPresent = false;

test.beforeAll(async () => {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    const res = await ctx.get(`/products/${FIXTURE.productSlug}`, { maxRedirects: 0 });
    fixturesPresent = res.status() === 200;
    if (!fixturesPresent) {
      console.warn(
        `[phase2-a11y] Fixtures absent: GET /products/${FIXTURE.productSlug} -> ${res.status()}. ` +
          'Detail-page (product/vendor/integration) success cases will be SKIPPED. ' +
          'Seed supabase/fixtures/phase2-fixtures.sql into the dev DB (CI: set DIRECT_URL_STAGING) ' +
          'to enable them.',
      );
    }
  } finally {
    await ctx.dispose();
  }
});

type AxeViolations = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'];

/**
 * Run axe at WCAG-AA on the current page and return all violations. The whole
 * page — header and footer included — enforces zero AA violations (the footer's
 * former dark-only carve-out went away with the dark theme in AECI-226).
 * AECI-166 removed the former known-contrast-debt foreground allowlist by fixing
 * the tokens at the source.
 */
async function aaViolations(page: Page): Promise<AxeViolations> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
  return results.violations;
}

test.describe('Phase 2 page types — axe (WCAG AA)', () => {
  for (const p of PAGES) {
    test(`${p.name} has zero AA violations`, async ({ page }) => {
      test.skip(p.needsFixture && !fixturesPresent, 'fixtures not seeded — see beforeAll warning');
      await page.goto(p.path);
      await expect(page.locator('app-root')).toBeAttached();

      const violations = await aaViolations(page);
      expect(violations, formatViolations(violations)).toEqual([]);
    });
  }

  // AECI-155 flyout nav — validate the OPEN disclosure panel state, which the
  // per-page closed-state scans above never reach. Defensive: skips if the
  // desktop flyout trigger isn't rendered (e.g. a future layout change).
  //
  // Open via the KEYBOARD path (focus + Enter), not click: the host opens on
  // hover (`mouseenter`), so a pointer click would move the mouse over the host
  // first (opening it) and then the click would toggle it back closed. Keyboard
  // toggling has no such race and also exercises the documented a11y path.
  test('open taxonomy flyout nav has zero AA violations', async ({ page }) => {
    await page.goto('/products');
    await expect(page.locator('app-root')).toBeAttached();

    const trigger = page.locator('button[aria-haspopup="true"][aria-expanded]').first();
    test.skip((await trigger.count()) === 0, 'desktop flyout trigger not present at this viewport');

    await trigger.focus();
    await trigger.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const violations = await aaViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});

function formatViolations(
  violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations'],
): string {
  if (violations.length === 0) return '';
  return violations
    .map(
      (v) =>
        `[${v.impact ?? '?'}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n` +
        v.nodes.map((n) => `  - ${n.target.join(', ')}\n    ${n.failureSummary ?? ''}`).join('\n'),
    )
    .join('\n\n');
}

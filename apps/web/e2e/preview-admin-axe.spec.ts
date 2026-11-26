import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext } from '@playwright/test';

import { untilAppStable } from './hydration';

/**
 * AECI-2083: axe (WCAG 2.2 AA) on every `/preview/admin-*` route, at 1440 and 390.
 *
 * The admin console is behind the SSR admin gate, so its pages are axe-scanned here,
 * on the previews that mount the real admin components over a fake API with no
 * session (`src/app/preview/preview.routes.ts`). The console redesign (AECI-1729)
 * starts from today's violations, so they are recorded in
 * `e2e/preview-admin-axe.allowlist.txt`, one `<route> <rule id>` line each, sorted.
 * The list only shrinks:
 * - a rule that fails on a route and is not listed fails the test (a new violation);
 * - a listed rule that no longer fails on that route at either width fails the test
 *   too, so the slice that fixed it deletes the line.
 * The failure prints the lines the route should have.
 *
 * Every request off the local stack is answered here: PostHog with an empty 200, the
 * rest aborted. Nothing is submitted and nothing signs in.
 */

const ROUTES = [
  '/preview/admin-activity',
  '/preview/admin-brand-asset-removals',
  '/preview/admin-console-legend',
  '/preview/admin-contests',
  '/preview/admin-email',
  '/preview/admin-field-corrections',
  '/preview/admin-flow-corrections',
  '/preview/admin-litigation-holds',
  '/preview/admin-product-requests',
  '/preview/admin-review-responses',
  '/preview/admin-review-updates',
  '/preview/admin-reviews',
  '/preview/admin-seo',
  '/preview/admin-vendor-billing',
  '/preview/admin-vendor-integrations',
  '/preview/admin-vendor-products',
];

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Routes and rule ids are identifiers, so they sort by code unit, not by locale. */
const binary = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const ALLOWLIST_FILE = join(process.cwd(), 'e2e', 'preview-admin-axe.allowlist.txt');

function readAllowlist(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const raw of readFileSync(ALLOWLIST_FILE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [route, rule, extra] = line.split(/\s+/);
    if (!route || !rule || extra) throw new Error(`Bad allowlist line: "${line}"`);
    if (!out.has(route)) out.set(route, new Set());
    out.get(route)!.add(rule);
  }
  return out;
}

async function offline(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return route.continue();
    if (/posthog/.test(host)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
}

test.describe('axe on the admin previews, against a shrink-only allowlist (AECI-2083)', () => {
  test('the route list covers every /preview/admin-* route', () => {
    const routes = readFileSync(join(process.cwd(), 'src/app/preview/preview.routes.ts'), 'utf8');
    const declared = [...routes.matchAll(/path: '(admin-[a-z-]+)'/g)].map(
      (m) => `/preview/${m[1]}`,
    );
    expect([...declared].sort(binary)).toEqual([...ROUTES].sort(binary));
  });

  test('the allowlist is sorted, has no duplicates and names only known routes', () => {
    const lines = readFileSync(ALLOWLIST_FILE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    const sorted = [...lines].sort(binary);
    expect(lines).toEqual(sorted);
    expect(new Set(lines).size).toBe(lines.length);
    for (const line of lines) expect(ROUTES).toContain(line.split(/\s+/)[0]);
  });

  for (const route of ROUTES) {
    test(`${route} at 1440 and 390`, async ({ browser }) => {
      // Two page loads and two axe runs.
      test.setTimeout(90_000);
      const allowed = readAllowlist().get(route) ?? new Set<string>();
      const seen = new Map<string, string[]>();
      for (const viewport of WIDTHS) {
        const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
        await offline(context);
        const page = await context.newPage();
        const res = await page.goto(route);
        expect(res?.status(), `${route} answers`).toBe(200);
        // Hydrated and stable: stability also waits for the fake API reads, so the
        // admin component has rendered its data before axe reads the page.
        await untilAppStable(page);
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
        await expect(page.locator('main').first()).toBeVisible();
        const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        // A real page passes dozens of checks. A handful means axe read an empty shell.
        expect(result.passes.length, `${route} at ${viewport.width} was scanned`).toBeGreaterThan(
          15,
        );
        for (const v of result.violations) {
          const where = `${viewport.width}: ${v.nodes.length} node(s), ${v.impact ?? 'n/a'}`;
          seen.set(v.id, [...(seen.get(v.id) ?? []), where]);
        }
        await context.close();
      }

      const found = [...seen.keys()].sort(binary);
      const expected = found.map((rule) => `${route} ${rule}`).join('\n') || '(no lines)';
      const added = found.filter((rule) => !allowed.has(rule));
      const fixed = [...allowed].filter((rule) => !seen.has(rule)).sort(binary);
      expect(
        { added: added.map((r) => `${r} (${seen.get(r)!.join('; ')})`), fixed },
        `${route} should list exactly:\n${expected}`,
      ).toEqual({ added: [], fixed: [] });
    });
  }
});

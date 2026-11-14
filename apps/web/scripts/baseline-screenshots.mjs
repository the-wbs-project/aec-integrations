/**
 * AECI-1817: baseline full-page screenshots of every public route, for before/after
 * comparison on the AECI-1720 redesign PRs. A script, not a test.
 *
 * Run (from the repo root):
 *   BASELINE_ORIGIN=http://localhost:8792 pnpm baseline:screenshots
 * or:
 *   pnpm baseline:screenshots http://localhost:8792
 *
 * Never point this at production. It refuses the production host.
 * Staging sits behind Cloudflare Access, so a plain run there lands on the Access
 * login page. Use a local `pnpm dev:agent` origin unless you hold Access credentials.
 *
 * Output: docs/design/mockups/redesign-2026-11/baseline/ (screenshots and README.md),
 * resolved from the current directory, so run it from the repo root.
 */
/* global document, window */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const origin = (process.argv[2] ?? process.env.BASELINE_ORIGIN ?? '').replace(/\/+$/, '');
if (!origin) {
  console.error('Pass an origin: BASELINE_ORIGIN=<origin> pnpm baseline:screenshots');
  process.exit(1);
}
const host = new URL(origin).hostname;
if (/(^|\.)aecintegrations\.com$/.test(host) && !/^(staging|demo)\./.test(host)) {
  console.error('Refusing to screenshot production. Use staging or a local origin.');
  process.exit(1);
}

// Slugs picked from the data the origin serves. Override with BASELINE_SLUGS (JSON).
const slugs = {
  productMany: 'revit',
  productNormal: 'dynamo-for-revit',
  productZero: 'pyrevit',
  pairWith: ['fixture-procore', 'fixture-acme-connector'],
  pairWithout: ['revit', 'dynamo-for-revit'],
  vendor: 'autodesk',
  category: 'accounting-erp',
  audience: 'accounting-finance',
  phase: 'concept-planning',
  trade: 'concrete',
  docsSection: 'getting-started',
  docsArticle: 'getting-started/taxonomy',
  ...JSON.parse(process.env.BASELINE_SLUGS ?? '{}'),
};

const routes = [
  ['home', '/'],
  ['products', '/products'],
  ['product-normal', `/products/${slugs.productNormal}`],
  ['product-many-integrations', `/products/${slugs.productMany}`],
  ['product-zero-integrations', `/products/${slugs.productZero}`],
  ['pair-with-integrations', `/products/${slugs.pairWith[0]}/integrations/${slugs.pairWith[1]}`],
  [
    'pair-without-integrations',
    `/products/${slugs.pairWithout[0]}/integrations/${slugs.pairWithout[1]}`,
  ],
  ['vendor', `/vendors/${slugs.vendor}`],
  ['categories', '/categories'],
  ['category-term', `/categories/${slugs.category}`],
  ['audiences', '/audiences'],
  ['audience-term', `/audiences/${slugs.audience}`],
  ['phases', '/phases'],
  ['phase-term', `/phases/${slugs.phase}`],
  ['trades', '/trades'],
  ['trade-term', `/trades/${slugs.trade}`],
  ['search', '/search'],
  ['about', '/about'],
  ['methodology', '/methodology'],
  ['updates', '/updates'],
  ['roadmap', '/roadmap'],
  ['vendor-program', '/vendor-program'],
  ['list-your-product', '/vendor-program/list-your-product'],
  ['contact', '/contact'],
  ['docs-home', '/docs'],
  ['docs-section', `/docs/${slugs.docsSection}`],
  ['docs-article', `/docs/${slugs.docsArticle}`],
  ['legal-terms', '/legal/terms'],
  ['legal-privacy', '/legal/privacy'],
  ['legal-review-guidelines', '/legal/review-guidelines'],
  ['legal-listing-accuracy', '/legal/listing-accuracy'],
  ['legal-vendor-terms', '/legal/vendor-terms'],
  ['legal-managed-plan-agreement', '/legal/managed-plan-agreement'],
  ['sign-in', '/auth/login'],
  ['not-found', '/this-page-does-not-exist'],
];

const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

// PNG by default. Set BASELINE_FORMAT=jpeg when the set grows past about 40 MB.
const format = process.env.BASELINE_FORMAT === 'jpeg' ? 'jpeg' : 'png';
const ext = format === 'jpeg' ? 'jpg' : 'png';
const outDir = join(process.cwd(), 'docs', 'design', 'mockups', 'redesign-2026-11', 'baseline');
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Network idle, capped: analytics and long-lived requests can keep a page from ever idling.
const settle = (page) => page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

const date = new Date().toISOString().slice(0, 10);
const browser = await chromium.launch();
const rows = [];
const failures = [];

for (const vp of viewports) {
  const context = await browser.newContext({ viewport: vp, reducedMotion: 'reduce' });
  const page = await context.newPage();
  for (const [name, path] of routes) {
    const file = `${name}-${vp.width}.${ext}`;
    try {
      const res = await page.goto(origin + path, { waitUntil: 'load', timeout: 60_000 });
      await settle(page);
      await page.evaluate(() => document.fonts.ready);
      // Decline the analytics banner so it does not cover page content. The choice is
      // remembered for the rest of the context, so later pages show no banner.
      await page
        .getByRole('button', { name: 'Decline' })
        .click({ timeout: 1500 })
        .catch(() => undefined);
      // Scroll once so lazy content loads, then return to the top before the shot.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 600) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 60));
        }
        window.scrollTo(0, 0);
      });
      await settle(page);
      await page.screenshot({
        path: join(outDir, file),
        fullPage: true,
        type: format,
        ...(format === 'jpeg' ? { quality: 80 } : {}),
      });
      rows.push({ path, width: vp.width, file, status: res?.status() ?? 0 });
      console.log(`ok   ${vp.width} ${path} (${res?.status()})`);
    } catch (err) {
      const reason = String(err.message).split('\n')[0];
      failures.push({ path, width: vp.width, reason });
      console.error(`FAIL ${vp.width} ${path}: ${reason}`);
    }
  }
  await context.close();
}
await browser.close();

let bytes = 0;
for (const f of await readdir(outDir)) bytes += (await stat(join(outDir, f))).size;
const mb = (bytes / 1024 / 1024).toFixed(1);

const readme = `# Baseline screenshots (AECI-1817)

"Before" images for the AECI-1720 site redesign. Reviewers compare a redesign PR against these.
Pixel-diff tooling was ruled out on 2026-10-23, so these are for human eyes only.

- **Date taken:** ${date}
- **Origin used:** \`${origin}\`
- **Viewports:** 1440 px and 390 px wide, full page, ${format.toUpperCase()}${format === 'jpeg' ? ' at quality 80' : ''}
- **Files:** ${rows.length} screenshots, ${mb} MB in total

## Re-run

From the repo root, with the origin of a running site (never production):

\`\`\`bash
BASELINE_ORIGIN=http://localhost:8792 pnpm baseline:screenshots
\`\`\`

The origin may also be passed as the first argument. The script is
\`apps/web/scripts/baseline-screenshots.mjs\`. It deletes and rewrites this folder, README included.
Set \`BASELINE_FORMAT=jpeg\` to write JPEG at quality 80 if the set grows past about 40 MB.
Set \`BASELINE_SLUGS\` to a JSON object to override the slugs below when the origin serves other data.

Staging (\`https://staging.aecintegrations.com\`) is behind Cloudflare Access, so an unauthenticated
run there captures the Access login page. The committed set came from a local \`pnpm dev:agent\`
stack with the local seed data. That data is small: no product has more than 2 integrations, so
"many integrations" is the best the seed offers.

## Slugs used

| Role | Slug |
|---|---|
| Product, normal | \`${slugs.productNormal}\` |
| Product, many integrations | \`${slugs.productMany}\` |
| Product, zero integrations | \`${slugs.productZero}\` |
| Pair with integrations | \`${slugs.pairWith.join(' / ')}\` |
| Pair without integrations | \`${slugs.pairWithout.join(' / ')}\` |
| Vendor | \`${slugs.vendor}\` |
| Category, audience, phase, trade term | \`${slugs.category}\`, \`${slugs.audience}\`, \`${slugs.phase}\`, \`${slugs.trade}\` |
| Docs section, article | \`${slugs.docsSection}\`, \`${slugs.docsArticle}\` |

## Screenshots

| Route | Viewport | HTTP status | File |
|---|---|---|---|
${rows.map((r) => `| \`${r.path}\` | ${r.width} | ${r.status} | [${r.file}](./${r.file}) |`).join('\n')}
${failures.length ? `\n## Failed\n\n${failures.map((f) => `- \`${f.path}\` at ${f.width}: ${f.reason}`).join('\n')}\n` : ''}`;
await writeFile(join(outDir, 'README.md'), readme);
console.log(`${rows.length} shots, ${mb} MB, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

/**
 * AECI-2083: "before" screenshots of the vendor portal and admin console previews, for
 * the AECI-1729 redesign slices. The sibling of `baseline-screenshots.mjs` (public
 * routes). A script, not a test.
 *
 * It captures every `/preview/vendor-dashboard` fixture (on its overview) and every
 * `/preview/admin-*` route, at 1440, 768, 390 and 320 px, full page. The fixture keys
 * and the admin routes are read from the source, so a new one is picked up.
 *
 * Run (from the repo root), against a local `pnpm dev:agent` origin:
 *   pnpm baseline:screenshots:portal-admin http://localhost:8792
 * or with BASELINE_ORIGIN set. A second argument (or PORTAL_ADMIN_SHOTS_DIR) sets the
 * output folder. The default is /tmp/aeci-for-chris/portal-admin/before, outside the
 * repo: these images are never committed.
 *
 * IT DELETES ITS OUTPUT FOLDER before writing, so it refuses a folder it must not
 * delete: `/`, the home folder, the repo root or any folder that holds one of them,
 * any folder inside the repo that is not under an ignored `.context/`, a path that is
 * not a folder, and an existing non-empty folder with no `INDEX.md` from an earlier run
 * of this script.
 *
 * Previews are blocked on production and demo, so the script refuses those hosts.
 * Every request off the origin is answered locally: PostHog with an empty 200, the
 * rest aborted. Nothing is submitted and nothing signs in.
 */
/* global document */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const origin = (process.argv[2] ?? process.env.BASELINE_ORIGIN ?? '').replace(/\/+$/, '');
if (!origin) {
  console.error('Pass an origin: pnpm baseline:screenshots:portal-admin <origin>');
  process.exit(1);
}
const originHost = new URL(origin).hostname;
if (/(^|\.)aecintegrations\.com$/.test(originHost) && !/^staging\./.test(originHost)) {
  console.error('Refusing a production or demo host. Previews are blocked there.');
  process.exit(1);
}
const REPO_ROOT = resolve(WEB_DIR, '..', '..');
const INDEX_MARK = 'apps/web/scripts/portal-admin-screenshots.mjs';

/** True when `a` is `b` or a folder below it. */
function inside(a, b) {
  const rel = relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The output folder, or exit when deleting it could lose something. */
async function safeOutDir(raw) {
  const dir = resolve(process.cwd(), raw);
  const refuse = (why) => {
    console.error(`Refusing output folder ${dir}: ${why}`);
    process.exit(1);
  };
  for (const kept of ['/', homedir(), REPO_ROOT]) {
    if (inside(kept, dir)) refuse(`it is or holds ${kept}`);
  }
  if (inside(dir, REPO_ROOT)) {
    const parents = relative(REPO_ROOT, dir).split(/[\\/]/).slice(0, -1);
    if (!parents.includes('.context')) {
      refuse('inside the repo, only a folder under an ignored .context/ may be used');
    }
  }
  const info = await stat(dir).catch(() => null);
  if (info && !info.isDirectory()) refuse('it is not a folder');
  if (info && (await readdir(dir)).length > 0) {
    const index = await readFile(join(dir, 'INDEX.md'), 'utf8').catch(() => '');
    if (!index.includes(INDEX_MARK)) {
      refuse('it is not empty and has no INDEX.md from an earlier run of this script');
    }
  }
  return dir;
}

const outDir = await safeOutDir(
  process.argv[3] ??
    process.env.PORTAL_ADMIN_SHOTS_DIR ??
    '/tmp/aeci-for-chris/portal-admin/before',
);

const dashboard = await readFile(
  join(WEB_DIR, 'src/app/preview/vendor-dashboard/vendor-dashboard-preview.ts'),
  'utf8',
);
const keysBlock = dashboard.match(/const FIXTURE_KEYS[^=]*=\s*\[([\s\S]*?)\];/);
if (!keysBlock) throw new Error('FIXTURE_KEYS not found in vendor-dashboard-preview.ts');
const fixtures = [...keysBlock[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);

const previewRoutes = await readFile(join(WEB_DIR, 'src/app/preview/preview.routes.ts'), 'utf8');
const adminRoutes = [...previewRoutes.matchAll(/path: '(admin-[a-z-]+)'/g)].map((m) => m[1]);

const shots = [
  ...fixtures.map((fixture) => ({
    name: `vendor-${fixture}`,
    route: `/preview/vendor-dashboard/overview?fixture=${fixture}`,
    fixture,
  })),
  ...adminRoutes.map((path) => ({ name: path, route: `/preview/${path}`, fixture: '' })),
];

const widths = [1440, 768, 390, 320];
const heightFor = (w) => (w >= 1024 ? 900 : w >= 768 ? 1024 : 844);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const settle = (page) => page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

const browser = await chromium.launch();
const rows = [];
const failures = [];

for (const width of widths) {
  const context = await browser.newContext({
    viewport: { width, height: heightFor(width) },
    reducedMotion: 'reduce',
  });
  await context.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === originHost) return route.continue();
    if (/posthog/.test(host)) return route.fulfill({ status: 200, body: '{}' });
    return route.abort();
  });
  const page = await context.newPage();
  for (const shot of shots) {
    const file = `${shot.name}-${width}.png`;
    try {
      const res = await page.goto(origin + shot.route, { waitUntil: 'load', timeout: 60_000 });
      await settle(page);
      await page.evaluate(() => document.fonts.ready);
      await page
        .getByRole('button', { name: 'Decline' })
        .click({ timeout: 1500 })
        .catch(() => undefined);
      await settle(page);
      await page.screenshot({ path: join(outDir, file), fullPage: true });
      rows.push({ ...shot, width, file, status: res?.status() ?? 0 });
      console.log(`ok   ${width} ${shot.route} (${res?.status()})`);
    } catch (err) {
      const reason = String(err.message).split('\n')[0];
      failures.push({ ...shot, width, reason });
      console.error(`FAIL ${width} ${shot.route}: ${reason}`);
    }
  }
  await context.close();
}
await browser.close();

let bytes = 0;
for (const f of await readdir(outDir)) bytes += (await stat(join(outDir, f))).size;
const mb = (bytes / 1024 / 1024).toFixed(1);

const index = `# Portal and admin "before" screenshots (AECI-2083)

The vendor portal and admin console previews before the AECI-1729 redesign slices.
Not committed. Re-run with \`pnpm baseline:screenshots:portal-admin <origin> [folder]\`
(\`apps/web/scripts/portal-admin-screenshots.mjs\`). It deletes and rewrites its folder.

- **Taken:** ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC
- **Origin:** \`${origin}\`
- **Widths:** ${widths.join(', ')} px, full page, PNG
- **Files:** ${rows.length} screenshots, ${mb} MB

The vendor fixtures are shown on their overview. Concept a (tabbed), the shipped portal.

| Route | Fixture | Width | HTTP | File |
|---|---|---|---|---|
${rows
  .map(
    (r) =>
      `| \`${r.route}\` | ${r.fixture || 'n/a'} | ${r.width} | ${r.status} | [${r.file}](./${r.file}) |`,
  )
  .join('\n')}
${failures.length ? `\n## Failed\n\n${failures.map((f) => `- \`${f.route}\` at ${f.width}: ${f.reason}`).join('\n')}\n` : ''}`;
await writeFile(join(outDir, 'INDEX.md'), index);
console.log(`${rows.length} shots, ${mb} MB, ${failures.length} failed, in ${outDir}`);
process.exit(failures.length ? 1 : 0);

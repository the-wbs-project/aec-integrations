#!/usr/bin/env node
// Print one version of a legal document to a PDF (AECI-1688, ADR 0054).
//
//   node apps/web/scripts/legal-pdf.mjs <slug> <version> [--out <dir>] [--content-dir <dir>]
//   pnpm --filter @aeci/web legal:pdf <slug> <version>
//
// It reads `src/content/legal/versions/<slug>/v<version>.md` when that file exists,
// else the current `<name>.md` when its frontmatter `version` equals <version>.
// Anything else exits non-zero. A file whose `effective_date` is blank also exits
// non-zero: a copy a customer saves must name the day it takes effect, so the script
// never prints a placeholder in its place.
//
// The Markdown is rendered with `marked`, the renderer the site uses, into a
// self-contained print page: the document title, "Version X, effective <date>", the
// body, and a footer on every page with the version's own public URL and
// "Page N of M". Every link is made absolute against that URL, so a link in the
// saved file still works. Playwright Chromium prints it to
// `<out>/<slug>-v<version>.pdf` (default `apps/web/dist/legal-pdf/`).
//
// CI runs it from `.github/workflows/legal-pdf.yml`, which uploads the file to R2
// for the publish step on `/admin/legal` to hash. The page loads no webfont or
// network resource, so the run needs only the Chromium binary
// (`pnpm --filter @aeci/web exec playwright install chromium`).
//
// `--content-dir` points at another copy of `src/content/legal/` with the same
// layout. It exists so the script can be checked against a fixture outside the
// tracked tree. CI never passes it.
//
// The slug → filename map is read from `LEGAL_SOURCE_FILES` in
// `src/app/legal/legal-slugs.ts`, so the two never drift.

import { chromium } from '@playwright/test';
import { Marked } from 'marked';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '..');
const SLUGS_FILE = join(WEB_ROOT, 'src/app/legal/legal-slugs.ts');
const SITE_ORIGIN = 'https://www.aecintegrations.com';
const VERSION_RE = /^\d+(?:\.\d+)*$/;

class UsageError extends Error {}

function fail(message) {
  throw new UsageError(message);
}

function parseArgs(argv) {
  const positional = [];
  let out = join(WEB_ROOT, 'dist/legal-pdf');
  let contentDir = join(WEB_ROOT, 'src/content/legal');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' || argv[i] === '--content-dir') {
      const dir = argv[i + 1];
      if (!dir) fail(`${argv[i]} needs a directory`);
      if (argv[i] === '--out') out = resolve(dir);
      else contentDir = resolve(dir);
      i++;
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 2) fail('expected <slug> and <version>');
  return { slug: positional[0], version: positional[1], out, contentDir };
}

/** `LEGAL_SOURCE_FILES` from `legal-slugs.ts`, as a slug → filename object. */
async function sourceFiles() {
  const text = await readFile(SLUGS_FILE, 'utf8');
  const block = text.match(/LEGAL_SOURCE_FILES[^=]*=\s*\{([\s\S]*?)\};/);
  if (!block) throw new Error(`could not find LEGAL_SOURCE_FILES in ${SLUGS_FILE}`);
  const files = {};
  for (const [, key, file] of block[1].matchAll(/'?([a-z0-9-]+)'?\s*:\s*'([^']+\.md)'/g)) {
    files[key] = file;
  }
  if (Object.keys(files).length === 0) throw new Error('LEGAL_SOURCE_FILES parsed empty');
  return files;
}

/** Scalar `key: value` frontmatter, the same rules as `legal-frontmatter.ts`. */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: raw };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (!line.trim() || sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (key) data[key] = line.slice(sep + 1).trim();
  }
  return { data, body: raw.slice(match[0].length).replace(/^(?:\r?\n)+/, '') };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The Markdown for <slug> <version>, or a usage error. */
async function loadSource(slug, version, contentDir) {
  const files = await sourceFiles();
  if (!(slug in files)) fail(`unknown slug "${slug}" (known: ${Object.keys(files).join(', ')})`);
  if (!VERSION_RE.test(version)) fail(`"${version}" is not a version like 1.2`);

  const versioned = join(contentDir, 'versions', slug, `v${version}.md`);
  if (existsSync(versioned)) return { path: versioned, raw: await readFile(versioned, 'utf8') };

  const current = join(contentDir, files[slug]);
  if (!existsSync(current)) fail(`no file for ${slug} ${version}: ${current} does not exist`);
  const raw = await readFile(current, 'utf8');
  const currentVersion = parseFrontmatter(raw).data.version;
  if (currentVersion === version) return { path: current, raw };
  fail(
    `no file for ${slug} ${version}: versions/${slug}/v${version}.md does not exist and the current ${files[slug]} is version ${currentVersion}`,
  );
}

/** The body as HTML, with every link resolved against the version's own URL. */
function renderBody(body, versionUrl) {
  const marked = new Marked({
    gfm: true,
    async: false,
    walkTokens(token) {
      if (token.type === 'link' || token.type === 'image') {
        token.href = new URL(token.href, versionUrl).href;
      }
    },
  });
  return marked.parse(body);
}

function printHtml({ title, version, effective, bodyHtml }) {
  return `<!doctype html>
<html lang="en-US">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}, version ${escapeHtml(version)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; margin: 0; }
  header { border-bottom: 1px solid #999; padding-bottom: 12pt; margin-bottom: 18pt; }
  .eyebrow { font-family: Helvetica, Arial, sans-serif; font-size: 9pt; letter-spacing: 0.08em; text-transform: uppercase; color: #555; margin: 0; }
  h1 { font-size: 22pt; font-weight: normal; margin: 6pt 0; }
  .meta { font-family: Helvetica, Arial, sans-serif; font-size: 10pt; color: #333; margin: 0; }
  h2 { font-size: 14pt; margin: 18pt 0 6pt; break-after: avoid; }
  h3 { font-size: 12pt; margin: 12pt 0 4pt; break-after: avoid; }
  p, li { orphans: 3; widows: 3; }
  blockquote { border-left: 3px solid #999; margin: 12pt 0; padding: 0 12pt; color: #333; }
  a { color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #999; padding: 4pt 6pt; text-align: left; vertical-align: top; }
</style>
</head>
<body>
<header>
  <p class="eyebrow">AEC Integrations</p>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">Version ${escapeHtml(version)}, effective ${escapeHtml(effective)}</p>
</header>
<main>
${bodyHtml}
</main>
</body>
</html>`;
}

async function main() {
  const { slug, version, out, contentDir } = parseArgs(process.argv.slice(2));
  const { path, raw } = await loadSource(slug, version, contentDir);
  const { data, body } = parseFrontmatter(raw);
  if (data.version !== version) fail(`${path} names version "${data.version}", not ${version}`);
  const effective = (data.effective_date ?? '').trim();
  if (!effective) {
    fail(
      `${path} has no effective_date. A saved copy must name the day it takes effect, so set it before printing.`,
    );
  }

  const versionUrl = `${SITE_ORIGIN}/legal/${slug}/v${version}`;
  const html = printHtml({
    title: data.title || slug,
    version,
    effective,
    bodyHtml: renderBody(body, versionUrl),
  });

  const footer = `<div style="width: 100%; font-family: Helvetica, Arial, sans-serif; font-size: 8pt; color: #555; padding: 0 0.75in; display: flex; justify-content: space-between;"><span>${escapeHtml(versionUrl)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;

  await mkdir(out, { recursive: true });
  const file = join(out, `${slug}-v${version}.pdf`);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // No network: the page is self-contained.
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: file,
      format: 'Letter',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: footer,
      margin: { top: '0.75in', bottom: '0.75in', left: '0.75in', right: '0.75in' },
    });
  } finally {
    await browser.close();
  }
  console.log(file);
}

main().catch((err) => {
  console.error(`legal-pdf: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof UsageError) {
    console.error('Usage: legal-pdf.mjs <slug> <version> [--out <dir>] [--content-dir <dir>]');
  }
  process.exit(1);
});

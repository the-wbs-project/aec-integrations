// Build mock-up 9w (AECI-2018): ../9-product-hero-wheel.html from 9w.css, 9w-harness.css,
// 9w.js, 9w-data.json and 9w-notes.html. The page's server HTML (the default state, at
// the 1440 desktop width) is rendered here by the same 9w.js the browser runs, so the
// file reads with script off exactly as the build's server render would.
//   node docs/design/mockups/redesign-2026-11/mockups/src/9w-build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), 'utf8');

const css = read('9w.css');
const harnessCss = read('9w-harness.css');
const js = read('9w.js');
const data = JSON.parse(read('9w-data.json'));
const notes = read('9w-notes.html');
// The reversed wordmark: the same symbol mock-up 9 draws in its header.
const home = readFileSync(join(here, '..', '9-home.html'), 'utf8');
const wm = home.slice(home.indexOf('<symbol id="wm"'), home.indexOf('</symbol>', home.indexOf('<symbol id="wm"')) + '</symbol>'.length);
const sprite = `<svg id="sprite" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">${wm}</svg>`;

const ctx = { WHEEL_DATA: data, URLSearchParams };
ctx.globalThis = ctx;
vm.runInNewContext(js, ctx);
const W = ctx.Wheel;
const page = W.renderPage(W.readState(''), W.stageFor(1440)).html;

const out = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${data.products.medium.name}: integrations and reviews</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:ital,wght@0,400..700;1,400..700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
${notes}
<style id="page-css">
${css}</style>
<style id="harness-css">
${harnessCss}</style>
</head>
<body>
${sprite}
<div id="page">${page}</div>
<script>window.WHEEL_DATA = ${JSON.stringify(data)};</script>
<script>
${js}</script>
</body>
</html>
`;
writeFileSync(join(here, '..', '9-product-hero-wheel.html'), out);
console.log('wrote 9-product-hero-wheel.html', out.length);

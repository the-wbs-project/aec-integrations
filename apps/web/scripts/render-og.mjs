// Render an OpenGraph share card (1200×630) to a committed PNG.
//
// Two cards today, one template each:
//
//   home            scripts/home-og-template.html            → public/branding/home-og.png (AECI-276)
//   vendor-program  scripts/vendor-program-og-template.html  → public/branding/vendor-program-og.png (AECI-1283)
//
// The PNG is the SHIPPED artifact. It is served at /branding/<card>-og.png by the
// Workers ASSETS binding. This script is a MANUAL dev tool (not wired into `ng build`
// or CI): edit the card's template, regenerate, then commit the new PNG.
//
//   pnpm --filter @aeci/web og:home
//   pnpm --filter @aeci/web og:vendor-program
//
// It uses Playwright's Chromium (already an apps/web devDependency) so the card
// renders Source Serif 4 + Atkinson Hyperlegible Next exactly as the live site does
// (fonts fetched from Google Fonts at render time, a one-time network dependency of
// this tool, never of the shipped site). If the browser binary is missing, run
// `npx playwright install chromium` once.
//
// Reproducibility note: the wordmark is a system-font lockup by design
// (branding/logo-construction.md), so the logo glyphs follow the generating OS's
// UI font (SF on macOS). Regenerate on the same platform for a byte-stable card.

import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { access } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CARDS = ['home', 'vendor-program'];

const WIDTH = 1200;
const HEIGHT = 630;

async function main() {
  const card = process.argv[2];
  if (!CARDS.includes(card)) {
    throw new Error(`Usage: render-og.mjs <${CARDS.join('|')}>`);
  }
  const TEMPLATE = resolve(__dirname, `${card}-og-template.html`);
  const OUTPUT = resolve(__dirname, `../public/branding/${card}-og.png`);

  await access(TEMPLATE);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
    });

    await page.goto(`file://${TEMPLATE}`, { waitUntil: 'networkidle' });

    // Make sure the two webfonts are actually painted before the screenshot, not
    // just requested. Otherwise the headline can fall back to Georgia. The
    // callback body runs in the browser context, so `document` is a browser global.
    /* eslint-disable no-undef -- evaluated in Chromium, not Node */
    await page.evaluate(async () => {
      await Promise.all([
        document.fonts.load("600 68px 'Source Serif 4'"),
        document.fonts.load("400 32px 'Atkinson Hyperlegible Next'"),
        document.fonts.load("600 24px 'Atkinson Hyperlegible Next'"),
      ]);
      await document.fonts.ready;
    });
    /* eslint-enable no-undef */

    await page.screenshot({
      path: OUTPUT,
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      animations: 'disabled',
    });

    console.log(`Wrote ${OUTPUT} (${WIDTH}×${HEIGHT})`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Failed to render OG card:', err);
  process.exitCode = 1;
});

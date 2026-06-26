// Render the home OpenGraph share card (1200×630) to a committed PNG (AECI-276).
//
// The PNG is the SHIPPED artifact — it lives at apps/web/public/branding/home-og.png
// and is served at /branding/home-og.png by the Workers ASSETS binding. This script
// is a MANUAL dev tool (not wired into `ng build` or CI): edit
// scripts/home-og-template.html, regenerate, then commit the new PNG.
//
//   pnpm --filter @aeci/web og:home
//
// It uses Playwright's Chromium (already an apps/web devDependency) so the card
// renders Source Serif 4 + Atkinson Hyperlegible Next exactly as the live site does
// (fonts fetched from Google Fonts at render time — a one-time network dependency of
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
const TEMPLATE = resolve(__dirname, 'home-og-template.html');
const OUTPUT = resolve(__dirname, '../public/branding/home-og.png');

const WIDTH = 1200;
const HEIGHT = 630;

async function main() {
  await access(TEMPLATE);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
    });

    await page.goto(`file://${TEMPLATE}`, { waitUntil: 'networkidle' });

    // Make sure the two webfonts are actually painted before the screenshot, not
    // just requested — otherwise the headline can fall back to Georgia. The
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
  console.error('Failed to render home OG card:', err);
  process.exitCode = 1;
});

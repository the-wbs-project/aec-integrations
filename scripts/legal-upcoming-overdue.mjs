#!/usr/bin/env node
/**
 * A WARNING, never a failure (AECI-1689): an upcoming legal version is past its
 * effective moment by more than 14 days and its bump-day cleanup has not landed.
 *
 * Since AECI-1689 the site switches to an upcoming version at 12:00 UTC of its
 * `effectiveOn` with no deploy, so the bump (move the file, add the archive entry,
 * bump the constants, remove the `LEGAL_UPCOMING` entry) is cleanup with no deadline.
 * The legal README asks for it within two weeks. This script is the reminder.
 *
 * It must never turn `main` red because a date passed. So it always exits 0, prints a
 * GitHub `::warning::` annotation per overdue entry, and `deploy.yml` runs it with
 * `continue-on-error: true` as well. It reads the manifest as text, so it needs no
 * install and no build.
 *
 *   node scripts/legal-upcoming-overdue.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The README's cleanup window. */
export const OVERDUE_DAYS = 14;
/** The effective hour, UTC (`LEGAL_EFFECTIVE_HOUR_UTC` in `@aeci/shared`). */
export const EFFECTIVE_HOUR_UTC = 12;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = join(ROOT, 'apps/web/src/app/legal/legal-manifest.ts');

/** The `LEGAL_UPCOMING` entries of the manifest source: `{ slug, version, effectiveOn }`. */
export function upcomingEntries(source) {
  const block = source.match(/export const LEGAL_UPCOMING\b[^=]*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error('legal-manifest.ts has no LEGAL_UPCOMING array');
  const entries = [];
  for (const [, body] of block[1].matchAll(/\{([^}]*)\}/g)) {
    const field = (name) => body.match(new RegExp(`${name}:\\s*'([^']*)'`))?.[1];
    const slug = field('slug');
    const version = field('version');
    const effectiveOn = field('effectiveOn');
    if (slug && version && effectiveOn) entries.push({ slug, version, effectiveOn });
  }
  return entries;
}

/** 12:00 UTC of `YYYY-MM-DD`, epoch ms, or NaN. */
export function effectiveMomentMs(effectiveOn) {
  const m = String(effectiveOn).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), EFFECTIVE_HOUR_UTC) : NaN;
}

/** The entries more than {@link OVERDUE_DAYS} days past their moment at `nowMs`. */
export function overdueEntries(entries, nowMs) {
  return entries.filter((e) => {
    const at = effectiveMomentMs(e.effectiveOn);
    return Number.isFinite(at) && nowMs - at > OVERDUE_DAYS * 86_400_000;
  });
}

/** One annotation line per overdue entry. */
export function warningLines(entries) {
  return entries.map(
    (e) =>
      `::warning title=Legal bump overdue::/legal/${e.slug} version ${e.version} took effect on ${e.effectiveOn} and is still in LEGAL_UPCOMING. Run the bump-day cleanup (apps/web/src/content/legal/README.md).`,
  );
}

export function main(nowMs = Date.now(), log = console.log, read = readFileSync) {
  try {
    const lines = warningLines(overdueEntries(upcomingEntries(read(MANIFEST, 'utf8')), nowMs));
    for (const line of lines) log(line);
    if (lines.length === 0) log('No upcoming legal version is overdue for its bump.');
  } catch (error) {
    // Still exit 0: this is a reminder, never a gate.
    log(`::warning title=Legal bump check::${error instanceof Error ? error.message : error}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}

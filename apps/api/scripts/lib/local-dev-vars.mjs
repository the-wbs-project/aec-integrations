/**
 * Shared helpers for the local-convenience grant scripts
 * (`grant-local-admin.mjs`, `grant-local-vendor.mjs`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LOCAL_DATABASE = 'aeci-app-preview';
const DEV_VARS = join(PACKAGE_ROOT, '.dev.vars');

/** The shape a Supabase `sub` actually has. Ids are interpolated into SQL. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `pnpm run` puts `node_modules/.bin` on PATH, but a bare `node scripts/…`
 * does not — and that direct form is what the docs hand you for a one-off
 * grant. Resolve the workspace binary first so both invocations work, falling
 * back to PATH.
 */
export function wranglerBin() {
  for (const candidate of [
    join(PACKAGE_ROOT, 'node_modules', '.bin', 'wrangler'),
    join(PACKAGE_ROOT, '..', '..', 'node_modules', '.bin', 'wrangler'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'wrangler';
}

/**
 * Reads one key out of `.dev.vars`. Parsed by hand rather than via Node's
 * `--env-file`, which throws when the file is absent — and an absent
 * `.dev.vars` is the normal state of a workspace nobody has configured yet.
 */
export function readDevVar(name) {
  let contents;
  try {
    contents = readFileSync(DEV_VARS, 'utf8');
  } catch {
    return '';
  }
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== name) continue;
    // Tolerate quoted values; wrangler accepts both forms.
    return trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return '';
}

#!/usr/bin/env node
/**
 * Grant `role='admin'` in the LOCAL D1 to your own Supabase user (AECI-765).
 *
 * Why this exists: `/admin/*` authorizes server-side against a D1 `profiles`
 * row whose `id` equals the Supabase `auth.users.id` (`requireAdmin()` in
 * `src/lib/authz.ts` re-reads `profiles.role` on every request), and a 401/403
 * is deliberately rendered as a 404. `seed/auth-fixtures.sql` seeds the shared
 * e2e personas, whose ids will never match a real login — so signing in as
 * yourself still yields 404 until a row exists for YOUR id. That row lived
 * nowhere, so it was lost on every fresh workspace.
 *
 * The id comes from `LOCAL_ADMIN_USER_ID` in `apps/api/.dev.vars`, which
 * Conductor copies into every new workspace (`file_include_globs`), so the
 * grant follows you rather than being re-derived each time. Runs as the last
 * step of `db:seed:local`.
 *
 * Contract: it ALWAYS exits 0. Empty / absent / no `.dev.vars` at all, a
 * malformed id, or a wrangler failure each print a line and move on — this is
 * the last step of `db:seed:local`, which `pnpm dev` / `dev:agent` run before
 * booting, so a non-zero exit here would take the dev server down over a
 * local-convenience grant.
 *
 * Usage:
 *   pnpm --filter @aeci/api db:grant-admin:local            # reads .dev.vars
 *   node scripts/grant-local-admin.mjs <supabase-user-id>   # explicit override
 *
 * Finding your id: sign in at the local SSR origin, then read it back —
 *   wrangler d1 execute aeci-app-preview --local --command \
 *     "SELECT id, display_name, role FROM profiles"
 * The magic-link callback's non-fatal `POST /api/auth/profile/ensure` creates
 * the row as `role='reviewer'`; this script promotes it. One id works in every
 * workspace and every environment (single shared auth project, ADR 0017).
 *
 * See docs/environments.md → "Local dev: Supabase auth (Phase 5)".
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_VARS = join(PACKAGE_ROOT, '.dev.vars');
const VAR_NAME = 'LOCAL_ADMIN_USER_ID';
const DATABASE = 'aeci-app-preview';

/**
 * `pnpm run` puts `node_modules/.bin` on PATH, but a bare
 * `node scripts/grant-local-admin.mjs` does not — and that direct form is what
 * the docs hand you for the one-off grant. Resolve the workspace binary first
 * so both invocations work, falling back to PATH.
 */
function wranglerBin() {
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
function readDevVar(name) {
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

const userId = (process.argv[2] ?? process.env[VAR_NAME] ?? readDevVar(VAR_NAME)).trim();

if (!userId) {
  console.log(
    `[grant-local-admin] ${VAR_NAME} is unset — skipping. Set it in apps/api/.dev.vars ` +
      'to make /admin/* reachable locally (docs/environments.md → "Local dev: Supabase auth").',
  );
  process.exit(0);
}

// The id is interpolated into SQL, so constrain it to the shape a Supabase
// `sub` actually has rather than trusting a hand-edited local file.
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
  console.error(
    `[grant-local-admin] ERROR — ${VAR_NAME} is not a UUID: ${JSON.stringify(userId)}. ` +
      'Expected a Supabase auth.users id (the JWT `sub`). Leaving the local D1 untouched.',
  );
  process.exit(0);
}

// `created_at` / `updated_at` are `text NOT NULL` with NO SQL default — Drizzle
// fills them via `$defaultFn` at insert time, so a raw INSERT must supply them
// or it fails `NOT NULL constraint failed: profiles.created_at`. Same shape as
// seed/auth-fixtures.sql. Idempotent: re-running only refreshes updated_at.
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const sql =
  `INSERT INTO "profiles" ("id", "display_name", "role", "created_at", "updated_at") ` +
  `VALUES ('${userId}', 'Local Admin (LOCAL_ADMIN_USER_ID)', 'admin', ${NOW}, ${NOW}) ` +
  `ON CONFLICT("id") DO UPDATE SET "role" = 'admin', "updated_at" = ${NOW};`;

try {
  execFileSync(wranglerBin(), ['d1', 'execute', DATABASE, '--local', '--command', sql, '--json'], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
} catch (error) {
  // Warn, don't throw. This runs as the last step of `db:seed:local`, which
  // `pnpm dev` / `dev:agent` run before booting — failing here would take the
  // whole dev server down over a local-convenience grant. The commonest cause
  // is an unmigrated D1 (`no such table: profiles`), which the migrate step
  // ahead of this one in `db:setup:local` already fixes.
  console.error(`[grant-local-admin] ERROR — wrangler d1 execute failed: ${error.message}`);
  process.exit(0);
}

console.log(`[grant-local-admin] ${userId} → role='admin' in the local D1.`);

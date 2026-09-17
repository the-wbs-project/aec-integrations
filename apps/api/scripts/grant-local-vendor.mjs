#!/usr/bin/env node
/**
 * Seat your own second Supabase account as a vendor admin in the LOCAL D1, so
 * the vendor portal is reachable while developing it.
 *
 * Why a second account: `requireVendor()` (`src/lib/authz.ts`) rejects site
 * admins, so the id in `LOCAL_ADMIN_USER_ID` can never open `/vendor`. The
 * seeded `vendor@thewbsproject.com` persona works for e2e but needs its
 * password. This grants whichever account you sign in with locally.
 *
 * Reads from `apps/api/.dev.vars` (Conductor copies it into every workspace):
 *   LOCAL_VENDOR_USER_ID  your Supabase `auth.users.id` (the JWT `sub`)
 *   LOCAL_VENDOR_SLUG     the vendor to seat it on; default `autodesk`, the
 *                         seeded verified vendor with the most products
 *
 * The row gets `role='vendor_admin'`, that vendor's id, and `seat_owner = 1`
 * so the Seats page's invite controls render. If the id is the same as
 * `LOCAL_ADMIN_USER_ID` the script refuses: it would demote your admin row.
 *
 * Contract: it ALWAYS exits 0, like `grant-local-admin.mjs`. It runs as the
 * last step of `db:seed:local`, which `pnpm dev` / `dev:agent` run before
 * booting, so a failure here must not take the dev server down.
 *
 * Usage:
 *   pnpm --filter @aeci/api db:grant-vendor:local                    # reads .dev.vars
 *   node scripts/grant-local-vendor.mjs <supabase-user-id> [slug]    # explicit override
 *
 * See docs/environments.md → "Local dev: Supabase auth (Phase 5)".
 */

import { execFileSync } from 'node:child_process';

import {
  LOCAL_DATABASE,
  PACKAGE_ROOT,
  UUID_RE,
  readDevVar,
  wranglerBin,
} from './lib/local-dev-vars.mjs';

const TAG = '[grant-local-vendor]';
const read = (name) => (process.env[name] ?? readDevVar(name)).trim();

const userId = (process.argv[2] ?? read('LOCAL_VENDOR_USER_ID')).trim();
const slug = (process.argv[3] ?? read('LOCAL_VENDOR_SLUG')).trim() || 'autodesk';

if (!userId) {
  console.log(`${TAG} LOCAL_VENDOR_USER_ID is unset — skipping.`);
  process.exit(0);
}
if (!UUID_RE.test(userId)) {
  console.error(`${TAG} ERROR — LOCAL_VENDOR_USER_ID is not a UUID: ${JSON.stringify(userId)}.`);
  process.exit(0);
}
if (!/^[a-z0-9-]+$/.test(slug)) {
  console.error(`${TAG} ERROR — LOCAL_VENDOR_SLUG is not a slug: ${JSON.stringify(slug)}.`);
  process.exit(0);
}
if (userId.toLowerCase() === read('LOCAL_ADMIN_USER_ID').toLowerCase()) {
  console.error(
    `${TAG} ERROR — LOCAL_VENDOR_USER_ID equals LOCAL_ADMIN_USER_ID. A site admin cannot ` +
      'hold a vendor seat, and granting one would demote your admin row. Use a second account.',
  );
  process.exit(0);
}

const wrangler = (sql) =>
  execFileSync(
    wranglerBin(),
    ['d1', 'execute', LOCAL_DATABASE, '--local', '--command', sql, '--json'],
    {
      cwd: PACKAGE_ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    },
  );

try {
  const [lookup] = JSON.parse(wrangler(`SELECT id FROM vendors WHERE slug = '${slug}';`));
  const vendorId = lookup?.results?.[0]?.id;
  if (!vendorId) {
    console.error(`${TAG} ERROR — no vendor with slug '${slug}' in the local D1. Nothing granted.`);
    process.exit(0);
  }

  // `created_at` / `updated_at` have no SQL default (Drizzle fills them), so a
  // raw INSERT must supply them. Idempotent.
  const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  wrangler(
    `INSERT INTO "profiles" ("id", "display_name", "role", "vendor_id", "seat_owner", "created_at", "updated_at") ` +
      `VALUES ('${userId}', 'Local Vendor (LOCAL_VENDOR_USER_ID)', 'vendor_admin', '${vendorId}', 1, ${NOW}, ${NOW}) ` +
      `ON CONFLICT("id") DO UPDATE SET "role" = 'vendor_admin', "vendor_id" = '${vendorId}', ` +
      `"seat_owner" = 1, "updated_at" = ${NOW};`,
  );
  console.log(`${TAG} ${userId} → vendor_admin of '${slug}' in the local D1. Open /vendor.`);
} catch (error) {
  console.error(`${TAG} ERROR — wrangler d1 execute failed: ${error.message}`);
}
process.exit(0);

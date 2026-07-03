import { defineConfig } from 'vitest/config';

// Integration tests that hit a real Supabase service rather than Miniflare.
// Run separately from the unit suite so missing env vars don't break the
// default `pnpm test` lane.
//
// Post-D1 migration (PR #359, AECI-248→257) this lane holds a SINGLE spec:
// src/integration/user-auth.jwks.spec.ts — a live ES256 JWKS regression guard
// for requireUserAuth() (auth is retained on Supabase; the app DB is D1). The
// former Postgres suites (bulk-migrate, product-counts/backfill-slugs whole-table
// scans, the *.rls deny matrices) that needed serial, single-Postgres isolation
// were deleted; see .github/workflows/integration-db-tests.yml.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/integration/**/*.spec.ts'],
    // Kept serial (harmless with one spec) so that any DB-touching integration
    // spec re-added here is bracketed against a single shared Supabase, not run
    // concurrently — the failure mode the old Postgres suites hit under AECI-90.
    fileParallelism: false,
  },
});

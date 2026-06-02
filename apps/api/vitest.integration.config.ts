import { defineConfig } from 'vitest/config';

// Integration tests that hit real services (Supabase PostgREST, etc).
// Run separately from the unit suite so missing env vars don't break the
// default `pnpm test` lane.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/integration/**/*.spec.ts'],
    // These suites all share ONE Postgres (TEST_DATABASE_URL / the local
    // Supabase stack). Several scan the whole table — backfillSlugs and
    // findProductCountDrift both read every product row — so running files
    // concurrently lets one suite's in-flight rows pollute another's whole-DB
    // assertion (e.g. bulk-migrate's products tripping backfill-slugs'
    // idempotency check). Run files serially; each suite's beforeAll/afterAll
    // then fully brackets its own data. Surfaced by the AECI-90 CI job.
    fileParallelism: false,
  },
});

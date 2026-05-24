import { defineConfig } from 'vitest/config';

// Integration tests that hit real services (Supabase PostgREST, etc).
// Run separately from the unit suite so missing env vars don't break the
// default `pnpm test` lane.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/integration/**/*.spec.ts'],
  },
});

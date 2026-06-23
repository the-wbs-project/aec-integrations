import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config (ADR 0016 / AECI-252). Generates flat SQLite migration SQL
 * from `src/db/schema.ts` into `apps/api/migrations/` — which is wrangler's
 * default `migrations_dir`, so `wrangler d1 migrations apply` consumes the output
 * directly (no `migrations_pattern` override needed). Drizzle is used here ONLY to
 * GENERATE migrations; they are APPLIED by `wrangler d1 migrations apply`
 * (local + per-env), never by `drizzle-kit migrate`/`push`. This mirrors the old
 * "Supabase CLI owns apply" split, now D1-native.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});

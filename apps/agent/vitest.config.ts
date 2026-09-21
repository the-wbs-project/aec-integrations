import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // `cloudflare:workers` is a workerd built-in and does not resolve under
      // node. `src/app.ts` and `src/agents/catalog.ts` import `env` from it, so
      // the specifier is aliased to a stub for the test run only. See
      // `src/test/cloudflare-workers.ts`.
      'cloudflare:workers': fileURLToPath(
        new URL('./src/test/cloudflare-workers.ts', import.meta.url),
      ),
    },
  },
  test: {
    // Node env: the agent's tools are plain functions over the D1 binding, so
    // they are exercised the same way apps/api does it — against the in-memory
    // better-sqlite3 shim in `src/test/d1.ts`, which applies the REAL apps/api
    // migrations, so schema, foreign keys and CHECK constraints are real.
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/env.ts', '**/*.spec.ts', 'src/test/**'],
    },
  },
});

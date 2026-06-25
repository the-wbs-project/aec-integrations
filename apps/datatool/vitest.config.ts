import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node env: the copy/seed engines are exercised against an in-memory
    // better-sqlite3 D1 shim (src/test/d1.ts), same approach as apps/api.
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/env.ts', 'src/ui.ts', '**/*.spec.ts', 'src/test/**'],
    },
  },
});

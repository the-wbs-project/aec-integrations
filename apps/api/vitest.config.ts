import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Integration tests live in src/integration/** and run via
    // `pnpm test:integration` (vitest.integration.config.ts). Keep them out
    // of the default unit lane so missing live-service env vars never break
    // the main test run.
    exclude: ['src/integration/**', 'node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/env.ts',
        // Thin factory — exercises Prisma + Accelerate at Worker runtime,
        // mocked at the handler boundary per DATABASE_SCHEMA.md §1a.
        'src/prisma.ts',
        'src/test/**',
        '**/*.spec.ts',
        'prisma/**',
      ],
      thresholds: {
        lines: 70,
        branches: 60,
        functions: 70,
        statements: 70,
      },
    },
  },
});

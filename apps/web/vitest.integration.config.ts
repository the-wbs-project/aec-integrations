import { defineConfig } from 'vitest/config';

// Vitest config for Miniflare-based Worker integration tests.
//
// Why a separate config: integration tests boot a Miniflare environment per
// suite and run slower than the unit suite. Keeping them in their own config
// keeps `pnpm test:unit` fast and lets CI parallelise them on a different
// runner if needed.
//
// Phase 1.19 scaffolds this config with no specs yet (TESTING_STRATEGY.md §6
// pattern). Phase 2+ feature tasks land the first real integration tests.

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    // Miniflare boot + module evaluation can run long on a cold runner.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // No tests is not a failure in Phase 1.19 — the harness ships empty so
    // Phase 2+ tasks can add specs without touching the config.
    passWithNoTests: true,
  },
});

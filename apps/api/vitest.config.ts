import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const cloudflareWorkersStub = fileURLToPath(
  new URL('./src/test/cloudflare-workers-stub.ts', import.meta.url),
);

export default defineConfig({
  // The unit lane runs in plain Node, which cannot resolve the `cloudflare:*` built-in
  // module specifiers. `workflows/promote-workflow.ts` needs `WorkflowEntrypoint` +
  // `NonRetryableError` at runtime, and `src/index.ts` re-exports the Workflow class — so
  // every spec that touches either (including `ssr-binding.spec.ts`) needs this alias.
  // See `src/test/cloudflare-workers-stub.ts`.
  resolve: {
    alias: {
      'cloudflare:workers': cloudflareWorkersStub,
      'cloudflare:workflows': cloudflareWorkersStub,
    },
  },
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
      exclude: ['src/index.ts', 'src/env.ts', 'src/test/**', '**/*.spec.ts'],
      thresholds: {
        lines: 70,
        branches: 60,
        functions: 70,
        statements: 70,
      },
    },
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    // Angular component specs run through the Angular build pipeline, not
    // Vitest. We scope Vitest to non-Angular server-side modules
    // (e.g. `server-api-client.spec.ts`). `.integration.spec.ts` files run
    // via `vitest.integration.config.ts` (Miniflare).
    exclude: [
      "src/**/*.component.spec.ts",
      "src/**/*.integration.spec.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Vitest only exercises server-side Worker modules (server-runtime,
      // server-api-client, etc.). Angular UI in src/app/** is covered by
      // the Angular build pipeline + E2E suite, not Vitest — including it
      // here would float false-low coverage numbers.
      include: ["src/*.ts"],
      exclude: [
        "src/main.ts",
        "src/main.server.ts",
        "src/server.ts",
        "src/**/*.spec.ts",
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

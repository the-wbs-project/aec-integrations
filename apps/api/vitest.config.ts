import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/env.ts",
        // Thin factory — exercises Prisma + Accelerate at Worker runtime,
        // mocked at the handler boundary per DATABASE_SCHEMA.md §1a.
        "src/prisma.ts",
        "src/test/**",
        "**/*.spec.ts",
        "prisma/**",
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

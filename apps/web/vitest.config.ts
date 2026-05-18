import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    // Angular component specs run through the Angular build pipeline, not
    // Vitest. We scope Vitest to non-Angular server-side modules
    // (e.g. `server-api-client.spec.ts`).
    exclude: ["src/**/*.component.spec.ts"],
  },
});

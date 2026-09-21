/**
 * Stand-in for the `cloudflare:workers` built-in module under `vitest` (node).
 *
 * `src/app.ts` and `src/agents/catalog.ts` import `env` from `cloudflare:workers`
 * — the only way to reach bindings at module scope in a Flue agent. That
 * specifier exists only inside workerd, so a node test importing either module
 * fails to resolve it. `vitest.config.ts` aliases the specifier here.
 *
 * `AI` is a no-op binding rather than `undefined` because `src/app.ts` calls
 * `cloudflareBindingProvider({ binding: env.AI, … })` at module scope. The stub
 * only has to be constructible; no test drives a model, and nothing here reaches
 * Workers AI or Anthropic.
 */
export const env = {
  AI: {
    run: async () => ({}),
  },
} as unknown as Record<string, unknown>;

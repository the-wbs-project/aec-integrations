/**
 * The agent's tool set, in ONE place.
 *
 * Two reasons this is a registry rather than five imports in the agent file:
 *
 *  1. **Both agents mount the identical set.** `Catalog` and `CatalogClaude`
 *     differ only in `useModel(...)` — that is the whole point of the pairing,
 *     since the spike compares two models over one harness. A second import list
 *     would let them drift.
 *  2. **The privacy test is data-driven off this function.** `index.spec.ts`
 *     runs EVERY tool this returns and asserts no denied column name appears in
 *     its output (`src/lib/columns.ts`). A tool added here is covered
 *     automatically; a tool that bypasses the registry is not mounted either, so
 *     there is no way to ship one the test has not seen.
 *
 * Tools take their bindings by argument, never from module scope, so a spec can
 * pass the in-memory D1 shim and a stub fetcher.
 */
import type { ToolDefinition } from '@flue/runtime';

import type { ApiCaller } from '../lib/api-client';
import { countIntegrationsTool } from './count-integrations';
import { findProductsTool } from './find-products';
import { getPairTool } from './get-pair';
import { getProductTool } from './get-product';
import { getVendorTool } from './get-vendor';
import { searchCatalogTool } from './search-catalog';

/**
 * The bindings the catalog tools need. Narrower than `Env` so specs can stub it.
 *
 * `AI_SEARCH` is `unknown` for the same reason it is `unknown` in `src/env.ts`:
 * `@cloudflare/workers-types` ships no type for it. `search-catalog.ts` narrows
 * it at its single call site rather than making every consumer of this type
 * trust a hand-written guess.
 */
export type CatalogToolDeps = {
  DB: D1Database;
  AI_SEARCH: unknown;
  ENV?: string;
  /** Optional. Absent → the Jev relevance filter cannot run at all. */
  TYPESAFE_API_KEY?: string;
} & ApiCaller;

/**
 * Per-conversation options the AGENT chooses, not the model.
 *
 * ── WHERE THE JEV TOGGLE LIVES, AND WHY NOT A TOOL ARGUMENT ─────────────────
 * The toggle enters here, from the agent function's `useInitialData()` — the
 * value a route records when it creates the conversation — because a tool
 * argument would put the MODEL in charge of whether its own retrieved context
 * gets screened for prompt injection, which is precisely the control an
 * injected passage would try to take.
 *
 * `useInitialData()` is Flue's route-passable seam: `POST /agents/catalog/:id`
 * carries `initialData`, it is validated once against the agent's schema and
 * recorded for the conversation's life, and nothing the model emits can reach
 * it. The step-6 chat page sets it when it opens a conversation.
 *
 * It is therefore per-CONVERSATION rather than per-HTTP-request. That is a
 * consequence of where Flue puts route data (a tool's `ToolContext` carries no
 * request), and it is the right grain anyway: the comparison this spike exists
 * to make is "this conversation was filtered, that one was not", and a toggle
 * that could flip mid-conversation would make a transcript uninterpretable.
 */
export type CatalogToolOptions = {
  /** True → screen retrieved passages with Jev, IF the secret is also present. */
  jevFilter?: boolean;
};

/**
 * The six catalog tools: two straight over D1, three over the API Worker's
 * public endpoints, and one over AI Search.
 */
export function createCatalogTools(
  env: CatalogToolDeps,
  options: CatalogToolOptions = {},
): ToolDefinition[] {
  return [
    findProductsTool(env.DB),
    countIntegrationsTool(env.DB),
    getProductTool(env),
    getVendorTool(env),
    getPairTool(env),
    searchCatalogTool(env.AI_SEARCH, env.ENV, {
      apiKey: env.TYPESAFE_API_KEY,
      enabled: options.jevFilter === true,
    }),
  ] as ToolDefinition[];
}

'use agent';
import { env } from 'cloudflare:workers';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';

import type { Env } from '../env';
import { createCatalogTools, type CatalogToolOptions } from '../tools/index';

/**
 * The catalog agent, mounted TWICE — once on a Workers AI model and once on
 * Claude — over ONE instruction string and ONE tool set.
 *
 * ── WHY TWO EXPORTS AND NOT A PARAMETER ─────────────────────────────────────
 * The spike's question is "which model answers catalog questions better over the
 * same harness", so the two must differ in exactly one thing. Everything shared
 * lives in {@link INSTRUCTION} and `createCatalogTools()`; each exported function
 * is four lines and a `useModel(...)`.
 *
 * ── EACH EXPORT IS A DURABLE OBJECT ─────────────────────────────────────────
 * The exported function NAME is the agent's storage identity. Flue generates one
 * Durable Object class and binding per agent, from that name:
 *
 *     Catalog        ->  class FlueCatalogAgent        binding FLUE_CATALOG_AGENT
 *     CatalogClaude  ->  class FlueCatalogClaudeAgent  binding FLUE_CATALOG_CLAUDE_AGENT
 *
 * So each needs its OWN `new_sqlite_classes` migration tag in `wrangler.jsonc`,
 * and renaming either function is a storage migration (`renamed_classes`), not a
 * rename. Renaming this FILE changes nothing.
 *
 * ── MODELS ──────────────────────────────────────────────────────────────────
 * Both legs go through the `AI` binding. Workers AI models are `cloudflare/@cf/…`
 * and Claude is `cloudflare/anthropic/…`, which Flue's built-in `cloudflare`
 * provider handles natively through AI Gateway Unified Billing. There is no
 * Anthropic API key and no Anthropic account. Model ids use DASHES
 * (`claude-sonnet-4-6`), never dots. The named gateway those calls route through
 * is pinned once in `src/app.ts`.
 */

/** The shared system instruction. One string, both agents. */
const INSTRUCTION = [
  'You answer questions about the AECi catalog: software products used in',
  'architecture, engineering and construction, the companies that make them, and',
  'the integrations between them.',
  '',
  'Answer only from the tools. The catalog is the source of truth and your own',
  'training data is not: it is stale, it does not know this catalog, and a',
  'plausible-sounding product or integration you did not look up is a fabrication.',
  'If the tools return nothing, say the catalog has no record of it.',
  '',
  'Work in this order. Use find_products to turn a product name into a slug.',
  'Use get_product or get_vendor for detail on one record. Use count_integrations',
  'for how many integrations a product has and how they are delivered. Use',
  'get_pair for whether two specific products integrate and what data flows.',
  '',
  'Be brief and concrete. Name products by their catalog name. Say who attested to',
  'an integration claim when the answer depends on it, because a vendor-confirmed',
  'claim and an unconfirmed one are not the same answer. Never rank or recommend a',
  'product on the basis of any commercial relationship; you cannot see one, and',
  'AECi does not sell placement.',
].join('\n');

/**
 * Conversation-creation data — the ONE knob a route may set, and the seam the
 * Jev relevance filter's per-request toggle arrives through.
 *
 * `v.optional` at the top level is load-bearing: Flue validates `initialData`
 * at the instance's first contact and REJECTS the creating send on a mismatch,
 * absence included, unless the schema accepts `undefined`. Every existing
 * conversation and every `curl` sends nothing, so a required schema would
 * turn this from a new option into a breaking change.
 *
 * It is also why the filter cannot be turned on by accident: the default of an
 * absent field is `false`, which is the same default the missing secret gives.
 */
const InitialData = v.optional(
  v.object({
    /** True → screen retrieved passages with Jev. Needs `TYPESAFE_API_KEY` too. */
    jevFilter: v.optional(v.boolean()),
  }),
);

/** Read the recorded creation data, with the model-proof default. */
function toolOptions(): CatalogToolOptions {
  const data = useInitialData<v.InferOutput<typeof InitialData>>();
  return { jevFilter: data?.jevFilter === true };
}

/** The Workers AI leg. */
export function Catalog() {
  useModel('cloudflare/@cf/zai-org/glm-5.3-flash');
  for (const tool of createCatalogTools(env as unknown as Env, toolOptions())) useTool(tool);
  return INSTRUCTION;
}
Catalog.initialData = InitialData;

/** The Claude leg — identical instruction, identical tools, different model. */
export function CatalogClaude() {
  useModel('cloudflare/anthropic/claude-sonnet-4-6');
  for (const tool of createCatalogTools(env as unknown as Env, toolOptions())) useTool(tool);
  return INSTRUCTION;
}
CatalogClaude.initialData = InitialData;

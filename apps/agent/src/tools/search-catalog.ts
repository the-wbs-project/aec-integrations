/**
 * `search_catalog` — semantic retrieval over the R2 corpus, via AI Search.
 *
 * ── PASSAGES, NOT AN ANSWER ─────────────────────────────────────────────────
 * AI Search (the service formerly called AutoRAG) exposes two shapes. `search()`
 * retrieves scored CHUNKS with their source references. `chatCompletions()` runs
 * retrieval AND generation, returning prose. We call `search()`.
 *
 * That is not a style preference. The answering model here IS the agent — Flue
 * has already chosen it, given it the system instruction, and given it five other
 * tools. Calling the generation form would put a SECOND, unbriefed model between
 * the corpus and the agent: its answer would arrive as an opaque paragraph with
 * no per-passage provenance, the agent would have to trust or re-derive it, and
 * the spike's actual question (which of two models answers catalog questions
 * better over one harness) would be measuring a third model nobody chose. So this
 * tool returns passages and the agent does the answering.
 *
 * Docs read for the call shape:
 *   https://developers.cloudflare.com/ai-search/api/search/workers-binding/
 *   https://developers.cloudflare.com/changelog/post/2026-04-16-ai-search-namespace-binding/
 *
 * ── WHY THE BINDING IS NARROWED HERE AND NOT IN `Env` ───────────────────────
 * `src/env.ts` types `AI_SEARCH` as `unknown` because
 * `@cloudflare/workers-types` ships no type for it yet. Widening `Env` to hold a
 * hand-written shape would make every other consumer of `Env` trust a guess. So
 * the interface lives here, next to the one call site that depends on it, and
 * {@link asAiSearch} is the single narrowing point: if the runtime shape turns
 * out to differ, exactly one function is wrong.
 *
 * ── NO `fetch` IN THIS MODULE ───────────────────────────────────────────────
 * The AECI-666 rule is "release every `fetch` response body you do not read".
 * There is no `fetch` here: the binding call is an RPC that returns a decoded
 * object, with no `Response` and no body to release. `search-catalog.spec.ts`
 * asserts that by scanning the source, so the rule stays discharged if someone
 * later adds an HTTP fallback — they will have to make the drain explicit.
 *
 * The optional Jev relevance filter DOES open a `fetch`, which is one reason it
 * lives in `src/lib/jev.ts` and not here: the drain rule, the bounded fan-out
 * and the data-egress note all belong next to the call that incurs them, and
 * the scan above stays a true statement about this file.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

import { CORPUS_PREFIX } from '../lib/corpus';
import {
  filterPassagesWithJev,
  type JevFilterOptions,
  type JevFilterOutcome,
  type JevFilterReport,
} from '../lib/jev';

/** Hard ceiling on passages returned, whatever the model asks for. AI Search's
 *  own `max_num_results` accepts 1-50; this is the tool's own, tighter cap. */
export const MAX_PASSAGES = 8;

/**
 * Minimum similarity for a chunk to be returned. AI Search's own default is 0.4;
 * this is not lowered, because a retrieval tool that always returns something is
 * a fabrication surface — "the catalog has no record of it" must stay reachable.
 */
export const MATCH_THRESHOLD = 0.4;

/**
 * The AI Search instance this Worker queries.
 *
 * The binding is a NAMESPACE binding on `default` (`wrangler.jsonc`
 * `ai_search_namespaces`), which is why an instance id is needed at call time —
 * a namespace binding reaches every instance in the namespace, so the caller
 * says which. Preview and production bind the same namespace on the same
 * account, so the id is tier-scoped: sharing one index across tiers would let a
 * preview reindex answer production questions.
 */
export function aiSearchInstanceId(tier: string | undefined): string {
  return `aeci-catalog-${tier === 'production' ? 'production' : 'preview'}`;
}

// ───────────────────────────────────────────────────────────────────────────
// The hand-written binding interface. See the docblock above for why it is here.
// ───────────────────────────────────────────────────────────────────────────

type AiSearchChunk = {
  id?: string;
  score?: number;
  text?: string;
  item?: { key?: string; metadata?: Record<string, unknown> };
};

type AiSearchResponse = { search_query?: string; chunks?: AiSearchChunk[] };

type AiSearchInstance = {
  search(options: {
    query: string;
    ai_search_options?: { retrieval?: { max_num_results?: number; match_threshold?: number } };
  }): Promise<AiSearchResponse>;
};

type AiSearchNamespace = { get(instanceId: string): AiSearchInstance };

/** The ONE place the `unknown` binding is narrowed. Returns null when absent. */
function asAiSearch(binding: unknown): AiSearchNamespace | null {
  if (binding === null || typeof binding !== 'object') return null;
  const candidate = binding as { get?: unknown };
  return typeof candidate.get === 'function' ? (binding as AiSearchNamespace) : null;
}

// ───────────────────────────────────────────────────────────────────────────
// Tool
// ───────────────────────────────────────────────────────────────────────────

/** One retrieved passage, with enough provenance for the agent to cite it. */
export type CatalogPassage = {
  /** Product slug, from the document's `slug` metadata or its R2 key. */
  slug: string | null;
  /** The document's `# ` heading when the chunk carries one, else null. */
  title: string | null;
  /** Primary vendor slug, from document metadata. */
  vendor: string | null;
  /** `application` | `connector` | `hybrid`, from document metadata. */
  role: string | null;
  score: number | null;
  text: string;
};

export const SearchCatalogInput = v.object({
  query: v.pipe(
    v.string(),
    v.description(
      'A natural-language question or phrase, e.g. "which estimating tools sync budgets to Sage".',
    ),
  ),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_PASSAGES))),
});

export type SearchCatalogArgs = v.InferOutput<typeof SearchCatalogInput>;

export type SearchCatalogResult = {
  query: string;
  count: number;
  passages: CatalogPassage[];
  /** Set only when retrieval could not run at all. */
  message?: string;
  /**
   * What the Jev relevance filter did, present ONLY when the caller asked for
   * it. Absent means nobody asked; `ran: false` with a `reason` means somebody
   * asked and it declined. Reporting this is the whole point of the feature —
   * filtered and unfiltered runs are only comparable if the run says which it
   * was, and how many passages it removed.
   */
  relevance_filter?: JevFilterReport;
};

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  JEV RELEVANCE FILTER SEAM
 * ─────────────────────────────────────────────────────────────────────────────
 * Takes the passages AI Search returned, judges each against the query, and
 * returns the subset worth showing the agent. The judging lives in
 * `src/lib/jev.ts` — that is where the `fetch` is, the thresholds are, and the
 * data-egress note is. This stays a named function so the insertion point is
 * unambiguous and so a spec can drive it directly.
 *
 * **It is OFF unless two independent things are true**: the `TYPESAFE_API_KEY`
 * secret exists AND the caller passed the per-request toggle. Neither alone
 * runs it, and with neither it returns its input unchanged having opened no
 * connection. That is the default and it must stay the default.
 */
export async function applyRelevanceFilter(
  passages: CatalogPassage[],
  query: string,
  options: JevFilterOptions = {},
): Promise<JevFilterOutcome<CatalogPassage>> {
  return filterPassagesWithJev(passages, query, options);
}

/** Recover a slug from a corpus object key (`products/<slug>.md`). */
function slugFromKey(key: string | undefined): string | null {
  if (!key || !key.startsWith(CORPUS_PREFIX)) return null;
  const rest = key.slice(CORPUS_PREFIX.length);
  return rest.endsWith('.md') ? rest.slice(0, -'.md'.length) : rest;
}

/**
 * Recover the document title from the passage text.
 *
 * The title is NOT in metadata, and that is a hard constraint rather than an
 * oversight: AI Search allows five custom metadata fields per instance and
 * `src/lib/corpus.ts` spends all five (`type`, `slug`, `vendor`, `role`,
 * `updated_at`). A chunk that does not contain the document's `# ` heading
 * therefore has no title, and the agent cites the slug instead.
 */
function titleFromText(text: string): string | null {
  for (const line of text.split('\n')) {
    if (line.startsWith('# ')) return line.slice(2).trim() || null;
  }
  return null;
}

function metaString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export async function searchCatalog(
  binding: unknown,
  tier: string | undefined,
  args: SearchCatalogArgs,
  jev: JevFilterOptions = {},
): Promise<SearchCatalogResult> {
  const query = args.query.trim();
  if (query === '') {
    return { query, count: 0, passages: [], message: 'An empty query retrieves nothing.' };
  }

  const namespace = asAiSearch(binding);
  if (!namespace) {
    return {
      query,
      count: 0,
      passages: [],
      message: 'Catalog search is unavailable: the AI Search binding is not configured.',
    };
  }

  const limit = Math.min(args.limit ?? MAX_PASSAGES, MAX_PASSAGES);

  let response: AiSearchResponse;
  try {
    response = await namespace.get(aiSearchInstanceId(tier)).search({
      query,
      ai_search_options: {
        retrieval: { max_num_results: limit, match_threshold: MATCH_THRESHOLD },
      },
    });
  } catch (error) {
    // Fail soft and say so. A thrown tool turns into an agent turn that cannot
    // recover; a message the model can read lets it fall back to find_products.
    return {
      query,
      count: 0,
      passages: [],
      message: `Catalog search failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const retrieved: CatalogPassage[] = (response.chunks ?? []).slice(0, limit).map((chunk) => {
    const text = typeof chunk.text === 'string' ? chunk.text : '';
    const metadata = chunk.item?.metadata;
    return {
      slug: metaString(metadata, 'slug') ?? slugFromKey(chunk.item?.key),
      title: titleFromText(text),
      vendor: metaString(metadata, 'vendor'),
      role: metaString(metadata, 'role'),
      score: typeof chunk.score === 'number' ? chunk.score : null,
      text,
    };
  });

  const { passages, report } = await applyRelevanceFilter(retrieved, query, jev);
  return {
    query,
    count: passages.length,
    passages,
    // Present only when the toggle asked for the filter. A run nobody asked to
    // filter reports nothing, so the shape of an unfiltered result is unchanged.
    ...(jev.enabled === true ? { relevance_filter: report } : {}),
  };
}

/**
 * Build the tool.
 *
 * `jev` comes from the TOOL FACTORY, never from the tool's input schema. The
 * model can ask what to search for; it cannot ask to have its own context
 * screening turned off. See `src/tools/index.ts` for where the toggle enters.
 */
export const searchCatalogTool = (
  binding: unknown,
  tier: string | undefined,
  jev: JevFilterOptions = {},
) =>
  defineTool({
    name: 'search_catalog',
    description:
      'Search the AECi catalog by meaning rather than by exact name. Takes a natural-language ' +
      'question and returns passages from product documents: description, taxonomy, the ' +
      'vendor-authored "how teams use it" narrative, and the integration list. Each passage names ' +
      'the product slug it came from, so follow up with get_product or get_pair for exact facts. ' +
      'Use this when you do not know which product to look up; use find_products when you already ' +
      `know the name. At most ${MAX_PASSAGES} passages.`,
    input: SearchCatalogInput,
    async run({ data }) {
      return { output: await searchCatalog(binding, tier, data, jev) };
    },
  });

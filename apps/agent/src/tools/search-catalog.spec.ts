import { describe, expect, it } from 'vitest';

import {
  aiSearchInstanceId,
  applyRelevanceFilter,
  MATCH_THRESHOLD,
  MAX_PASSAGES,
  SearchCatalogInput,
  searchCatalog,
  searchCatalogTool,
} from './search-catalog';

/**
 * A stub of the `ai_search_namespaces` binding: `env.AI_SEARCH.get(id).search()`.
 *
 * Shaped from the documented response
 * (https://developers.cloudflare.com/ai-search/api/search/workers-binding/):
 * `search()` returns `{ search_query, chunks: [{ id, score, text, item: { key,
 * metadata } }] }`. It is the PASSAGE form, not the generated-answer form —
 * `chatCompletions()` is what returns prose, and this tool deliberately does not
 * call it, because the answering model is the agent.
 */
function makeAiSearchStub(chunks: unknown[], options?: { throws?: Error }) {
  const calls: { instanceId: string; options: unknown }[] = [];
  const binding = {
    get(instanceId: string) {
      return {
        async search(searchOptions: unknown) {
          calls.push({ instanceId, options: searchOptions });
          if (options?.throws) throw options.throws;
          return { search_query: 'q', chunks };
        },
      };
    },
  };
  return { binding, calls };
}

const CHUNK = {
  id: 'c1',
  score: 0.81,
  text: '# Zoho\n\n- Slug: zoho\n\n## Description\n\nA business suite.',
  item: {
    key: 'products/zoho.md',
    metadata: { type: 'product', slug: 'zoho', vendor: 'acme', role: 'application' },
  },
};

describe('search_catalog — happy path', () => {
  it('returns passages with slug, title, vendor, role and score', async () => {
    // Guards: provenance. The agent must be able to cite what it used, and the
    // slug is what turns a passage into a get_product call.
    const stub = makeAiSearchStub([CHUNK]);
    const result = await searchCatalog(stub.binding, 'preview', { query: 'construction suite' });

    expect(result.count).toBe(1);
    expect(result.passages[0]).toEqual({
      slug: 'zoho',
      title: 'Zoho',
      vendor: 'acme',
      role: 'application',
      score: 0.81,
      text: CHUNK.text,
    });
    expect(result.message).toBeUndefined();
  });

  it('calls the PASSAGE form with a bounded result count and a match threshold', async () => {
    // Guards: the documented call shape. `search()` retrieves scored chunks;
    // `chatCompletions()` would generate prose from a second, unbriefed model.
    const stub = makeAiSearchStub([CHUNK]);
    await searchCatalog(stub.binding, 'preview', { query: 'estimating' });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.options).toEqual({
      query: 'estimating',
      ai_search_options: {
        retrieval: { max_num_results: MAX_PASSAGES, match_threshold: MATCH_THRESHOLD },
      },
    });
  });

  it('caps the result count at MAX_PASSAGES however many the model asks for', async () => {
    const stub = makeAiSearchStub(Array.from({ length: 20 }, () => CHUNK));
    const result = await searchCatalog(stub.binding, 'preview', { query: 'a', limit: 3 });
    expect(
      (stub.calls[0]?.options as { ai_search_options: { retrieval: { max_num_results: number } } })
        .ai_search_options.retrieval.max_num_results,
    ).toBe(3);
    expect(result.count).toBe(3);
  });

  it('falls back to the R2 key when metadata carries no slug', async () => {
    const stub = makeAiSearchStub([{ ...CHUNK, item: { key: 'products/procore.md' } }]);
    const result = await searchCatalog(stub.binding, 'preview', { query: 'a' });
    expect(result.passages[0]?.slug).toBe('procore');
  });

  it('reports a null title when the chunk carries no heading', async () => {
    // Guards: the five-key metadata budget. There is no room for a `title` key,
    // so a chunk cut below the `# ` heading has no title and the agent must cite
    // the slug instead.
    const stub = makeAiSearchStub([
      { ...CHUNK, text: '## Integrations (3)\n\n- eSUB (esub) — api' },
    ]);
    const result = await searchCatalog(stub.binding, 'preview', { query: 'a' });
    expect(result.passages[0]?.title).toBeNull();
    expect(result.passages[0]?.slug).toBe('zoho');
  });
});

describe('search_catalog — empty and failing results', () => {
  it('returns an empty list rather than an error when nothing matches', async () => {
    // Guards: "the catalog has no record of it" must stay reachable. A retrieval
    // tool that always returns something is a fabrication surface.
    const stub = makeAiSearchStub([]);
    const result = await searchCatalog(stub.binding, 'preview', { query: 'nonexistent' });
    expect(result).toEqual({ query: 'nonexistent', count: 0, passages: [] });
  });

  it('handles a response with no chunks field at all', async () => {
    const binding = { get: () => ({ search: async () => ({}) }) };
    const result = await searchCatalog(binding, 'preview', { query: 'a' });
    expect(result.count).toBe(0);
  });

  it('returns a readable message instead of throwing when the binding throws', async () => {
    // Guards: a thrown tool ends the agent turn with nothing it can act on. A
    // message lets the model fall back to find_products.
    const stub = makeAiSearchStub([], { throws: new Error('instance not found') });
    const result = await searchCatalog(stub.binding, 'preview', { query: 'a' });
    expect(result.count).toBe(0);
    expect(result.message).toContain('instance not found');
  });

  it('returns a message when the binding is not configured', async () => {
    // Guards: `AI_SEARCH` is typed `unknown`, and a Worker deployed before the
    // instance exists has no usable binding. That must not be a 500.
    for (const binding of [undefined, null, {}, 'nope']) {
      const result = await searchCatalog(binding, 'preview', { query: 'a' });
      expect(result.message).toContain('not configured');
    }
  });

  it('retrieves nothing for an empty query, without calling the binding', async () => {
    const stub = makeAiSearchStub([CHUNK]);
    const result = await searchCatalog(stub.binding, 'preview', { query: '   ' });
    expect(result.count).toBe(0);
    expect(stub.calls).toEqual([]);
  });
});

describe('the AI Search instance id', () => {
  it('is tier-scoped, so preview cannot answer production questions', async () => {
    // Guards: both wrangler env blocks bind the SAME `default` namespace on the
    // same account, so the instance id is the only thing keeping the two indexes
    // apart.
    expect(aiSearchInstanceId('production')).toBe('aeci-catalog-production');
    expect(aiSearchInstanceId('preview')).toBe('aeci-catalog-preview');
    expect(aiSearchInstanceId(undefined)).toBe('aeci-catalog-preview');

    const stub = makeAiSearchStub([CHUNK]);
    await searchCatalog(stub.binding, 'production', { query: 'a' });
    expect(stub.calls[0]?.instanceId).toBe('aeci-catalog-production');
  });
});

describe('the Jev relevance filter seam', () => {
  const PASSAGES = [
    { slug: 'zoho', title: 'Zoho', vendor: 'acme', role: 'application', score: 0.9, text: 'x' },
  ];

  it('is a no-op with no options at all — the default is OFF', async () => {
    // Guards: the seam's default. `src/lib/jev.spec.ts` owns the judging rules;
    // what matters here is that calling it with nothing changes nothing.
    const out = await applyRelevanceFilter(PASSAGES, 'q');
    expect(out.passages).toEqual(PASSAGES);
    expect(out.report.ran).toBe(false);
  });

  it('omits `relevance_filter` from the tool result when nobody asked for it', async () => {
    // Guards: an unfiltered run's shape is unchanged, so a transcript that
    // carries the key is proof the toggle was on.
    const stub = makeAiSearchStub([CHUNK]);
    const result = await searchCatalog(stub.binding, 'preview', { query: 'a' });
    expect(result.relevance_filter).toBeUndefined();
  });

  it('reports the filter when the toggle is on but the secret is missing', async () => {
    // Guards: requirement 1 at the tool boundary — the absent secret is
    // reported rather than silently behaving like a clean pass, and no fetch
    // is opened. The whole retrieved set survives.
    const stub = makeAiSearchStub([CHUNK]);
    const fetchCalls: unknown[] = [];
    const result = await searchCatalog(
      stub.binding,
      'preview',
      { query: 'a' },
      {
        enabled: true,
        fetchImpl: (async (...args: unknown[]) => {
          fetchCalls.push(args);
          throw new Error('should never be called');
        }) as unknown as typeof fetch,
      },
    );

    expect(fetchCalls).toEqual([]);
    expect(result.count).toBe(1);
    expect(result.relevance_filter).toEqual({
      ran: false,
      judged: 0,
      dropped: 0,
      drops: [],
      reason: 'no-api-key',
    });
  });

  it('drops a passage and reports the drop when both switches are on', async () => {
    // Guards: the reporting requirement. The count must reflect the FILTERED
    // set, and the result must say how many went and why.
    const stub = makeAiSearchStub([CHUNK, { ...CHUNK, id: 'c2' }]);
    let call = 0;
    const result = await searchCatalog(
      stub.binding,
      'preview',
      { query: 'a' },
      {
        enabled: true,
        apiKey: 'k',
        fetchImpl: (async () => {
          const weak = call++ === 1;
          return new Response(
            JSON.stringify({
              answers: {
                passage_is_relevant: { type: 'noul', noul: weak ? 0.02 : 0.95 },
                passage_instructs_the_system: { type: 'noul', noul: 0.01 },
              },
            }),
            { status: 200 },
          );
        }) as unknown as typeof fetch,
      },
    );

    expect(result.count).toBe(1);
    expect(result.passages).toHaveLength(1);
    expect(result.relevance_filter?.ran).toBe(true);
    expect(result.relevance_filter?.dropped).toBe(1);
    expect(result.relevance_filter?.drops[0]?.reason).toBe('irrelevant');
  });

  it('keeps the toggle and the key OUT of the tool input schema', async () => {
    // Guards: requirement 2's sharp edge. If the toggle were a tool argument the
    // MODEL would decide whether its own context gets screened for injection,
    // which is exactly the control a hostile passage would reach for. The tool
    // takes a query and a limit; the options arrive from the factory.
    expect(Object.keys(SearchCatalogInput.entries)).toEqual(['query', 'limit']);

    const stub = makeAiSearchStub([CHUNK]);
    const tool = searchCatalogTool(stub.binding, 'preview', { enabled: true, apiKey: 'k' });
    const source = JSON.stringify(tool.input ?? {});
    expect(source).not.toContain('jev');
    expect(source).not.toContain('apiKey');
    expect(tool.description.toLowerCase()).not.toContain('jev');
  });
});

describe('search_catalog — the AECI-666 rule', () => {
  it('opens no fetch at all, so there is no response body to release', async () => {
    // Guards: the binding call is an RPC that returns a decoded object — no
    // `Response`, no body, nothing to drain. If someone later adds an HTTP
    // fallback, this scan fails and they have to make `discardResponseBody`
    // explicit on every path that only reads `res.status`.
    const { readSourceWithoutComments } = await import('../test/source-scan');
    const src = readSourceWithoutComments(new URL('./search-catalog.ts', import.meta.url));
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\bnew\s+Request\b/);
  });
});

describe('the tool definition', () => {
  it('names itself and documents itself for the model', async () => {
    const stub = makeAiSearchStub([CHUNK]);
    const tool = searchCatalogTool(stub.binding, 'preview');
    expect(tool.name).toBe('search_catalog');
    expect(tool.description.length).toBeGreaterThan(60);

    const envelope = await (tool.run as (ctx: { data: unknown }) => Promise<{ output?: unknown }>)({
      data: { query: 'estimating' },
    });
    expect((envelope.output as { count: number }).count).toBe(1);
  });
});

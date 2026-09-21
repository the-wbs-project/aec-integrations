import { describe, expect, it } from 'vitest';

import { createCatalogTools } from './index';
import { DENIED_COLUMNS, DENIED_TABLES, findDeniedKeys } from '../lib/columns';
import { makeApiStub } from '../test/api-stub';
import { addEvidencedPair, addIntegration, IDS, seedCatalog } from '../test/catalog-fixture';
import type { ShimHandle } from '../test/d1';

/**
 * The privacy assertion, and the reason the tools live behind a registry.
 *
 * This suite is DATA-DRIVEN twice over: it iterates every tool
 * `createCatalogTools()` returns, and it checks their output against every name
 * in `DENIED_COLUMNS`. Adding a tool to the registry puts it under this test for
 * free; a tool that is not in the registry is not mounted on either agent
 * either, so there is no way to ship one this suite has not seen.
 *
 * AECI-779 is why the check is on OUTPUT and not on the SQL: `attestations.note`
 * was suppressed in one mapper and not the other, and the leak was only visible
 * in the payload.
 */

/**
 * A FAITHFUL stub of the API Worker's public payload.
 *
 * Not a leaky one, deliberately. The three entity tools do not re-filter their
 * upstream — the whole design is that `GET /api/products/:slug` and friends
 * already apply the shipped allowlists and mappers, so a second copy of that
 * rule here would be the AECI-779 shape all over again (one rule, two places,
 * one of them wrong). What this suite proves about those tools is that the
 * WRAPPER adds no denied key; what proves the payload itself is clean is
 * `apps/api`'s own test suite over those handlers.
 *
 * `note` is present on purpose: it IS reader-facing when a vendor wrote it, so
 * it must NOT be on the denylist.
 */
/**
 * A stub of the `ai_search_namespaces` binding, returning one passage shaped
 * like a real corpus chunk. The document it stands for is rendered by
 * `src/lib/corpus.ts`, whose own spec asserts the denylist over the markdown —
 * what THIS suite proves about `search_catalog` is that the tool wrapper adds no
 * denied key of its own on the way out.
 */
function aiSearchStub() {
  return {
    get: () => ({
      search: async () => ({
        search_query: 'q',
        chunks: [
          {
            id: 'c1',
            score: 0.8,
            text: '# Zoho\n\n- Slug: zoho',
            item: {
              key: 'products/zoho.md',
              metadata: { type: 'product', slug: 'zoho', vendor: 'acme', role: 'application' },
            },
          },
        ],
      }),
    }),
  };
}

function publicApiStub() {
  return makeApiStub(() => ({
    status: 200,
    body: {
      id: IDS.zoho,
      slug: 'zoho',
      name: 'Zoho',
      company_name: 'Acme Software',
      // Deliberately reader-facing — `readerFacingNote()` lets a vendor note
      // through, so denying the key `note` outright would be wrong.
      note: 'vendor-authored, reader facing',
      maintenance: { maintained_by: 'aeci', last_reviewed_at: null },
    },
  }));
}

async function invokeEveryTool(
  t: ShimHandle,
  stub: ReturnType<typeof makeApiStub>,
): Promise<{ name: string; output: unknown }[]> {
  const tools = createCatalogTools({
    DB: t.db,
    AI_SEARCH: aiSearchStub(),
    API: stub.fetcher as unknown as Fetcher,
  });

  const args: Record<string, unknown> = {
    find_products: {},
    count_integrations: { productSlug: 'zoho' },
    get_product: { slug: 'zoho' },
    get_vendor: { slug: 'acme' },
    get_pair: { slug: 'zoho', otherSlug: 'esub' },
    search_catalog: { query: 'estimating' },
  };

  const out: { name: string; output: unknown }[] = [];
  for (const tool of tools) {
    const data = args[tool.name];
    expect(data, `no fixture arguments for tool "${tool.name}"`).toBeDefined();
    const envelope = await (tool.run as (ctx: { data: unknown }) => Promise<{ output?: unknown }>)({
      data,
    });
    out.push({ name: tool.name, output: envelope.output });
  }
  return out;
}

describe('catalog tool registry', () => {
  it('registers exactly the six documented tools, with unique names', () => {
    // Guards: a duplicate name throws at tool-set assembly inside Flue, which is
    // a runtime failure in the agent rather than a build one.
    const stub = publicApiStub();
    const names = createCatalogTools({
      DB: {} as D1Database,
      AI_SEARCH: aiSearchStub(),
      API: stub.fetcher as unknown as Fetcher,
    }).map((t) => t.name);
    expect(names).toEqual([
      'find_products',
      'count_integrations',
      'get_product',
      'get_vendor',
      'get_pair',
      'search_catalog',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('leaves the Jev relevance filter OFF when no options are passed', async () => {
    // Guards: the registry's default. `createCatalogTools(env)` with no second
    // argument must not screen anything, whatever secrets the env carries —
    // both switches are opt-in and the toggle is one of them.
    const stub = publicApiStub();
    let fetched = 0;
    const tools = createCatalogTools({
      DB: {} as D1Database,
      AI_SEARCH: aiSearchStub(),
      API: stub.fetcher as unknown as Fetcher,
      TYPESAFE_API_KEY: 'a-real-looking-key',
    });
    const search = tools.find((t) => t.name === 'search_catalog')!;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched += 1;
      throw new Error('the filter must not call out when the toggle is off');
    }) as unknown as typeof fetch;

    try {
      const envelope = await (
        search.run as (ctx: { data: unknown }) => Promise<{ output?: unknown }>
      )({ data: { query: 'estimating' } });
      expect(fetched).toBe(0);
      expect((envelope.output as { relevance_filter?: unknown }).relevance_filter).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('never exposes the toggle or the key as a tool argument', () => {
    // Guards: the model must not be able to switch off the screening applied to
    // its own retrieved context. The toggle enters from the agent function's
    // `useInitialData()`, which nothing the model emits can reach.
    const stub = publicApiStub();
    const tools = createCatalogTools(
      {
        DB: {} as D1Database,
        AI_SEARCH: aiSearchStub(),
        API: stub.fetcher as unknown as Fetcher,
        TYPESAFE_API_KEY: 'k',
      },
      { jevFilter: true },
    );
    for (const tool of tools) {
      const schema = JSON.stringify(tool.input ?? {}).toLowerCase();
      for (const forbidden of ['jev', 'typesafe', 'apikey', 'threshold']) {
        expect(schema, `tool "${tool.name}" exposes "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });

  it('every tool has a description the model can act on', () => {
    // Guards: the description is the model's ONLY documentation for a tool.
    const stub = publicApiStub();
    for (const tool of createCatalogTools({
      DB: {} as D1Database,
      AI_SEARCH: aiSearchStub(),
      API: stub.fetcher as unknown as Fetcher,
    })) {
      expect(tool.description.length).toBeGreaterThan(60);
    }
  });

  it('NO tool emits any denied column name', async () => {
    // Guards: the point of the spike. Every row in D1 is public; the risk is an
    // INTERNAL COLUMN on a public table. The two D1 tools build their own output
    // here, so this catches a widened SELECT directly; the three entity tools are
    // checked for a wrapper that adds a key of its own.
    const t = await seedCatalog();
    addIntegration(t, 'i1', IDS.zoho, IDS.esub, 'api');
    addEvidencedPair(t, 'e1', IDS.zoho, IDS.isqft);
    const stub = publicApiStub();

    for (const { name, output } of await invokeEveryTool(t, stub)) {
      expect(findDeniedKeys(output), `tool "${name}" leaked a denied column`).toEqual([]);
    }
    t.dispose();
  });

  it.each(DENIED_COLUMNS)('no tool output contains the denied column "%s"', async (column) => {
    // Guards: the same assertion pivoted per column, so a failure names the
    // column rather than the tool. Adding a name to DENIED_COLUMNS extends the
    // suite without touching it.
    const t = await seedCatalog();
    addIntegration(t, 'i1', IDS.zoho, IDS.esub, 'api');
    const stub = publicApiStub();

    for (const { name, output } of await invokeEveryTool(t, stub)) {
      const leaked = findDeniedKeys(output).filter((path) => path.endsWith(`.${column}`));
      expect(leaked, `tool "${name}" leaked "${column}"`).toEqual([]);
    }
    t.dispose();
  });

  it.each(DENIED_TABLES)('no tool names the denied table "%s" in its SQL', async (table) => {
    // Guards: the whole-table ban. Checked against the SOURCE because a denied
    // table only shows up in output once someone selects from it, and by then it
    // has already shipped.
    const { readdirSync } = await import('node:fs');
    const { readSourceWithoutComments } = await import('../test/source-scan');
    const dir = new URL('.', import.meta.url);
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .map((f) => readSourceWithoutComments(new URL(f, dir)))
      .join('\n');
    expect(sources).not.toMatch(new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+${table}\\b`, 'i'));
  });
});

// ---------------------------------------------------------------------------
// MCP taxonomy tool: list categories / disciplines / project phases.
//
// Single read-only tool returning all three closed vocabularies the products
// table links to. Backed by the same KV-cached fetchers used elsewhere
// (services/airtable.ts: fetchCategories / fetchDisciplines /
// fetchProjectPhases), so repeat calls within the cache TTL are free.
//
// Exists so MCP clients (e.g. the adhoc research prompt) can resolve
// category / discipline / phase names → record IDs before calling
// update_product without needing direct Airtable access.
// ---------------------------------------------------------------------------
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from '../../env';
import {
  asString,
  fetchCategories,
  fetchDisciplines,
  fetchProjectPhases,
  type AirtableRecord,
} from '../../services/airtable';
import { err, ok, toMessage } from '../helpers';

interface TaxonomyItem {
  id: string;
  name: string;
}

function toItems(records: AirtableRecord[]): TaxonomyItem[] {
  return records
    .map((r) => ({ id: r.id, name: asString(r.fields['Name']) ?? '' }))
    .filter((t) => t.name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function registerTaxonomyTools(
  server: McpServer,
  getEnv: () => Env,
): void {
  server.tool(
    'list_taxonomy',
    'List the three closed vocabularies that products link to: categories, disciplines, and project phases. Each entry is { id, name }. Use these IDs (not names) when patching `category`, `supported_disciplines`, or `supported_project_phases` via update_product. Backed by KV cache; cheap to call once per session.',
    {},
    async () => {
      const env = getEnv();
      try {
        const [categories, disciplines, phases] = await Promise.all([
          fetchCategories(env),
          fetchDisciplines(env),
          fetchProjectPhases(env),
        ]);
        return ok({
          categories: toItems(categories),
          disciplines: toItems(disciplines),
          phases: toItems(phases),
        });
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );
}

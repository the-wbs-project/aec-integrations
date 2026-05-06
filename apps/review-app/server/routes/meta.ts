import { Hono } from 'hono';
import {
  fetchCategories,
  fetchDisciplines,
  fetchProjectPhases,
  fetchProducts,
  fetchVendors,
} from '../services/airtable';
import type { Env, MetaResponse } from '../types';

const meta = new Hono<{ Bindings: Env }>();

meta.get('/', async (c) => {
  const env = c.env;

  const [catRecs, discRecs, phaseRecs, toolRecs, vendorRecs] = await Promise.all([
    fetchCategories(env),
    fetchDisciplines(env),
    fetchProjectPhases(env),
    fetchProducts(env),
    fetchVendors(env),
  ]);

  // Collect unique singleSelect values from the Tools table
  const statusSet = new Set<string>();
  const tierSet = new Set<string>();
  const enrichmentSet = new Set<string>();
  for (const r of toolRecs) {
    const s = r.get('research_status');
    if (typeof s === 'string' && s.length > 0) statusSet.add(s);
    const t = r.get('priority_tier');
    if (typeof t === 'string' && t.length > 0) tierSet.add(t);
    const e = r.get('tool_enrichment_status');
    if (typeof e === 'string' && e.length > 0) enrichmentSet.add(e);
  }

  const toLinks = (
    recs: typeof catRecs,
    field: string,
  ) =>
    recs
      .map((r) => ({ id: r.id, name: (r.get(field) as string) ?? '' }))
      .filter((l) => l.name.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));

  const body: MetaResponse = {
    categories: toLinks(catRecs, 'Name'),
    disciplines: toLinks(discRecs, 'Name'),
    phases: toLinks(phaseRecs, 'Name'),
    vendors: toLinks(vendorRecs, 'company_name'),
    products: toLinks(toolRecs, 'Name'),
    researchStatuses: [...statusSet].sort(),
    priorityTiers: [...tierSet].sort(),
    toolEnrichmentStatuses: [...enrichmentSet].sort(),
  };

  return c.json(body);
});

export default meta;

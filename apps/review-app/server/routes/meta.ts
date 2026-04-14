import { Hono } from 'hono';
import {
  fetchCategories,
  fetchDisciplines,
  fetchProjectPhases,
  fetchTools,
} from '../airtable';
import { buildNameMap } from '../hydrate';
import type { Env, MetaResponse } from '../types';

const meta = new Hono<{ Bindings: Env }>();

meta.get('/', async (c) => {
  const env = c.env;

  const [catRecs, discRecs, phaseRecs, toolRecs] = await Promise.all([
    fetchCategories(env),
    fetchDisciplines(env),
    fetchProjectPhases(env),
    fetchTools(env),
  ]);

  // Collect unique research statuses from the Tools table
  const statusSet = new Set<string>();
  for (const r of toolRecs) {
    const s = r.get('Research Status');
    if (typeof s === 'string' && s.length > 0) statusSet.add(s);
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
    researchStatuses: [...statusSet].sort(),
  };

  return c.json(body);
});

export default meta;

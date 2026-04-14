import { Hono } from 'hono';
import { fetchIntegrations, fetchTools } from '../airtable';
import {
  buildLookupMaps,
  hydrateTool,
  hydrateToolDetail,
} from '../hydrate';
import type { Env, PaginatedResponse, Tool, ToolDetail } from '../types';

const tools = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// GET /api/tools — paginated, filterable, sortable list
// ---------------------------------------------------------------------------
tools.get('/', async (c) => {
  const env = c.env;

  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));
  const search = (c.req.query('search') ?? '').trim().toLowerCase();
  const categoryFilter = c.req.query('category') ?? '';
  const disciplineFilter = c.req.query('discipline') ?? '';
  const phaseFilter = c.req.query('phase') ?? '';
  const statusFilter = c.req.query('status') ?? '';
  const sortCol = c.req.query('sort') ?? 'name';
  const sortDir = c.req.query('direction') === 'desc' ? 'desc' : 'asc';

  const [rawTools, maps] = await Promise.all([
    fetchTools(env),
    buildLookupMaps(env),
  ]);

  // Hydrate all tools first so we can filter/sort on resolved names
  let hydrated = rawTools.map((r) => hydrateTool(r, maps));

  // --- Filtering -----------------------------------------------------------
  if (search) {
    hydrated = hydrated.filter((t) => {
      const haystack = [
        t.name,
        t.description ?? '',
        ...t.vendors.map((v) => v.name),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(search);
    });
  }

  if (categoryFilter) {
    hydrated = hydrated.filter((t) =>
      t.categories.some((cat) => cat.id === categoryFilter),
    );
  }

  if (disciplineFilter) {
    hydrated = hydrated.filter((t) =>
      t.disciplines.some((d) => d.id === disciplineFilter),
    );
  }

  if (phaseFilter) {
    hydrated = hydrated.filter((t) =>
      t.phases.some((p) => p.id === phaseFilter),
    );
  }

  if (statusFilter) {
    hydrated = hydrated.filter((t) => t.researchStatus === statusFilter);
  }

  // --- Sorting -------------------------------------------------------------
  const compare = (a: Tool, b: Tool): number => {
    let result = 0;
    switch (sortCol) {
      case 'vendor':
        result = (a.vendors[0]?.name ?? '').localeCompare(
          b.vendors[0]?.name ?? '',
        );
        break;
      case 'integrationCount':
        result = a.integrationCount - b.integrationCount;
        break;
      case 'researchStatus':
        result = (a.researchStatus ?? '').localeCompare(
          b.researchStatus ?? '',
        );
        break;
      case 'name':
      default:
        result = a.name.localeCompare(b.name);
        break;
    }
    return sortDir === 'desc' ? -result : result;
  };

  hydrated.sort(compare);

  // --- Pagination ----------------------------------------------------------
  const total = hydrated.length;
  const page = hydrated.slice(offset, offset + limit);

  const body: PaginatedResponse<Tool> = {
    data: page,
    total,
    offset,
    limit,
  };

  return c.json(body);
});

// ---------------------------------------------------------------------------
// GET /api/tools/:id — single tool with integration details
// ---------------------------------------------------------------------------
tools.get('/:id', async (c) => {
  const env = c.env;
  const toolId = c.req.param('id');

  const [rawTools, integrationRecs, maps] = await Promise.all([
    fetchTools(env),
    fetchIntegrations(env),
    buildLookupMaps(env),
  ]);

  const record = rawTools.find((r) => r.id === toolId);
  if (!record) {
    return c.json({ error: 'Tool not found' }, 404);
  }

  const detail: ToolDetail = hydrateToolDetail(record, maps, integrationRecs);
  return c.json(detail);
});

export default tools;

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
  const tierFilter = c.req.query('tier') ?? '';
  const enrichmentFilter = c.req.query('enrichmentStatus') ?? '';
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

  if (tierFilter) {
    hydrated = hydrated.filter((t) => t.priorityTier === tierFilter);
  }

  if (enrichmentFilter) {
    hydrated = hydrated.filter((t) => t.toolEnrichmentStatus === enrichmentFilter);
  }

  // --- Sorting -------------------------------------------------------------
  // For numeric fields, always push missing values to the end regardless of direction.
  const numericCompare = (a: number | undefined, b: number | undefined): number => {
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    const delta = a - b;
    return sortDir === 'desc' ? -delta : delta;
  };

  const compare = (a: Tool, b: Tool): number => {
    switch (sortCol) {
      case 'vendor': {
        const r = (a.vendors[0]?.name ?? '').localeCompare(b.vendors[0]?.name ?? '');
        return sortDir === 'desc' ? -r : r;
      }
      case 'integrationCount': {
        const r = a.integrationCount - b.integrationCount;
        return sortDir === 'desc' ? -r : r;
      }
      case 'researchStatus': {
        const r = (a.researchStatus ?? '').localeCompare(b.researchStatus ?? '');
        return sortDir === 'desc' ? -r : r;
      }
      case 'priorityScore':
        return numericCompare(a.priorityScore, b.priorityScore);
      case 'integrationScore':
        return numericCompare(a.integrationScore, b.integrationScore);
      case 'demandScore':
        return numericCompare(a.demandScore, b.demandScore);
      case 'outreachScore':
        return numericCompare(a.outreachScore, b.outreachScore);
      case 'dataCompleteness':
        return numericCompare(a.toolDataCompleteness, b.toolDataCompleteness);
      case 'priorityTier':
        return numericCompare(
          a.priorityTier ? Number(a.priorityTier) : undefined,
          b.priorityTier ? Number(b.priorityTier) : undefined,
        );
      case 'name':
      default: {
        const r = a.name.localeCompare(b.name);
        return sortDir === 'desc' ? -r : r;
      }
    }
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

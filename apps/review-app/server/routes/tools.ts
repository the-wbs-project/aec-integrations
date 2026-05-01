import { Hono } from 'hono';
import {
  createRecord,
  fetchIntegrations,
  fetchTools,
  tableId,
  updateRecord,
} from '../services/airtable';
import { cacheInvalidate } from '../services/cache';
import {
  buildLookupMaps,
  hydrateTool,
  hydrateToolDetail,
} from '../hydrate';
import type {
  CreateToolRequest,
  Env,
  PaginatedResponse,
  Tool,
  ToolDetail,
  UpdateToolRequest,
} from '../types';

// ---------------------------------------------------------------------------
// NOTE: write endpoints (POST, PATCH) require AIRTABLE_TOKEN to have the
// `data.records:write` scope on the configured base. Read tokens will 401.
// ---------------------------------------------------------------------------

const tools = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// GET /api/tools — paginated, filterable, sortable list
// ---------------------------------------------------------------------------
tools.get('/', async (c) => {
  const env = c.env;

  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));
  const rawLimit = Number(c.req.query('limit') ?? 50);
  // limit=0 (or non-positive) returns the full set; the grid virtualizes client-side.
  const limit = rawLimit > 0 ? Math.min(5000, rawLimit) : Number.POSITIVE_INFINITY;
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

  // Strings: empty values pushed to the end, like numerics.
  const stringCompare = (a: string | undefined, b: string | undefined): number => {
    const aEmpty = !a;
    const bEmpty = !b;
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    const r = a!.localeCompare(b!);
    return sortDir === 'desc' ? -r : r;
  };

  // Booleans: true first when asc, false first when desc.
  const booleanCompare = (a: boolean | undefined, b: boolean | undefined): number => {
    const aVal = a === true ? 1 : 0;
    const bVal = b === true ? 1 : 0;
    const delta = bVal - aVal; // true (1) sorts before false (0) in asc
    return sortDir === 'desc' ? -delta : delta;
  };

  const compare = (a: Tool, b: Tool): number => {
    switch (sortCol) {
      case 'vendor':
        return stringCompare(a.vendors[0]?.name, b.vendors[0]?.name);
      case 'integrationCount': {
        const r = a.integrationCount - b.integrationCount;
        return sortDir === 'desc' ? -r : r;
      }
      case 'researchStatus':
        return stringCompare(a.researchStatus, b.researchStatus);
      case 'enrichmentStatus':
        return stringCompare(a.toolEnrichmentStatus, b.toolEnrichmentStatus);
      case 'website':
        return stringCompare(a.website, b.website);
      case 'apiDocsUrl':
      case 'hasApiDocs':
        return booleanCompare(a.hasApiDocs, b.hasApiDocs);
      case 'integrationsUrl':
        return stringCompare(a.toolIntegrationsUrl, b.toolIntegrationsUrl);
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
      case 'priorityTier': {
        // Unscored / non-numeric tiers sort to the bottom regardless of dir.
        const tierToNum = (t: string | undefined): number | undefined => {
          if (!t) return undefined;
          const n = Number(t);
          return Number.isFinite(n) ? n : undefined;
        };
        return numericCompare(tierToNum(a.priorityTier), tierToNum(b.priorityTier));
      }
      case 'vendorVqsScore':
        return numericCompare(a.vendorVqsScore, b.vendorVqsScore);
      case 'name':
      default:
        return stringCompare(a.name, b.name);
    }
  };

  hydrated.sort(compare);

  // --- Pagination ----------------------------------------------------------
  const total = hydrated.length;
  const page = Number.isFinite(limit)
    ? hydrated.slice(offset, offset + limit)
    : hydrated.slice(offset);

  const body: PaginatedResponse<Tool> = {
    data: page,
    total,
    offset,
    limit: Number.isFinite(limit) ? limit : total,
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

  const detail: ToolDetail = hydrateToolDetail(
    record,
    maps,
    integrationRecs,
    rawTools,
  );
  return c.json(detail);
});

// ---------------------------------------------------------------------------
// POST /api/tools — create a new tool record
// Body: { name, description?, website? }
// New records default to research_status="Pending".
// ---------------------------------------------------------------------------
tools.post('/', async (c) => {
  const env = c.env;
  const body = (await c.req.json().catch(() => ({}))) as CreateToolRequest;

  const name = (body.name ?? '').trim();
  if (!name) {
    return c.json({ error: 'name is required' }, 400);
  }

  const fields: Record<string, unknown> = {
    Name: name,
    research_status: 'Pending',
  };
  if (body.description?.trim()) fields.description = body.description.trim();
  if (body.website?.trim()) fields.website = body.website.trim();

  let created;
  try {
    created = await createRecord(env, 'tools', fields);
  } catch (err) {
    return c.json({ error: (err as Error).message ?? 'Airtable create failed' }, 502);
  }

  await cacheInvalidate(env.KV_CACHE, `table:${tableId(env, 'tools')}`);

  const maps = await buildLookupMaps(env);
  const tool = hydrateTool(created, maps);
  return c.json(tool, 201);
});

// ---------------------------------------------------------------------------
// PATCH /api/tools/:id — partial update of a tool record
// ---------------------------------------------------------------------------
tools.patch('/:id', async (c) => {
  const env = c.env;
  const toolId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as UpdateToolRequest;

  const fields: Record<string, unknown> = {};
  // Scalars
  if (body.name !== undefined) fields['Name'] = body.name;
  if (body.description !== undefined) fields['description'] = body.description;
  if (body.website !== undefined) fields['website'] = body.website;
  if (body.toolIntegrationsUrl !== undefined)
    fields['tool_integrations_url'] = body.toolIntegrationsUrl;
  if (body.apiDocsUrl !== undefined) fields['api_docs_url'] = body.apiDocsUrl;
  if (body.hasApiDocs !== undefined) fields['has_api_docs'] = body.hasApiDocs;
  if (body.researchStatus !== undefined) fields['research_status'] = body.researchStatus;
  if (body.researchNotes !== undefined) fields['research_notes'] = body.researchNotes;
  if (body.toolIntegrationCheckNotes !== undefined)
    fields['tool_integration_check_notes'] = body.toolIntegrationCheckNotes;
  if (body.adminNotes !== undefined) fields['admin_notes'] = body.adminNotes;
  // Linked records (arrays of record IDs)
  if (body.categories !== undefined) fields['category'] = body.categories;
  if (body.disciplines !== undefined) fields['supported_disciplines'] = body.disciplines;
  if (body.phases !== undefined) fields['supported_project_phases'] = body.phases;
  if (body.vendors !== undefined) fields['vendors'] = body.vendors;

  if (Object.keys(fields).length === 0) {
    return c.json({ error: 'no editable fields in body' }, 400);
  }

  let updated;
  try {
    updated = await updateRecord(env, 'tools', toolId, fields);
  } catch (err) {
    return c.json({ error: (err as Error).message ?? 'Airtable update failed' }, 502);
  }

  await cacheInvalidate(env.KV_CACHE, `table:${tableId(env, 'tools')}`);

  const [integrationRecs, maps, rawTools] = await Promise.all([
    fetchIntegrations(env),
    buildLookupMaps(env),
    fetchTools(env),
  ]);
  const detail = hydrateToolDetail(updated, maps, integrationRecs, rawTools);
  return c.json(detail);
});

export default tools;

import { Hono } from 'hono';
import { fetchIntegrations } from '../services/airtable';
import { buildLookupMaps, hydrateIntegration } from '../hydrate';
import type { Env, IntegrationSummary, PaginatedResponse } from '../types';

const integrations = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// GET /api/integrations — paginated, filterable list of Integration records.
// Filters: search (name + description), sourceProduct, targetProduct,
// poweredByProduct, mechanismKind, maturity, pricingModel, builtBy.
// ---------------------------------------------------------------------------
integrations.get('/', async (c) => {
  const env = c.env;

  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));
  const rawLimit = Number(c.req.query('limit') ?? 50);
  const limit = rawLimit > 0 ? Math.min(5000, rawLimit) : Number.POSITIVE_INFINITY;
  const search = (c.req.query('search') ?? '').trim().toLowerCase();
  const sourceProductFilter = c.req.query('sourceProduct') ?? '';
  const targetProductFilter = c.req.query('targetProduct') ?? '';
  const poweredByFilter = c.req.query('poweredByProduct') ?? '';
  const mechanismKindFilter = c.req.query('mechanismKind') ?? '';
  const maturityFilter = c.req.query('maturity') ?? '';
  const pricingModelFilter = c.req.query('pricingModel') ?? '';
  const builtByFilter = c.req.query('builtBy') ?? '';
  const sortCol = c.req.query('sort') ?? 'name';
  const sortDir = c.req.query('direction') === 'desc' ? 'desc' : 'asc';

  const [rawIntegrations, maps] = await Promise.all([
    fetchIntegrations(env),
    buildLookupMaps(env),
  ]);

  let hydrated = rawIntegrations.map((r) => hydrateIntegration(r, maps));

  if (search) {
    hydrated = hydrated.filter((i) => {
      const haystack = [
        i.name,
        i.description ?? '',
        i.mechanismName ?? '',
        i.notes ?? '',
        i.sourceProduct?.name ?? '',
        i.targetProduct?.name ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(search);
    });
  }
  if (sourceProductFilter) {
    hydrated = hydrated.filter((i) => i.sourceProduct?.id === sourceProductFilter);
  }
  if (targetProductFilter) {
    hydrated = hydrated.filter((i) => i.targetProduct?.id === targetProductFilter);
  }
  if (poweredByFilter) {
    hydrated = hydrated.filter((i) => i.poweredByProduct?.id === poweredByFilter);
  }
  if (mechanismKindFilter) {
    hydrated = hydrated.filter((i) => i.mechanismKind === mechanismKindFilter);
  }
  if (maturityFilter) {
    hydrated = hydrated.filter((i) => i.maturity === maturityFilter);
  }
  if (pricingModelFilter) {
    hydrated = hydrated.filter((i) => i.pricingModel === pricingModelFilter);
  }
  if (builtByFilter) {
    hydrated = hydrated.filter((i) => i.builtBy?.id === builtByFilter);
  }

  const stringCompare = (a: string | undefined, b: string | undefined): number => {
    const aEmpty = !a;
    const bEmpty = !b;
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    const r = a!.localeCompare(b!);
    return sortDir === 'desc' ? -r : r;
  };

  const compare = (a: IntegrationSummary, b: IntegrationSummary): number => {
    switch (sortCol) {
      case 'sourceProduct':
        return stringCompare(a.sourceProduct?.name, b.sourceProduct?.name);
      case 'targetProduct':
        return stringCompare(a.targetProduct?.name, b.targetProduct?.name);
      case 'mechanismKind':
        return stringCompare(a.mechanismKind, b.mechanismKind);
      case 'poweredByProduct':
        return stringCompare(a.poweredByProduct?.name, b.poweredByProduct?.name);
      case 'maturity':
        return stringCompare(a.maturity, b.maturity);
      case 'builtBy':
        return stringCompare(a.builtBy?.name, b.builtBy?.name);
      case 'direction':
        return stringCompare(a.direction, b.direction);
      case 'name':
      default:
        return stringCompare(a.name, b.name);
    }
  };

  hydrated.sort(compare);

  const total = hydrated.length;
  const page = Number.isFinite(limit)
    ? hydrated.slice(offset, offset + limit)
    : hydrated.slice(offset);

  const body: PaginatedResponse<IntegrationSummary> = {
    data: page,
    total,
    offset,
    limit: Number.isFinite(limit) ? limit : total,
  };

  return c.json(body);
});

// ---------------------------------------------------------------------------
// GET /api/integrations/:id — single integration record
// ---------------------------------------------------------------------------
integrations.get('/:id', async (c) => {
  const env = c.env;
  const integrationId = c.req.param('id');

  const [rawIntegrations, maps] = await Promise.all([
    fetchIntegrations(env),
    buildLookupMaps(env),
  ]);

  const record = rawIntegrations.find((r) => r.id === integrationId);
  if (!record) {
    return c.json({ error: 'Integration not found' }, 404);
  }

  return c.json(hydrateIntegration(record, maps));
});

export default integrations;

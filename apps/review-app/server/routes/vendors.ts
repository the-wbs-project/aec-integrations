import { Hono } from 'hono';
import { fetchVendors } from '../airtable';
import {
  buildLookupMaps,
  hydrateVendor,
  hydrateVendorDetail,
} from '../hydrate';
import type { Env, PaginatedResponse, Vendor, VendorDetail } from '../types';

const vendors = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// GET /api/vendors — paginated, searchable, sortable list
// ---------------------------------------------------------------------------
vendors.get('/', async (c) => {
  const env = c.env;

  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));
  const search = (c.req.query('search') ?? '').trim().toLowerCase();
  const sortCol = c.req.query('sort') ?? 'companyName';
  const sortDir = c.req.query('direction') === 'desc' ? 'desc' : 'asc';

  const [rawVendors, maps] = await Promise.all([
    fetchVendors(env),
    buildLookupMaps(env),
  ]);

  let hydrated = rawVendors.map((r) => hydrateVendor(r, maps));

  // --- Search --------------------------------------------------------------
  if (search) {
    hydrated = hydrated.filter((v) =>
      v.companyName.toLowerCase().includes(search),
    );
  }

  // --- Sort ----------------------------------------------------------------
  const compare = (a: Vendor, b: Vendor): number => {
    let result = 0;
    switch (sortCol) {
      case 'toolCount':
        result = a.toolCount - b.toolCount;
        break;
      case 'foundedYear':
        result = (a.foundedYear ?? 0) - (b.foundedYear ?? 0);
        break;
      case 'companyName':
      default:
        result = a.companyName.localeCompare(b.companyName);
        break;
    }
    return sortDir === 'desc' ? -result : result;
  };

  hydrated.sort(compare);

  // --- Paginate ------------------------------------------------------------
  const total = hydrated.length;
  const page = hydrated.slice(offset, offset + limit);

  const body: PaginatedResponse<Vendor> = {
    data: page,
    total,
    offset,
    limit,
  };

  return c.json(body);
});

// ---------------------------------------------------------------------------
// GET /api/vendors/:id — single vendor with tool links
// ---------------------------------------------------------------------------
vendors.get('/:id', async (c) => {
  const env = c.env;
  const vendorId = c.req.param('id');

  const [rawVendors, maps] = await Promise.all([
    fetchVendors(env),
    buildLookupMaps(env),
  ]);

  const record = rawVendors.find((r) => r.id === vendorId);
  if (!record) {
    return c.json({ error: 'Vendor not found' }, 404);
  }

  const detail: VendorDetail = hydrateVendorDetail(record, maps);
  return c.json(detail);
});

export default vendors;

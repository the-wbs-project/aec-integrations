import { Hono } from 'hono';
import {
  fetchVendors,
  tableId,
  updateRecord,
} from '../services/airtable';
import { cacheInvalidate } from '../services/cache';
import {
  buildLookupMaps,
  hydrateVendor,
  hydrateVendorDetail,
} from '../hydrate';
import type {
  Env,
  PaginatedResponse,
  UpdateVendorRequest,
  Vendor,
  VendorDetail,
} from '../types';

// ---------------------------------------------------------------------------
// NOTE: write endpoints (PATCH) require AIRTABLE_TOKEN to have the
// `data.records:write` scope on the configured base. Read tokens will 401.
// ---------------------------------------------------------------------------

const vendors = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// GET /api/vendors — paginated, searchable, sortable list
// ---------------------------------------------------------------------------
vendors.get('/', async (c) => {
  const env = c.env;

  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));
  const rawLimit = Number(c.req.query('limit') ?? 50);
  // limit=0 (or non-positive) returns the full set; the grid virtualizes client-side.
  const limit = rawLimit > 0 ? Math.min(5000, rawLimit) : Number.POSITIVE_INFINITY;
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
  // For numeric fields, always push missing values to the end regardless of direction.
  const numericCompare = (a: number | undefined, b: number | undefined): number => {
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    const delta = a - b;
    return sortDir === 'desc' ? -delta : delta;
  };

  const compare = (a: Vendor, b: Vendor): number => {
    switch (sortCol) {
      case 'toolCount': {
        const r = a.toolCount - b.toolCount;
        return sortDir === 'desc' ? -r : r;
      }
      case 'foundedYear':
        return numericCompare(a.foundedYear, b.foundedYear);
      case 'githubStars':
        return numericCompare(a.githubStarsTotal, b.githubStarsTotal);
      case 'companyName':
      default: {
        const r = a.companyName.localeCompare(b.companyName);
        return sortDir === 'desc' ? -r : r;
      }
    }
  };

  hydrated.sort(compare);

  // --- Paginate ------------------------------------------------------------
  const total = hydrated.length;
  const page = Number.isFinite(limit)
    ? hydrated.slice(offset, offset + limit)
    : hydrated.slice(offset);

  const body: PaginatedResponse<Vendor> = {
    data: page,
    total,
    offset,
    limit: Number.isFinite(limit) ? limit : total,
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

// ---------------------------------------------------------------------------
// PATCH /api/vendors/:id — partial update of a vendor record
// ---------------------------------------------------------------------------
vendors.patch('/:id', async (c) => {
  const env = c.env;
  const vendorId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as UpdateVendorRequest;

  const fields: Record<string, unknown> = {};
  if (body.companyName !== undefined) fields['company_name'] = body.companyName;
  if (body.description !== undefined) fields['description'] = body.description;
  if (body.website !== undefined) fields['website'] = body.website;
  if (body.headquarters !== undefined) fields['headquarters'] = body.headquarters;
  if (body.foundedYear !== undefined) fields['founded_year'] = body.foundedYear;
  if (body.publicPrivate !== undefined) fields['public_private'] = body.publicPrivate;
  if (body.parentCompany !== undefined) fields['parent_company'] = body.parentCompany;
  if (body.linkedinUrl !== undefined) fields['linkedin_url'] = body.linkedinUrl;
  if (body.crunchbaseUrl !== undefined) fields['crunchbase_url'] = body.crunchbaseUrl;
  if (body.wikiUrl !== undefined) fields['wiki_url'] = body.wikiUrl;
  if (body.sourceUrl !== undefined) fields['source_url'] = body.sourceUrl;
  if (body.githubOrg !== undefined) fields['github_org'] = body.githubOrg;
  if (body.phoneNumber !== undefined) fields['phone_number'] = body.phoneNumber;
  if (body.contactEmail !== undefined) fields['contact_email'] = body.contactEmail;
  if (body.adminNotes !== undefined) fields['admin_notes'] = body.adminNotes;

  if (Object.keys(fields).length === 0) {
    return c.json({ error: 'no editable fields in body' }, 400);
  }

  let updated;
  try {
    updated = await updateRecord(env, 'vendors', vendorId, fields);
  } catch (err) {
    return c.json({ error: (err as Error).message ?? 'Airtable update failed' }, 502);
  }

  await cacheInvalidate(env.KV_CACHE, `table:${tableId(env, 'vendors')}`);

  const maps = await buildLookupMaps(env);
  const detail = hydrateVendorDetail(updated, maps);
  return c.json(detail);
});

export default vendors;

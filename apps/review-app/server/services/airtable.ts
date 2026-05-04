// ---------------------------------------------------------------------------
// Airtable client.
//
// One client serves two callers:
//   1. The data API (routes/tools.ts, vendors.ts, meta.ts, hydrate.ts) — wants
//      "give me all records from a table, cached" semantics, plus CRUD on
//      individual records. Hydration code reads fields via record.get(field).
//   2. The workflow runners (workflows/**) — fetch/update single records by
//      id, list records with filterByFormula/views. They read via
//      record.fields[key].
//
// Both styles share one `AirtableRecord` shape that exposes both `.fields` and
// `.get(field)`, so neither caller has to change shape.
// ---------------------------------------------------------------------------
import { cacheFetch } from './cache';
import type { Env, AirtableTables } from '../env';

const API_BASE = 'https://api.airtable.com/v0';

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
  createdTime?: string;
  /** SDK-compatible field accessor. Returns undefined when the field is unset. */
  get(field: string): unknown;
}

export interface ListOptions {
  filterByFormula?: string;
  pageSize?: number;
  view?: string;
  fields?: string[];
  maxRecords?: number;
  sort?: Array<{ field: string; direction?: 'asc' | 'desc' }>;
}

interface RawRecord {
  id: string;
  fields: Record<string, unknown>;
  createdTime?: string;
}

/** Wrap a raw REST record with a `.get(field)` accessor. */
function withGetter(rec: RawRecord): AirtableRecord {
  const fields = rec.fields ?? {};
  const record = {
    id: rec.id,
    fields,
    createdTime: rec.createdTime,
  };
  // Define .get() as non-enumerable so V8 structured-clone serialization
  // (used by Cloudflare Workflows step.do checkpoints) skips it. Functions
  // on enumerable own properties trigger DataCloneError.
  Object.defineProperty(record, 'get', {
    value: (field: string) => fields[field],
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return record as AirtableRecord;
}

function authHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

export function tableId(env: Env, key: keyof AirtableTables): string {
  return env.AIRTABLE_TABLES[key];
}

// ---------------------------------------------------------------------------
// Single-record CRUD — used by workflow runners and the data API write paths.
// ---------------------------------------------------------------------------

export async function getRecord(
  env: Env,
  table: keyof AirtableTables,
  recordId: string,
): Promise<AirtableRecord> {
  const url = `${API_BASE}/${env.AIRTABLE_BASE_ID}/${tableId(env, table)}/${recordId}`;
  const res = await fetch(url, { headers: authHeaders(env) });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Airtable getRecord ${table}/${recordId} failed: ${res.status} ${body}`);
  }
  return withGetter((await res.json()) as RawRecord);
}

export async function updateRecord(
  env: Env,
  table: keyof AirtableTables,
  recordId: string,
  fields: Record<string, unknown>,
  options: { typecast?: boolean } = { typecast: true },
): Promise<AirtableRecord> {
  const url = `${API_BASE}/${env.AIRTABLE_BASE_ID}/${tableId(env, table)}/${recordId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: authHeaders(env),
    body: JSON.stringify({ fields, typecast: options.typecast ?? true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Airtable updateRecord ${table}/${recordId} failed: ${res.status} ${body}`);
  }
  return withGetter((await res.json()) as RawRecord);
}

export async function deleteRecord(
  env: Env,
  table: keyof AirtableTables,
  recordId: string,
): Promise<void> {
  const url = `${API_BASE}/${env.AIRTABLE_BASE_ID}/${tableId(env, table)}/${recordId}`;
  const res = await fetch(url, { method: 'DELETE', headers: authHeaders(env) });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Airtable deleteRecord ${table}/${recordId} failed: ${res.status} ${body}`);
  }
}

export async function createRecord(
  env: Env,
  table: keyof AirtableTables,
  fields: Record<string, unknown>,
): Promise<AirtableRecord> {
  const url = `${API_BASE}/${env.AIRTABLE_BASE_ID}/${tableId(env, table)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Airtable createRecord ${table} failed: ${res.status} ${body}`);
  }
  return withGetter((await res.json()) as RawRecord);
}

// ---------------------------------------------------------------------------
// Filtered list — used by workflows for grouped pickers and ad-hoc queries.
// Returns ALL records matching the filter, paginating through Airtable
// 100-at-a-time pages until exhausted (or maxRecords is reached).
// ---------------------------------------------------------------------------
export async function listRecords(
  env: Env,
  table: keyof AirtableTables,
  options: ListOptions = {},
): Promise<AirtableRecord[]> {
  const records: AirtableRecord[] = [];
  let offset: string | undefined;
  do {
    const url = new URL(`${API_BASE}/${env.AIRTABLE_BASE_ID}/${tableId(env, table)}`);
    if (options.filterByFormula) url.searchParams.set('filterByFormula', options.filterByFormula);
    if (options.pageSize) url.searchParams.set('pageSize', String(options.pageSize));
    if (options.view) url.searchParams.set('view', options.view);
    if (options.fields) for (const f of options.fields) url.searchParams.append('fields[]', f);
    if (options.sort) {
      options.sort.forEach((s, i) => {
        url.searchParams.append(`sort[${i}][field]`, s.field);
        if (s.direction) url.searchParams.append(`sort[${i}][direction]`, s.direction);
      });
    }
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url.toString(), { headers: authHeaders(env) });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      throw new Error(`Airtable listRecords ${table} failed: ${res.status} ${body}`);
    }
    const page = (await res.json()) as { records: RawRecord[]; offset?: string };
    for (const r of page.records) records.push(withGetter(r));
    offset = page.offset;
    if (options.maxRecords && records.length >= options.maxRecords) {
      return records.slice(0, options.maxRecords);
    }
  } while (offset);
  return records;
}

// ---------------------------------------------------------------------------
// Cached "fetch entire table" helpers — back the data API.
// Cache key namespaces stay `table:<tableId>` so existing invalidation paths
// keep working.
// ---------------------------------------------------------------------------

interface StoredRecord {
  id: string;
  fields: Record<string, unknown>;
}

async function fetchAll(
  env: Env,
  table: keyof AirtableTables,
): Promise<AirtableRecord[]> {
  const id = tableId(env, table);
  const stored = await cacheFetch<StoredRecord[]>(
    env.KV_CACHE,
    `table:${id}`,
    async () => {
      const records = await listRecords(env, table);
      return records.map((r) => ({ id: r.id, fields: r.fields }));
    },
  );
  return stored.map(withGetter);
}

export function fetchProducts(env: Env) {
  return fetchAll(env, 'products');
}

export function fetchVendors(env: Env) {
  return fetchAll(env, 'vendors');
}

export function fetchCategories(env: Env) {
  return fetchAll(env, 'categories');
}

export function fetchDisciplines(env: Env) {
  return fetchAll(env, 'disciplines');
}

export function fetchProjectPhases(env: Env) {
  return fetchAll(env, 'projectPhases');
}

export function fetchIntegrations(env: Env) {
  return fetchAll(env, 'integrations');
}

// ---------------------------------------------------------------------------
// Coercion helpers used by both hydrate.ts and the workflow runners.
// ---------------------------------------------------------------------------
export function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

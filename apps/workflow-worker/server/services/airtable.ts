// ---------------------------------------------------------------------------
// Minimal Airtable REST client. Just the operations the workflows need:
//   - getRecord(table, id)
//   - updateRecord(table, id, fields)
//   - listRecords(table, { filterByFormula, pageSize, fields, view })
//
// We don't use the airtable npm package because we want full control over the
// HTTP boundary (rate-limit retries, typecasting, partial-page iteration).
// ---------------------------------------------------------------------------
import type { Env, AirtableTables } from '../env';

const API_BASE = 'https://api.airtable.com/v0';

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
  createdTime?: string;
}

export interface ListOptions {
  filterByFormula?: string;
  pageSize?: number;
  view?: string;
  fields?: string[];
  maxRecords?: number;
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
  return (await res.json()) as AirtableRecord;
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
  return (await res.json()) as AirtableRecord;
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
  return (await res.json()) as AirtableRecord;
}

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
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url.toString(), { headers: authHeaders(env) });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      throw new Error(`Airtable listRecords ${table} failed: ${res.status} ${body}`);
    }
    const page = (await res.json()) as { records: AirtableRecord[]; offset?: string };
    records.push(...page.records);
    offset = page.offset;
    if (options.maxRecords && records.length >= options.maxRecords) {
      return records.slice(0, options.maxRecords);
    }
  } while (offset);
  return records;
}

// ---------------------------------------------------------------------------
// Utility helpers — workflows pull values from records with consistent
// type coercion.
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

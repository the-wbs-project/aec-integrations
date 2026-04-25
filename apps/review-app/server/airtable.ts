// ---------------------------------------------------------------------------
// Airtable SDK wrapper — fetches entire tables and caches results in KV.
// ---------------------------------------------------------------------------
import Airtable from 'airtable';
import type { FieldSet, Record as AirtableRecord } from 'airtable';
import { cacheFetch } from './cache';
import type { Env } from './types';

function getBase(env: Env) {
  return new Airtable({ apiKey: env.AIRTABLE_TOKEN }).base(env.AIRTABLE_BASE_ID);
}

// ---------------------------------------------------------------------------
// Generic "fetch all records from a table" with KV caching.
// Airtable records are class instances — we store the raw fields + id,
// then reconstruct minimal record-like objects on cache hit.
// ---------------------------------------------------------------------------

interface StoredRecord {
  id: string;
  fields: Record<string, unknown>;
}

function toStorable(records: AirtableRecord<FieldSet>[]): StoredRecord[] {
  return records.map((r) => ({ id: r.id, fields: r.fields as Record<string, unknown> }));
}

function fromStored(stored: StoredRecord[]): AirtableRecord<FieldSet>[] {
  return stored.map((s) => ({
    id: s.id,
    fields: s.fields,
    get(field: string) { return s.fields[field]; },
  })) as unknown as AirtableRecord<FieldSet>[];
}

async function fetchAll(
  env: Env,
  tableId: string,
): Promise<AirtableRecord<FieldSet>[]> {
  const stored = await cacheFetch<StoredRecord[]>(
    env.CACHE,
    `table:${tableId}`,
    async () => {
      const base = getBase(env);
      const records = await base(tableId).select().all();
      return toStorable(records);
    },
  );
  return fromStored(stored);
}

// ---------------------------------------------------------------------------
// Public helpers — one per table
// ---------------------------------------------------------------------------
export function fetchTools(env: Env) {
  return fetchAll(env, env.AIRTABLE_TABLES.tools);
}

export function fetchVendors(env: Env) {
  return fetchAll(env, env.AIRTABLE_TABLES.vendors);
}

export function fetchCategories(env: Env) {
  return fetchAll(env, env.AIRTABLE_TABLES.categories);
}

export function fetchDisciplines(env: Env) {
  return fetchAll(env, env.AIRTABLE_TABLES.disciplines);
}

export function fetchProjectPhases(env: Env) {
  return fetchAll(env, env.AIRTABLE_TABLES.projectPhases);
}

export function fetchIntegrations(env: Env) {
  return fetchAll(env, env.AIRTABLE_TABLES.toolIntegrations);
}

// ---------------------------------------------------------------------------
// Write helpers — require AIRTABLE_TOKEN to have data.records:write scope.
// Callers are responsible for invalidating any affected `table:*` cache keys.
// ---------------------------------------------------------------------------
export async function createRecord(
  env: Env,
  tableId: string,
  fields: Record<string, unknown>,
): Promise<AirtableRecord<FieldSet>> {
  const base = getBase(env);
  const created = await base(tableId).create([{ fields: fields as FieldSet }]);
  return created[0];
}

export async function updateRecord(
  env: Env,
  tableId: string,
  recordId: string,
  fields: Record<string, unknown>,
): Promise<AirtableRecord<FieldSet>> {
  const base = getBase(env);
  return base(tableId).update(recordId, fields as FieldSet);
}

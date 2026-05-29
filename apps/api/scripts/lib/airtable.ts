/**
 * Minimal Airtable REST gateway for the one-time bulk migration (AECI-83).
 *
 * Deliberately dependency-free — uses the global `fetch` (Node 18+ / tsx) so
 * the migration script adds no npm package. Only the three operations the
 * migration needs are implemented:
 *
 *   - `listRecords`  — read all records of a table (paginated), optionally
 *                      filtered, with field values keyed by field NAME.
 *   - `ensureField`  — create the `supabase_uuid` field on a table if it does
 *                      not already exist (Airtable Metadata API).
 *   - `patchRecords` — write field values back to existing records (batched).
 *
 * `AirtableGateway` is an interface so the migration core can take an injected
 * gateway and tests can supply a fake (no network).
 *
 * Auth: a Personal Access Token (`AIRTABLE_PAT`) with `data.records:read`,
 * `data.records:write`, and `schema.bases:write` scopes on the target base.
 */

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

export interface AirtableGateway {
  /** Read every record of `tableId`, following pagination. */
  listRecords(
    tableId: string,
    opts?: { filterByFormula?: string; fields?: string[] },
  ): Promise<AirtableRecord[]>;
  /**
   * Ensure a field named `fieldName` of `type` exists on `tableId`. Returns
   * `{ created: true }` when it had to be created, `{ created: false }` when it
   * already existed. Idempotent.
   */
  ensureField(tableId: string, fieldName: string, type: string): Promise<{ created: boolean }>;
  /** Patch `fields` onto existing records, batched per Airtable's 10-record limit. */
  patchRecords(
    tableId: string,
    updates: { id: string; fields: Record<string, unknown> }[],
  ): Promise<void>;
}

const API_BASE = 'https://api.airtable.com/v0';
const PAGE_SIZE = 100;
const PATCH_BATCH = 10;
/** Airtable's documented limit is 5 req/s per base; stay comfortably under it. */
const THROTTLE_MS = 220;

type FetchLike = typeof fetch;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createAirtableGateway(config: {
  pat: string;
  baseId: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Throttle between requests (ms). Defaults to {@link THROTTLE_MS}; set 0 in tests. */
  throttleMs?: number;
}): AirtableGateway {
  const { pat, baseId } = config;
  const doFetch: FetchLike = config.fetchImpl ?? fetch;
  const throttleMs = config.throttleMs ?? THROTTLE_MS;

  const authHeaders = {
    Authorization: `Bearer ${pat}`,
    'Content-Type': 'application/json',
  };

  async function request(url: string, init?: RequestInit): Promise<unknown> {
    const res = await doFetch(url, { ...init, headers: { ...authHeaders, ...init?.headers } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Airtable ${init?.method ?? 'GET'} ${url} → ${res.status} ${res.statusText}: ${body}`,
      );
    }
    if (res.status === 204) return undefined;
    return res.json();
  }

  return {
    async listRecords(tableId, opts) {
      const records: AirtableRecord[] = [];
      let offset: string | undefined;

      do {
        const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
        if (opts?.filterByFormula) params.set('filterByFormula', opts.filterByFormula);
        if (opts?.fields) for (const f of opts.fields) params.append('fields[]', f);
        if (offset) params.set('offset', offset);

        const url = `${API_BASE}/${baseId}/${tableId}?${params.toString()}`;
        const page = (await request(url)) as { records: AirtableRecord[]; offset?: string };
        records.push(...page.records);
        offset = page.offset;
        if (offset && throttleMs) await sleep(throttleMs);
      } while (offset);

      return records;
    },

    async ensureField(tableId, fieldName, type) {
      const url = `${API_BASE}/meta/bases/${baseId}/tables`;
      const schema = (await request(url)) as {
        tables: { id: string; fields: { name: string }[] }[];
      };
      const table = schema.tables.find((t) => t.id === tableId);
      if (!table) throw new Error(`ensureField: table ${tableId} not found in base ${baseId}`);
      if (table.fields.some((f) => f.name === fieldName)) return { created: false };

      await request(`${API_BASE}/meta/bases/${baseId}/tables/${tableId}/fields`, {
        method: 'POST',
        body: JSON.stringify({ name: fieldName, type }),
      });
      return { created: true };
    },

    async patchRecords(tableId, updates) {
      for (let i = 0; i < updates.length; i += PATCH_BATCH) {
        const batch = updates.slice(i, i + PATCH_BATCH);
        await request(`${API_BASE}/${baseId}/${tableId}`, {
          method: 'PATCH',
          body: JSON.stringify({ records: batch }),
        });
        if (i + PATCH_BATCH < updates.length && throttleMs) await sleep(throttleMs);
      }
    },
  };
}

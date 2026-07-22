/**
 * Algolia batch write transport (AECI-139 / Phase 3.6).
 *
 * The single outbound call that mutates an Algolia index from the Worker
 * runtime: `POST https://{appId}.algolia.net/1/indexes/{index}/batch` with a
 * `{ requests: [{ action, body }] }` payload. Used by the daily incremental sync
 * (`scheduled`) and the post-promote index hook (`apps/api/src/lib/algolia-sync.ts`).
 *
 * This deliberately follows the same pure-transport pattern:
 *   - **Pure transport.** It performs no auth of its own caller; it only presents
 *     the Algolia application id + a write-capable API key. Callers decide
 *     *whether* to write (do they hold credentials?) and *what* to send.
 *   - **Never throws.** A missing credential, network error, or non-2xx upstream
 *     is returned as a structured `{ ok: false }` outcome so best-effort callers
 *     (`ctx.waitUntil`) can log/swallow without a try/catch.
 *   - **No `algoliasearch` SDK.** The Worker runtime must stay lean and the
 *     module dependency-free (`@aeci/shared` is imported by the `.mjs`/type-strip
 *     graph). The bulk-reindex CLI (AECI-138) uses the v5 SDK because it runs on
 *     Node; the Worker path uses raw `fetch` — both produce identical
 *     upsert-by-`objectID` semantics.
 *
 * Why a write client at all vs. the existing `AlgoliaSettingsClient` injection in
 * `./algolia.ts`: settings application is idempotent config (CI / bulk own it);
 * record save/delete is the per-row I/O this transport carries, and it needs the
 * `deleteObject` action the bulk client (`saveObjects`-only) never had.
 */

/**
 * Max batch operations per request. Algolia accepts up to ~1000 ops / 10 MB per
 * `batch` call; we stay conservative because product/integration records carry
 * free-text `description` fields. Callers chunk to this size.
 */
export const ALGOLIA_BATCH_MAX = 500;

/**
 * The two batch actions this sync uses. `updateObject` is an upsert by
 * `objectID` (add-or-replace, full record — NOT a partial merge, so fields
 * dropped by the transform are removed); `deleteObject` removes by `objectID`.
 * Matches the bulk script's `saveObjects` upsert end-state.
 */
export type AlgoliaBatchAction = 'updateObject' | 'deleteObject';

export type AlgoliaBatchRequest = {
  action: AlgoliaBatchAction;
  /**
   * For `updateObject`: the full record, including its `objectID`. For
   * `deleteObject`: `{ objectID }`.
   */
  body: Record<string, unknown>;
};

export type AlgoliaBatchCredentials = {
  /** Algolia application id (shared across envs). Absent → `algolia_credentials_missing`. */
  appId: string | undefined;
  /**
   * A write-capable API key — the per-env MANAGEMENT key (`addObject` /
   * `deleteObject` ACLs), NEVER the search-only key. Absent → `algolia_credentials_missing`.
   */
  apiKey: string | undefined;
};

export type AlgoliaBatchOutcome =
  | { ok: true; status: number; taskID?: number }
  | { ok: false; status: number; message: string };

/**
 * Send a batch of save/delete operations to one Algolia index. Never throws — a
 * missing credential, network error, or non-2xx upstream is returned as a
 * structured `{ ok: false }` outcome.
 *
 * `fetchImpl` is injected (defaults to the global `fetch`) so tests can supply a
 * mock without monkey-patching the global. An empty `requests` array is a no-op
 * (returns `{ ok: true }`) so callers needn't special-case "nothing changed".
 */
export async function callAlgoliaBatch(
  fetchImpl: typeof fetch,
  creds: AlgoliaBatchCredentials,
  indexName: string,
  requests: AlgoliaBatchRequest[],
): Promise<AlgoliaBatchOutcome> {
  if (!creds.appId || !creds.apiKey) {
    return { ok: false, status: 0, message: 'algolia_credentials_missing' };
  }
  if (requests.length === 0) {
    return { ok: true, status: 0 };
  }
  const url = `https://${creds.appId}.algolia.net/1/indexes/${encodeURIComponent(indexName)}/batch`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'x-algolia-application-id': creds.appId,
        'x-algolia-api-key': creds.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ requests }),
    });
    if (res.ok) {
      let taskID: number | undefined;
      try {
        const body = (await res.json()) as { taskID?: number };
        taskID = body?.taskID;
      } catch {
        // 2xx without a JSON body is still a success; taskID just stays undefined.
      }
      return { ok: true, status: res.status, taskID };
    }
    let message = res.statusText || 'algolia_failed';
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // Body wasn't JSON; the statusText is good enough.
    }
    return { ok: false, status: res.status, message };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : 'algolia_network_error',
    };
  }
}

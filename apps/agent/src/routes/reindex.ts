/**
 * `POST /admin/reindex` — rebuild the R2 corpus AI Search indexes.
 *
 * Operator-triggered, never model-triggered: it is not a tool, the agents cannot
 * reach it, and it sits behind the same `requireAccess()` gate as everything else
 * on this Worker (`src/app.ts` registers the wildcard middleware BEFORE every
 * mount, and `src/app.spec.ts` plus `reindex.spec.ts` both assert the 403).
 *
 * ── IT WRITES NO DOMAIN STATE, SO IT EMITS NO AUDIT ROW ─────────────────────
 * `STAGE_1_SPEC.md` §26.1 requires every write that changes DOMAIN STATE to emit
 * its `audit_log` row inside the SAME `db.batch()` as the mutation. This route
 * changes no domain state. It READS D1 and writes R2 objects that are a derived
 * projection of rows promote already wrote and already audited — the same class
 * as the Algolia index, `stats_cache` and `recompute-counts`, all of which ADR
 * 0022 exempts explicitly. Re-deriving the corpus twice produces the identical
 * bytes and changes nothing anybody could dispute.
 *
 * **Do not "fix" this by adding an audit write.** There is no batch to put it in
 * — this Worker holds D1 read-only and never opens one — so an audit row here
 * would have to be a separate, non-atomic INSERT, which is precisely the
 * anti-pattern §26.1 exists to prevent. The operator identity is already
 * captured: `requireAccess()` sets `c.get('operator')` and the response echoes it.
 *
 * ── THE CONNECTION BUDGET IS THE REAL CONSTRAINT (AECI-666) ─────────────────
 * A Worker invocation may hold only {@link WORKER_CONNECTION_LIMIT} connections
 * waiting for response headers, and R2 calls count against that budget exactly
 * like `fetch`. A `Promise.all` over a few hundred `put()`s is the AECI-666
 * defect class, and its failure mode is silence: past the limit the runtime
 * cancels stalled work and the cancelled promise never settles, so the caller's
 * own `catch` never fires and the invocation is eventually killed as hung. Every
 * R2 write here goes through `mapWithConcurrency`, which never rejects and
 * returns settled results in input order, so a per-object failure is REPORTED
 * rather than thrown.
 */
import { mapWithConcurrency, WORKER_CONNECTION_LIMIT } from '@aeci/shared/concurrency';
import { Hono } from 'hono';

import type { AccessVariables } from '../access';
import type { Env } from '../env';
import {
  buildCorpus,
  CORPUS_PREFIX,
  documentBytes,
  MAX_DOCUMENT_BYTES,
  type CorpusDocument,
} from '../lib/corpus';

/** Content type every corpus object carries. AI Search rejects an object whose
 *  `Content-Type` is missing, unsupported or `application/octet-stream`. */
const MARKDOWN_CONTENT_TYPE = 'text/markdown';

/** Cap on the key lists echoed in the response, so a terminal stays readable. */
const REPORTED_KEY_CAP = 50;

/** One product the run did not write, and why. */
export type ReindexSkip = { slug: string; reason: string };

/** The operator-facing summary. Every number answers "did this do what I asked". */
export type ReindexSummary = {
  ok: boolean;
  /** Published products read from D1. */
  products_read: number;
  /** Documents successfully written to R2. */
  documents_written: number;
  /** Documents the builder declined to write, with the reason for each. */
  skipped: ReindexSkip[];
  /** Documents whose R2 `put()` failed, with the error for each. */
  failed: ReindexSkip[];
  /** Objects under the corpus prefix that no longer belong to a published product. */
  stale_deleted: number;
  /** The deleted keys, capped at {@link REPORTED_KEY_CAP}. */
  stale_keys: string[];
  duration_ms: number;
};

/** The narrow slice of `Env` the engine needs, so a spec can stub it. */
export type ReindexDeps = Pick<Env, 'DB' | 'CORPUS'>;

/**
 * Rebuild the corpus. Exported separately from the route so it is testable
 * without a Hono request.
 */
export async function runReindex(env: ReindexDeps): Promise<ReindexSummary> {
  const started = Date.now();

  const documents = await buildCorpus(env.DB);

  const skipped: ReindexSkip[] = [];
  const writable: CorpusDocument[] = [];
  for (const doc of documents) {
    const bytes = documentBytes(doc.markdown);
    if (bytes > MAX_DOCUMENT_BYTES) {
      // AI Search refuses a source file above 4 MB, so writing it would succeed
      // at R2 and then fail invisibly at index time. Report it instead.
      skipped.push({
        slug: doc.slug,
        reason: `document is ${bytes} bytes, over the ${MAX_DOCUMENT_BYTES}-byte AI Search file limit`,
      });
      continue;
    }
    writable.push(doc);
  }

  const settled = await mapWithConcurrency(writable, WORKER_CONNECTION_LIMIT, (doc) =>
    env.CORPUS.put(doc.key, doc.markdown, {
      httpMetadata: { contentType: MARKDOWN_CONTENT_TYPE },
      customMetadata: { ...doc.metadata },
    }),
  );

  const failed: ReindexSkip[] = [];
  let documents_written = 0;
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') documents_written += 1;
    else failed.push({ slug: writable[i]!.slug, reason: errorMessage(result.reason) });
  });

  const stale = await deleteStaleObjects(
    env.CORPUS,
    new Set(writable.map((d) => d.key)),
    failed.length === 0 && skipped.length === 0,
  );

  return {
    ok: failed.length === 0,
    products_read: documents.length,
    documents_written,
    skipped,
    failed,
    stale_deleted: stale.length,
    stale_keys: stale.slice(0, REPORTED_KEY_CAP),
    duration_ms: Date.now() - started,
  };
}

/**
 * Delete corpus objects that no longer correspond to a published product.
 *
 * ── WHY DELETION IS IMPLEMENTED AND NOT DEFERRED ────────────────────────────
 * A retracted or un-promoted product whose object survives is worse than a
 * missing document: AI Search keeps serving it as a retrieved passage, so the
 * agent answers confidently from a record the public site has removed. That is
 * the AECI-779 shape — a stale copy of a rule nobody is enforcing any more — and
 * a reindex that only ever adds cannot converge.
 *
 * ── AND WHY IT IS FENCED ────────────────────────────────────────────────────
 * It is still a destructive operation driven by a query result, so three fences:
 *   1. It only ever considers keys under {@link CORPUS_PREFIX}. Nothing else in
 *      the bucket is reachable from here.
 *   2. It runs ONLY on a clean run (`allWritesSucceeded`). If any document
 *      failed to write or was skipped, the live key set is incomplete, and
 *      deleting "everything not in the live set" would delete good documents
 *      for products this run simply could not rebuild.
 *   3. Every deleted key is counted and returned, so the operator sees it.
 *
 * `delete()` takes an array, which is one connection for up to 1000 keys —
 * batching beats bounding (AECI-666), so there is no fan-out here to bound.
 */
async function deleteStaleObjects(
  bucket: R2Bucket,
  liveKeys: Set<string>,
  allWritesSucceeded: boolean,
): Promise<string[]> {
  if (!allWritesSucceeded) return [];

  const stale: string[] = [];
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({ prefix: CORPUS_PREFIX, cursor });
    for (const object of listing.objects) {
      if (!liveKeys.has(object.key)) stale.push(object.key);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  if (stale.length > 0) await bucket.delete(stale);
  return stale;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The sub-app, mounted at `/admin` by `src/app.ts`.
 *
 * `POST`, not `GET`: it mutates the bucket, and a GET that mutates is the rule
 * this repo broke once already (AECI-537's unsubscribe page).
 */
export const reindexRoutes = new Hono<{ Bindings: Env; Variables: AccessVariables }>();

reindexRoutes.post('/reindex', async (c) => {
  const summary = await runReindex(c.env);
  return c.json({ ...summary, operator: c.get('operator') }, summary.ok ? 200 : 207);
});

import { z } from 'zod';

import { RecrawlSubmissionOutcomeSchema } from './vendor-recrawl-submissions';

/**
 * IndexNow runner contracts (AECI-1476 / `STAGE_1_SPEC.md` §20.2,
 * `API_CONTRACTS.md` §6.12a). Machine to machine, behind
 * `Authorization: Bearer <INDEXNOW_RUNNER_TOKEN>`:
 *
 *   POST /api/internal/indexnow/batch                   — the day's drain set.
 *   POST /api/internal/indexnow/batch/:batchId/result   — what IndexNow said.
 *
 * The caller is `apps/api/scripts/indexnow-runner.ts` on a GitHub-hosted runner.
 * IndexNow refuses the shared Cloudflare Worker egress IPs, so the one outbound
 * request moved off the Worker. The Worker keeps every decision and every ledger
 * write: it picks the URLs, mints the batch id, and on the result writes the
 * `recrawl_submissions` rows, the delete and the audit row.
 *
 * Framework-agnostic package (no `$localize`).
 */

/** IndexNow's own cap, and so the most ids one batch can carry. Mirrors
 *  `INDEXNOW_MAX_URLS` in `apps/api/src/lib/indexnow.ts`, which this package
 *  cannot import. */
export const INDEXNOW_RUNNER_MAX_IDS = 10_000;

/** The longest `message` the result route stores in a log line. The runner trims
 *  to this before posting. */
export const INDEXNOW_RUNNER_MESSAGE_MAX = 500;

/** `200` from the batch route on a tier with no `INDEXNOW_KEY` / `PUBLIC_SITE_URL`
 *  (staging, demo, local). The runner exits 0. */
export const IndexNowBatchSkippedSchema = z.object({ skipped: z.literal('no_creds') });

/** `200` when nothing is sendable. Retired-slug rows, if any, were consumed by the
 *  route under `batchId` and are counted in `retired`. The runner exits 0. */
export const IndexNowBatchEmptySchema = z.object({
  empty: z.literal(true),
  retired: z.number().int().nonnegative(),
  batchId: z.string().uuid().optional(),
});

/** `200` with work: send `urls` in one IndexNow request, then post the result
 *  under `batchId` with the same `ids`. `ids[i]` is the queue row of `urls[i]`.
 *  `key` is public by design: the site serves it at `keyLocation`. */
export const IndexNowBatchReadySchema = z.object({
  batchId: z.string().uuid(),
  host: z.string().min(1),
  key: z.string().min(1),
  keyLocation: z.string().url(),
  ids: z.array(z.number().int().positive()).min(1).max(INDEXNOW_RUNNER_MAX_IDS),
  urls: z.array(z.string().url()).min(1).max(INDEXNOW_RUNNER_MAX_IDS),
  retired: z.number().int().nonnegative(),
});

export const IndexNowBatchResponseSchema = z.union([
  IndexNowBatchSkippedSchema,
  IndexNowBatchEmptySchema,
  IndexNowBatchReadySchema,
]);
export type IndexNowBatchResponse = z.infer<typeof IndexNowBatchResponseSchema>;
export type IndexNowBatchReady = z.infer<typeof IndexNowBatchReadySchema>;

/** `:batchId` on the result route. A malformed id is a 400, never a lookup. */
export const IndexNowBatchIdParamSchema = z.object({ batchId: z.string().uuid() });

/**
 * The result body. `status` is IndexNow's HTTP status, `0` when no response
 * arrived. `attempts` is `callIndexNow`'s count; `0` means nothing went on the
 * wire, and the route then logs nothing. The cap on `attempts` is loose on
 * purpose: the transport's retry ceiling lives in the API Worker.
 */
export const IndexNowResultRequestSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(INDEXNOW_RUNNER_MAX_IDS),
  status: z.number().int().min(0).max(599),
  attempts: z.number().int().min(0).max(10),
  message: z.string().max(INDEXNOW_RUNNER_MESSAGE_MAX),
  submittedAt: z.string().datetime(),
});
export type IndexNowResultRequest = z.infer<typeof IndexNowResultRequestSchema>;

/** `200` on a replay: this batch already has log rows, so nothing was written. */
export const IndexNowResultReplayedSchema = z.object({
  replayed: z.literal(true),
  batchId: z.string().uuid(),
});

/** `200` on a first post. `logged` counts the ids still queued (and so written to
 *  `recrawl_submissions`), `deleted` the rows removed (equal to `logged` on a 2xx,
 *  `0` otherwise), `ignored` the ids no longer queued. */
export const IndexNowResultRecordedSchema = z.object({
  replayed: z.literal(false),
  batchId: z.string().uuid(),
  outcome: RecrawlSubmissionOutcomeSchema.exclude(['requested']),
  logged: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  ignored: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
});

export const IndexNowResultResponseSchema = z.union([
  IndexNowResultReplayedSchema,
  IndexNowResultRecordedSchema,
]);
export type IndexNowResultResponse = z.infer<typeof IndexNowResultResponseSchema>;

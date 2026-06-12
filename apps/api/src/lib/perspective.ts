/**
 * Perspective API toxicity scoring (AECI-198 / Phase 5.7).
 *
 * Scores a submitted review body via Google's Perspective API so the moderation
 * queue can float the worst content to the top (`STAGE_1_PHASE_5_SPEC.md` §5.3,
 * `STAGE_1_SPEC.md` §22.2). This is a **triage signal only** — it never blocks or
 * auto-rejects a submission. The contract `scoreToxicity()` upholds:
 *
 *   - **Never throws.** Every failure mode (absent key, timeout, non-2xx,
 *     network error, malformed payload) resolves to `null`, so the caller can
 *     persist the review regardless. The `reviews.toxicity_score` column is
 *     nullable precisely for this.
 *   - **Absent key → `null`, silently.** No `PERSPECTIVE_API_KEY` is the expected
 *     state in local `dev:bound` and PR previews (the secret is staging/prod
 *     only), so we don't log a warning for it — only genuine outages warn.
 *   - **Sane timeout.** `AbortSignal.timeout(2000)` caps the worst case so a slow
 *     Perspective never materially blocks the 5.6 response.
 *
 * The score is stored as an integer 0–100 (`Math.round(value * 100)`) to fit the
 * `smallint` column (`DATABASE_SCHEMA.md` §7.2); Perspective itself returns a
 * 0.0–1.0 float. Scoring runs server-side only — the score is admin-only and
 * never appears in the submit response or any public payload.
 */

import { logToDatadog, submitCount, submitDistribution } from '../datadog';
import type { Env } from '../env';

/**
 * Minimal context shape `scoreToxicity` needs: env (for the key) plus the
 * Datadog logging triple (`executionCtx`, `env`, `req.raw`). Typed structurally
 * rather than as `Context<{ Bindings: Env }>` so the handler's richer
 * `AuthContext` (which carries `Variables`) is assignable — Hono's `Context` is
 * invariant on its generic, so the nominal form would not accept it.
 */
type ScoreContext = {
  env: Env;
  executionCtx: ExecutionContext;
  req: { raw: Request };
};

const PERSPECTIVE_URL = 'https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze';

/** Cap on how long we wait for Perspective before giving up and storing `null`. */
const TIMEOUT_MS = 2000;

/** Shape of the slice of the Perspective response we read. Everything is
 *  optional because a malformed payload must fail open to `null`, not throw. */
type PerspectiveResponse = {
  attributeScores?: {
    TOXICITY?: { summaryScore?: { value?: number } };
  };
};

/**
 * Score `body` for toxicity, returning an integer 0–100 or `null`. Never throws.
 *
 * `null` means "no score available" — either because no key is configured (a
 * no-op, expected in non-prod) or because the call failed (an outage, logged as
 * a `warn`). The caller persists the review with whatever this returns.
 */
export async function scoreToxicity(c: ScoreContext, body: string): Promise<number | null> {
  const apiKey = c.env.PERSPECTIVE_API_KEY;
  // Absent key is the expected dev/preview state — silent no-op, no warning and
  // no metric (an intentional skip, like Algolia's `skipped_no_creds` — it must
  // not pollute the `aeci.perspective.api` error-rate denominator).
  if (!apiKey) return null;

  const started = Date.now();
  try {
    const res = await fetch(`${PERSPECTIVE_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comment: { text: body },
        // en-US is the only launch locale; Perspective needs the language hint.
        languages: ['en'],
        requestedAttributes: { TOXICITY: {} },
        // Review bodies are private at submission (status='pending', admin-only,
        // possibly rejected and never published). `doNotStore` keeps Google from
        // retaining them for research/training so the content stays inside our
        // GDPR erasure boundary (AUTH_AND_RLS.md §8). Perspective's own guidance
        // is to set this for non-public data.
        doNotStore: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      warn(c, `Perspective API returned ${res.status}`);
      emitPerspective(c, 'failed', Date.now() - started, 'http_error');
      return null;
    }

    const data = (await res.json()) as PerspectiveResponse;
    const value = data.attributeScores?.TOXICITY?.summaryScore?.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      warn(c, 'Perspective API returned no TOXICITY summaryScore');
      emitPerspective(c, 'failed', Date.now() - started, 'malformed');
      return null;
    }

    emitPerspective(c, 'ok', Date.now() - started);
    // 0.0–1.0 float → 0–100 smallint, clamped defensively.
    return Math.min(100, Math.max(0, Math.round(value * 100)));
  } catch (err) {
    // Timeout (AbortError), network failure, or malformed JSON — all non-fatal.
    warn(c, `Perspective API call failed: ${err instanceof Error ? err.message : String(err)}`);
    emitPerspective(c, 'failed', Date.now() - started, isTimeoutError(err) ? 'timeout' : 'network');
    return null;
  }
}

/** True for an `AbortSignal.timeout` abort — a `DOMException` named `AbortError`
 *  (or `TimeoutError`, per spec, across runtimes). Duck-typed on `.name` because
 *  `DOMException` is not always an `Error` subclass. */
function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Emit the Perspective observability pair (AECI-206 / Phase 5.15): the
 * `aeci.perspective.api` outcome count (the error-rate / outage signal) and the
 * `aeci.perspective.api.duration_ms` latency distribution. Wrapped so a missing
 * `DD_API_KEY` / ExecutionContext can never turn a graceful `null` into a throw
 * (same ethos as `warn`). `reason` tags the failure cause; success omits it.
 */
function emitPerspective(
  c: ScoreContext,
  outcome: 'ok' | 'failed',
  durationMs: number,
  reason?: 'http_error' | 'malformed' | 'timeout' | 'network',
): void {
  try {
    const tags = [`outcome:${outcome}`];
    if (reason) tags.push(`reason:${reason}`);
    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.perspective.api', 1, tags);
    submitDistribution(
      c.executionCtx,
      c.env,
      c.req.raw,
      'aeci.perspective.api.duration_ms',
      durationMs,
      [`outcome:${outcome}`],
    );
  } catch {
    // Telemetry must never break scoring; swallow like `warn`.
  }
}

/** Best-effort `warn` to Datadog; wrapped so a missing ExecutionContext (test
 *  harness) or absent `DD_API_KEY` can never turn a graceful `null` into a throw
 *  (mirrors `reportMissingVendors` in `handler-utils.ts`). */
function warn(c: ScoreContext, message: string): void {
  try {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message,
      source: 'perspective',
    });
  } catch {
    console.warn(`scoreToxicity: ${message}`);
  }
}

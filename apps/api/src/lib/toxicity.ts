/**
 * Review toxicity scoring via Anthropic Claude (AECI-258).
 *
 * Supersedes the Google Perspective API path (AECI-198 / Phase 5.7): Google is
 * sunsetting Perspective — the service ends 2026-12-31 and new keys have been
 * unobtainable since 2026-02 — so we score with Claude Haiku instead and stay
 * Anthropic-native rather than add another moderation vendor.
 *
 * Scores a submitted review body so the moderation queue can float the worst
 * content to the top (`STAGE_1_PHASE_5_SPEC.md` §5.3, `STAGE_1_SPEC.md` §22.2).
 * This is a **triage signal only** — it never blocks or auto-rejects a
 * submission. The contract `scoreToxicity()` upholds is unchanged across the
 * provider swap:
 *
 *   - **Never throws.** Every failure mode (absent key, timeout, non-2xx,
 *     network error, malformed/unparseable payload) resolves to `null`, so the
 *     caller can persist the review regardless. The `reviews.toxicity_score`
 *     column is nullable precisely for this.
 *   - **Absent key → `null`, silently.** No `ANTHROPIC_API_KEY` is the expected
 *     state in local `dev:bound` and PR previews (the secret is staging/prod
 *     only), so we don't log a warning for it — only genuine outages warn.
 *   - **Sane timeout.** `AbortSignal.timeout(TIMEOUT_MS)` caps the worst case so
 *     a slow model never materially blocks the 5.6 submit response.
 *
 * The score is stored as an integer 0–100 to fit the `smallint` column
 * (`DATABASE_SCHEMA.md` §7.2); the model is prompted to return that scale
 * directly. Scoring runs server-side only — the score is admin-only and never
 * appears in the submit response or any public payload.
 *
 * GDPR: the review body is sent to Anthropic only for scoring and is never
 * logged. Anthropic does not train on API traffic. **The Messages API has no
 * per-request no-store control** (Perspective's `doNotStore` had no equivalent),
 * so the Anthropic org behind `ANTHROPIC_API_KEY` **must** have zero data
 * retention (ZDR) enabled before a real key is provisioned — otherwise a scored
 * body is retained for the provider's default window (~30 days), outside the
 * erasure boundary (`AUTH_AND_RLS.md` §8). Confirm ZDR is in place as a launch
 * gate; until it is, the absent-key path (a silent no-op that sends nothing)
 * keeps review bodies inside the boundary.
 */

import { logToPosthog, submitCount, submitDistribution } from '../posthog';
import type { Env } from '../env';

/**
 * Minimal context shape `scoreToxicity` needs: env (for the key) plus the
 * telemetry logging triple (`executionCtx`, `env`, `req.raw`). Typed structurally
 * rather than as `Context<{ Bindings: Env }>` so the handler's richer
 * `AuthContext` (which carries `Variables`) is assignable — Hono's `Context` is
 * invariant on its generic, so the nominal form would not accept it.
 */
type ScoreContext = {
  env: Env;
  // Structural `waitUntil` slice — see the note on `EmailContext` (lib/email.ts).
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
  req: { raw: Request };
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/** Claude Haiku 4.5 — cheap and fast, ample for a single-integer classification. */
const TOXICITY_MODEL = 'claude-haiku-4-5';

/** Cap on how long we wait before giving up and storing `null`. Higher than the
 *  old Perspective 2s cap because an LLM round-trip is slower; still fail-open. */
const TIMEOUT_MS = 4000;

/** Cap on output tokens — a bare integer needs almost nothing, and a tight cap
 *  keeps a refusal or ramble from running long. */
const MAX_TOKENS = 16;

const SYSTEM_PROMPT =
  'You are a content-moderation classifier for a B2B directory of ' +
  'architecture, engineering, and construction software reviews. Rate the ' +
  'TOXICITY of the review text on an integer scale from 0 to 100, where 0 is ' +
  'completely civil and professional and 100 is extremely toxic (harassment, ' +
  'hate, threats, slurs, or sexual content). A negative, critical, or harsh ' +
  'opinion about a product is NOT toxic on its own. Respond with ONLY the ' +
  'integer — no words, no punctuation, no explanation.';

/** Shape of the slice of the Messages API response we read. Everything is
 *  optional because a malformed payload must fail open to `null`, not throw. */
type AnthropicResponse = {
  content?: Array<{ type?: string; text?: string }>;
};

/**
 * Score `body` for toxicity, returning an integer 0–100 or `null`. Never throws.
 *
 * `null` means "no score available" — either because no key is configured (a
 * no-op, expected in non-prod) or because the call failed (an outage, logged as
 * a `warn`). The caller persists the review with whatever this returns.
 */
export async function scoreToxicity(c: ScoreContext, body: string): Promise<number | null> {
  const apiKey = c.env.ANTHROPIC_API_KEY;
  // Absent key is the expected dev/preview state — silent no-op, no warning and
  // no metric (an intentional skip, like Algolia's `skipped_no_creds` — it must
  // not pollute the `aeci.toxicity.api` error-rate denominator).
  if (!apiKey) return null;

  const started = Date.now();
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: TOXICITY_MODEL,
        max_tokens: MAX_TOKENS,
        // No `thinking` / `output_config.effort`: a one-integer answer needs
        // neither, and `effort` 400s on Haiku.
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: body }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      warn(c, `Anthropic toxicity API returned ${res.status}`);
      emitToxicity(c, 'failed', Date.now() - started, 'http_error');
      return null;
    }

    const data = (await res.json()) as AnthropicResponse;
    const text = data.content?.find((block) => block.type === 'text')?.text;
    const score = parseScore(text);
    if (score === null) {
      warn(c, 'Anthropic toxicity API returned no parseable score');
      emitToxicity(c, 'failed', Date.now() - started, 'malformed');
      return null;
    }

    emitToxicity(c, 'ok', Date.now() - started);
    return score;
  } catch (err) {
    // Timeout (AbortError), network failure, or malformed JSON — all non-fatal.
    warn(
      c,
      `Anthropic toxicity API call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    emitToxicity(c, 'failed', Date.now() - started, isTimeoutError(err) ? 'timeout' : 'network');
    return null;
  }
}

/** Parse the model's reply into a 0–100 integer, or `null` if it isn't one.
 *  Tolerates surrounding whitespace and pulls the first integer run; clamps
 *  defensively to the `smallint` 0–100 range. */
function parseScore(text: string | undefined): number | null {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(/-?\d+/);
  if (!match) return null;
  const n = Number.parseInt(match[0], 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

/** True for an `AbortSignal.timeout` abort — a `DOMException` named `AbortError`
 *  (or `TimeoutError`, per spec, across runtimes). Duck-typed on `.name` because
 *  `DOMException` is not always an `Error` subclass. */
function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Emit the toxicity-scoring observability pair (AECI-206 / Phase 5.15, repointed
 * to Anthropic by AECI-258): the `aeci.toxicity.api` outcome count (the
 * error-rate / outage signal) and the `aeci.toxicity.api.duration_ms` latency
 * distribution. Wrapped so a missing `DD_API_KEY` / ExecutionContext can never
 * turn a graceful `null` into a throw (same ethos as `warn`). `reason` tags the
 * failure cause; success omits it.
 */
function emitToxicity(
  c: ScoreContext,
  outcome: 'ok' | 'failed',
  durationMs: number,
  reason?: 'http_error' | 'malformed' | 'timeout' | 'network',
): void {
  try {
    const tags = [`outcome:${outcome}`];
    if (reason) tags.push(`reason:${reason}`);
    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.toxicity.api', 1, tags);
    submitDistribution(
      c.executionCtx,
      c.env,
      c.req.raw,
      'aeci.toxicity.api.duration_ms',
      durationMs,
      [`outcome:${outcome}`],
    );
  } catch {
    // Telemetry must never break scoring; swallow like `warn`.
  }
}

/** Best-effort `warn` to the observability plane; wrapped so a missing ExecutionContext (test
 *  harness) or absent `DD_API_KEY` can never turn a graceful `null` into a throw
 *  (mirrors `reportMissingVendors` in `handler-utils.ts`). */
function warn(c: ScoreContext, message: string): void {
  try {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message,
      source: 'toxicity',
    });
  } catch {
    console.warn(`scoreToxicity: ${message}`);
  }
}

import type { RawPageViewEnvelope } from '@aeci/shared';

import type { Env } from '../env';
import { logToPosthog, submitCount } from '../posthog';

/** Why `ip_hash` is or is not set, as the `aeci.pageviews.raw` tag reports it. */
export type IpHashState = 'present' | 'no_secret' | 'no_ip';

/**
 * Send one raw page-view envelope to the `PAGE_VIEW_RAW` Pipelines stream
 * (AECI-1384, ADR 0041). Never throws: the raw store is a backup, so its failure
 * must not change the D1 outcome or surface to the caller.
 *
 * Emits `aeci.pageviews.raw` with `outcome:ok|failed|skipped` and `ip_hash:<state>`.
 * `skipped` means the binding is absent (local dev, demo, tests). A privacy-signal
 * capture never reaches here: the route emits `outcome:privacy_signal` itself and
 * builds no envelope (AECI-1386).
 *
 * `send()` is a binding call, not an outbound `fetch`, so the Worker connection
 * limit does not apply. It is awaited because the caller runs inside `waitUntil`.
 */
export async function writeRawEnvelope(
  ctx: { waitUntil(promise: Promise<unknown>): void },
  env: Env,
  req: Request,
  envelope: RawPageViewEnvelope,
  ipHashState: IpHashState,
): Promise<void> {
  const ipTag = `ip_hash:${ipHashState}`;
  const stream = env.PAGE_VIEW_RAW;
  if (!stream) {
    submitCount(ctx, env, req, 'aeci.pageviews.raw', 1, ['outcome:skipped', ipTag]);
    return;
  }
  try {
    // The schema-less stream still has one required field, `value` (type json).
    // A record without it fails validation and is dropped, so the envelope
    // rides inside it and lands in the Parquet `value` column.
    await stream.send([{ value: envelope }]);
    submitCount(ctx, env, req, 'aeci.pageviews.raw', 1, ['outcome:ok', ipTag]);
  } catch (error) {
    submitCount(ctx, env, req, 'aeci.pageviews.raw', 1, ['outcome:failed', ipTag]);
    logToPosthog(ctx, env, req, {
      level: 'warn',
      message: 'aeci.api.page_view.raw_failed',
      source: 'page-views',
      reason: error instanceof Error ? error.message : String(error),
      outcome: envelope.outcome,
    });
  }
}

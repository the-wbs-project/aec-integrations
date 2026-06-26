/**
 * WAF firewall-event metrics (AECI-262 / §15.1 + §26).
 *
 * The §15.1 WAF rules (rate-limit Rules A/B + the scraper-UA Managed Challenge,
 * `docs/waf-rate-limits.md`) mitigate abuse at the Cloudflare edge — before any
 * request reaches a Worker — so those events have no request to ride on. A daily
 * hourly cron (`scheduled.ts`) polls the zone's `firewallEventsAdaptiveGroups`
 * (`@aeci/shared/cloudflare-analytics`) for the previous clock hour and this pure
 * emitter maps each returned group to one count point (cf. `moderation-metrics.ts`
 * / `algolia-sync-metrics.ts`, which keep the cron handler free of metric-vocabulary
 * detail):
 *
 *   - `aeci.waf.ratelimit.blocked` (count) — firewall mitigations in the window,
 *     tagged `rule` / `action` / `host` / `source`. **The value is the event count
 *     (not 1), so query it with `sum:`** (OBSERVABILITY gotcha 3).
 *
 * Only *mitigation* actions are counted (block / challenge); `allow` / `log` /
 * `skip` rows are dropped so the "blocked" count stays a true mitigation signal.
 *
 * The transport is injected as a `sink` so this stays free of `ExecutionContext`
 * / `fetch` / Datadog-key plumbing and is trivially unit-tested.
 */

import type { WafEventGroup } from '@aeci/shared/cloudflare-analytics';

/** Datadog transport, narrowed to the count submitter this module needs. The
 *  caller binds `(ctx, env, request)` and forwards to the shared client's
 *  `submitCount`. */
export type WafMetricSink = {
  count(metric: string, value: number, tags: string[]): void;
};

/** The count a sustained-block-spike monitor alerts on (docs/OBSERVABILITY.md). */
export const WAF_BLOCKED_METRIC = 'aeci.waf.ratelimit.blocked';

/**
 * Firewall actions that represent an actual mitigation worth counting. Cloudflare
 * reports many `action` values; `allow` / `log` / `skip` are non-mitigations and
 * are dropped. Compared lowercased (Datadog also lowercases tag values).
 */
const MITIGATION_ACTIONS = new Set([
  'block',
  'managed_challenge',
  'challenge',
  'jschallenge',
  'js_challenge',
  'connection_close',
]);

/** Emit one count per mitigation group; non-mitigation actions are skipped. */
export function emitWafEventMetrics(sink: WafMetricSink, groups: WafEventGroup[]): void {
  for (const g of groups) {
    if (!MITIGATION_ACTIONS.has(g.action.toLowerCase())) continue;
    sink.count(WAF_BLOCKED_METRIC, g.count, [
      `rule:${g.ruleId}`,
      `action:${g.action}`,
      `host:${g.host}`,
      `source:${g.source}`,
    ]);
  }
}

/**
 * The previous *clock hour* as a half-open `[start, end)` ISO window. Flooring
 * `now` to the hour (rather than a sliding `now-1h`) makes the window
 * deterministic regardless of the cron's exact fire time, so consecutive hourly
 * runs neither overlap nor leave gaps, and the just-closed hour has a few minutes
 * to settle in Cloudflare's analytics. Pure + exported so the clock math is
 * unit-tested without a real clock.
 */
export function previousHourWindow(now: Date): { startIso: string; endIso: string } {
  const end = new Date(now);
  end.setUTCMinutes(0, 0, 0); // floor to the current clock hour → window end
  const start = new Date(end.getTime() - 3_600_000); // one hour earlier
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

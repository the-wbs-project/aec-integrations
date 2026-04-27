// ---------------------------------------------------------------------------
// Weekly cost report orchestrator. Pulls AI Gateway + SearchAPI usage for the
// last N days (default 7) and sends the report email.
//
// Same entry point is invoked from cron, queue consumer, and ad-hoc HTTP.
// ---------------------------------------------------------------------------
import type { Env } from '../../env';
import { summarizeGatewayUsage } from './aiGatewayLogs';
import { summarizeSearchapiUsage } from './searchapiUsage';
import { sendReport } from './email';

export interface RunOptions {
  /** How far back to look. Default 7 days. */
  lookbackDays?: number;
  /** End-of-window override; defaults to now. */
  endIso?: string;
}

export interface RunResult {
  windowStartIso: string;
  windowEndIso: string;
  gatewayCalls: number;
  gatewayCostUsd: number;
  searchapiCalls: number;
  searchapiCostUsd: number;
}

export async function runWeeklyCostReport(env: Env, opts: RunOptions = {}): Promise<RunResult> {
  const lookbackDays = opts.lookbackDays ?? 7;
  const end = opts.endIso ? new Date(opts.endIso) : new Date();
  const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const windowStartIso = start.toISOString();
  const windowEndIso = end.toISOString();

  const [gateway, searchapi] = await Promise.all([
    summarizeGatewayUsage(env, { startIso: windowStartIso, endIso: windowEndIso }),
    summarizeSearchapiUsage(env, { startIso: windowStartIso, endIso: windowEndIso }),
  ]);

  await sendReport(env, { windowStartIso, windowEndIso, gateway, searchapi });

  console.log(
    `[weekly-cost-report] sent window=${windowStartIso}..${windowEndIso} gateway_calls=${gateway.totalCalls} gateway_cost=${gateway.totalCostUsd.toFixed(4)} searchapi_calls=${searchapi.totalCalls} searchapi_cost=${searchapi.totalCostUsd.toFixed(4)}`,
  );

  return {
    windowStartIso,
    windowEndIso,
    gatewayCalls: gateway.totalCalls,
    gatewayCostUsd: gateway.totalCostUsd,
    searchapiCalls: searchapi.totalCalls,
    searchapiCostUsd: searchapi.totalCostUsd,
  };
}

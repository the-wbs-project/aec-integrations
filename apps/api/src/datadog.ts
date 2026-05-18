/**
 * API Worker → Datadog Logs.
 *
 * Mirror of `apps/web/src/server-datadog.ts` but tagged for the API Worker
 * (`service: 'aeci-api'`, `ddsource: 'worker'`, `hostname: 'aeci-api'`,
 * `ddtags: env:…,worker:aeci-api,…`). Two helpers live in parallel
 * intentionally per AECI-31; once Phase 2 introduces structured audit-log
 * forwarding (§26.5) and we know the real shared surface, a common helper can
 * be hoisted into `@aeci/shared`. For now duplication keeps each Worker
 * standalone and avoids premature abstraction.
 *
 * Contract (same as the SSR helper):
 *   1. `ctx.waitUntil(...)` dispatches the POST so it never blocks the
 *      response back to the user (§"never blocks responses").
 *   2. Failure to forward MUST NOT throw — swallow + `console.warn`.
 *   3. No `DD_API_KEY` → no-op (dev convenience).
 */

import type { Env } from "./env";

export type DdLogLevel = "debug" | "info" | "warn" | "error";

export type DdLogEvent = {
  message: string;
  level?: DdLogLevel;
  [key: string]: unknown;
};

type WaitUntilContext = { waitUntil(promise: Promise<unknown>): void };

const DEFAULT_SITE = "us5.datadoghq.com";
const SERVICE = "aeci-api";
const WORKER = "aeci-api";
const APP = "aeci"; // Umbrella project tag — pairs both Workers under one app facet.
const LOCALE = "en-US"; // Phase 1; tracks LOCALES in the SSR runtime.
const DD_SOURCE = "worker";

/**
 * Derives the Datadog `hostname` from a `Request`. Workers have no machine
 * hostname, so we use the request `host` header (e.g. `localhost:8787` in dev,
 * `api.aeci.com` in production) — that's the dimension operators actually want
 * to pivot on. Falls back to the `WORKER` slug if the URL is unparseable, so
 * the field is never empty.
 */
export function hostnameFromRequest(request: Request): string {
  try {
    return new URL(request.url).host || WORKER;
  } catch {
    return WORKER;
  }
}

export function logToDatadog(
  ctx: WaitUntilContext,
  env: Env,
  request: Request,
  event: DdLogEvent,
): void {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;

  const ddEnv = env.ENV ?? "preview";
  const { message, level, ...rest } = event;
  const payload = {
    ...rest,
    message,
    status: level ?? "info",
    service: SERVICE,
    hostname: hostnameFromRequest(request),
    ddsource: DD_SOURCE,
    ddtags: `env:${ddEnv},app:${APP},worker:${WORKER},locale:${LOCALE}`,
  };

  const site = env.DD_SITE || DEFAULT_SITE;
  const url = `https://http-intake.logs.${site}/api/v2/logs`;

  ctx.waitUntil(
    (async () => {
      try {
        await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "dd-api-key": apiKey,
          },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        console.warn("logToDatadog: forward failed", error);
      }
    })(),
  );
}

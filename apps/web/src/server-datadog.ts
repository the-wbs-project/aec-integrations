/**
 * SSR Worker → Datadog Logs.
 *
 * Posts a structured log event to the Datadog HTTP intake. AECI-31 requires
 * every entry to carry the dimensions `service`, `host`, `source`, `env`,
 * `worker`, and `locale` so we can pivot in Datadog across the Worker pair
 * without manual tagging. `service`, `hostname`, and `ddsource` are reserved
 * top-level attributes; `env`/`worker`/`locale` are emitted as `ddtags` so
 * Datadog promotes `env` to its standard environment facet. Phase 1 is
 * English-only so `locale` is hard-coded; expand alongside `LOCALES` in
 * `server-runtime.ts` when adding locales.
 *
 * Two non-negotiable behaviours:
 *
 *   1. The fetch is dispatched via `ctx.waitUntil(...)` so it never blocks the
 *      response back to the user. This is the §"never blocks responses"
 *      contract from the issue.
 *   2. Failure to forward (network down, Datadog 5xx, missing key) MUST NOT
 *      throw — observability outages cannot take the site down. Errors are
 *      logged to `console.warn` and swallowed.
 *
 * `DD_API_KEY` is the only required secret. When it is absent (local dev
 * without the secret provisioned), `logToDatadog` is a no-op — same defensive
 * pattern as `injectDatadogBootstrap`.
 */

import type { WebEnv } from './env';

export type DdLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DdLogEvent = {
  message: string;
  level?: DdLogLevel;
  [key: string]: unknown;
};

type WaitUntilContext = { waitUntil(promise: Promise<unknown>): void };

const DEFAULT_SITE = 'us5.datadoghq.com';
const SERVICE = 'aeci-web';
const WORKER = 'aeci-web';
const APP = 'aeci'; // Umbrella project tag — pairs both Workers under one app facet.
const LOCALE = 'en-US'; // Phase 1; revisit when LOCALES grows in server-runtime.ts.
const DD_SOURCE = 'worker-angular';

/**
 * Derives the Datadog `hostname` from a `Request`. Workers have no machine
 * hostname, so we use the request `host` header (e.g. `localhost:8788` in
 * dev, `aeci.com` in production) — that's the dimension operators actually
 * want to pivot on. Falls back to the `WORKER` slug if the URL is unparseable.
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
  env: WebEnv,
  request: Request,
  event: DdLogEvent,
): void {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;

  const ddEnv = env.ENV ?? 'preview';
  const { message, level, ...rest } = event;
  const payload = {
    ...rest,
    message,
    status: level ?? 'info',
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
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'dd-api-key': apiKey,
          },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        // Swallow — observability MUST NOT break the request path.
        console.warn('logToDatadog: forward failed', error);
      }
    })(),
  );
}

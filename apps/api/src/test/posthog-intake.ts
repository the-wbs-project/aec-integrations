/**
 * Records every request the PostHog transport makes to the logs intake, so a spec can
 * count real `fetch` calls rather than calls to a mocked helper (AECI-1112).
 *
 * The connection-limit defect (AECI-666) is about how many requests leave the Worker,
 * so this is the level the "one batched forward per request" claim has to hold at.
 * `postToIntake` calls `fetch` synchronously inside its `waitUntil` task, so a request
 * is recorded as soon as the forward is issued. Restore with `vi.unstubAllGlobals()`.
 */

import { vi } from 'vitest';

export interface IntakeRequest {
  url: string;
  /** The `body.stringValue` of every log record in the request, in order. */
  messages: string[];
}

interface OtlpLogsBody {
  resourceLogs?: { scopeLogs?: { logRecords?: { body?: { stringValue?: string } }[] }[] }[];
}

/**
 * Stub the global `fetch`. Logs-intake requests are recorded and answered with
 * `respond()` (a 200 by default). Every other request gets a 200 and is not recorded.
 */
export function stubPosthogIntake(respond: () => Promise<Response> | Response = okResponse) {
  const requests: IntakeRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('/i/v1/logs')) return okResponse();
    const body = JSON.parse(String(init?.body ?? '{}')) as OtlpLogsBody;
    const messages = (body.resourceLogs ?? []).flatMap((r) =>
      (r.scopeLogs ?? []).flatMap((s) =>
        (s.logRecords ?? []).map((rec) => rec.body?.stringValue ?? ''),
      ),
    );
    requests.push({ url, messages });
    return respond();
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    requests,
    fetchMock,
    /** Requests that carried at least one §26.5 audit or workflow forward. */
    auditRequests: () =>
      requests.filter((r) =>
        r.messages.some((m) => m.startsWith('audit ') || m.startsWith('workflow ')),
      ),
  };
}

function okResponse(): Response {
  return new Response('{}', { status: 200 });
}

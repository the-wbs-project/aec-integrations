/**
 * indexnow-runner.ts — send the day's IndexNow request from a GitHub Actions runner
 * (AECI-1476 / `STAGE_1_SPEC.md` §20.2, ADR 0025's 2026-10-27 amendment).
 *
 * WHY THIS EXISTS. IndexNow refused the API Worker's daily request with a 429 on
 * most days, even at one request a day. A one-shot probe from a GitHub-hosted
 * runner (run 40286642092) got a 200 the same UTC day. Cloudflare Worker egress
 * IPs are shared with every other Worker, so the limit we hit was not ours. This
 * script moves the ONE outbound POST to a runner IP and nothing else.
 *
 * WHAT IT DOES, in order. It makes exactly one IndexNow request per run.
 *   1. Prints the runner's egress IP, so a refusal can be tied to an address.
 *   2. `POST {site}/api/internal/indexnow/batch`. The Worker reads the drain set
 *      (tier order, resend window, retired slugs consumed) and returns the URLs,
 *      their queue ids, a `batchId`, and the public host, key and key location.
 *   3. Sends the URLs to IndexNow in one request with `callIndexNow`
 *      (`src/lib/indexnow.ts`), the same transport and the same retry gate the
 *      Worker used: a bare 429 is never retried.
 *   4. `POST {site}/api/internal/indexnow/batch/{batchId}/result` with the status.
 *      The Worker writes the `recrawl_submissions` rows and, on a 2xx, deletes the
 *      rows and writes the audit row. This POST is retried on a network error or a
 *      5xx, because the route is idempotent on `batchId`.
 *
 * The Worker keeps every decision and every ledger write. This script holds no
 * IndexNow secret: the key is public by design (served at `/{key}.txt`) and comes
 * back from the batch route. Its only secret is `INDEXNOW_RUNNER_TOKEN`.
 *
 * USAGE:
 *   INDEXNOW_RUNNER_TOKEN=… pnpm --filter @aeci/api ops:indexnow-runner
 *   INDEXNOW_RUNNER_TOKEN=… pnpm --filter @aeci/api ops:indexnow-runner -- --site http://localhost:8790
 *
 * `--site` defaults to production, `https://www.aecintegrations.com`. `/api/*` on
 * that host is proxied raw by the SSR Worker to the API Worker.
 *
 * Exit codes, read by `.github/workflows/indexnow-send.yml`:
 *   0  sent and recorded (accepted OR refused), or nothing to send, or the tier
 *      has no IndexNow credentials. A refusal is recorded and alerted on by the
 *      72 h ratio alert, so one throttled day does not turn the run red.
 *   1  our API failed (batch or result), or IndexNow was unreachable or answered
 *      5xx (`failed`). The run goes red.
 *   2  usage or credentials.
 */

import { discardResponseBody } from '@aeci/shared/response-drain';
import {
  INDEXNOW_RUNNER_MESSAGE_MAX,
  IndexNowBatchResponseSchema,
  IndexNowResultResponseSchema,
  type IndexNowResultRequest,
} from '@aeci/shared';

import { callIndexNow } from '../src/lib/indexnow';

const DEFAULT_SITE = 'https://www.aecintegrations.com';
const API_TIMEOUT_MS = 30_000;
const RESULT_ATTEMPTS = 3;
const RESULT_BACKOFF_MS = [2_000, 8_000];

function readValueFlag(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Best-effort. A failure here never stops the send. */
async function egressIp(): Promise<string> {
  try {
    const res = await fetch('https://api.ipify.org', {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      discardResponseBody(res);
      return `unknown (ipify ${res.status})`;
    }
    return (await res.text()).trim();
  } catch {
    return 'unknown';
  }
}

/** POST JSON to our API. Returns the status and the parsed body, or the text when
 *  the body is not JSON. Every path reads the body, so no connection is held. */
async function postApi(
  url: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json?: unknown; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'aeci-indexnow-runner (+https://github.com/the-wbs-project/aec-integrations)',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) as unknown, text };
  } catch {
    return { status: res.status, text };
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const site = (readValueFlag(argv, '--site') ?? DEFAULT_SITE).replace(/\/+$/, '');
  const token = process.env['INDEXNOW_RUNNER_TOKEN'];
  if (!token) {
    console.error(
      '::error::INDEXNOW_RUNNER_TOKEN is empty. Set the GitHub secret ' +
        'INDEXNOW_RUNNER_TOKEN_PRODUCTION, and push it to the API Worker with promote-to-prod.',
    );
    return 2;
  }

  console.log(`Target:    ${site}`);
  console.log(`Egress IP: ${await egressIp()}`);

  // ── 1. Batch ──
  const batch = await postApi(`${site}/api/internal/indexnow/batch`, token);
  if (batch.status !== 200) {
    console.error(`::error::Batch route returned ${batch.status}: ${batch.text.slice(0, 500)}`);
    return 1;
  }
  const plan = IndexNowBatchResponseSchema.safeParse(batch.json);
  if (!plan.success) {
    console.error(`::error::Batch route returned an unexpected body: ${batch.text.slice(0, 500)}`);
    return 1;
  }
  if ('skipped' in plan.data) {
    console.log('Skipped: this tier has no IndexNow credentials (no_creds). Nothing sent.');
    return 0;
  }
  if ('empty' in plan.data) {
    console.log(
      `Nothing to send. Retired URLs consumed by the Worker: ${plan.data.retired}.` +
        (plan.data.batchId ? ` Batch ${plan.data.batchId}.` : ''),
    );
    return 0;
  }
  const ready = plan.data;
  console.log(`Batch:     ${ready.batchId}`);
  console.log(
    `URLs:      ${ready.urls.length} (retired, consumed by the Worker: ${ready.retired})`,
  );

  // ── 2. IndexNow, exactly one request (a bare 429 is not retried) ──
  const submittedAt = new Date().toISOString();
  const sent = await callIndexNow(fetch, {
    host: ready.host,
    key: ready.key,
    keyLocation: ready.keyLocation,
    urlList: ready.urls,
  });
  const message = sent.ok ? '' : sent.message.slice(0, INDEXNOW_RUNNER_MESSAGE_MAX);
  console.log(
    `IndexNow:  ${sent.ok ? 'OK' : 'NOT OK'} status ${sent.status}, attempts ${sent.attempts}` +
      (message ? `, message: ${message}` : ''),
  );

  // ── 3. Result, retried safely: the route is idempotent on batchId ──
  const report: IndexNowResultRequest = {
    ids: ready.ids,
    status: sent.status,
    attempts: sent.attempts,
    message,
    submittedAt,
  };
  const resultUrl = `${site}/api/internal/indexnow/batch/${ready.batchId}/result`;
  let recorded: { status: number; json?: unknown; text: string } | undefined;
  for (let attempt = 1; attempt <= RESULT_ATTEMPTS; attempt++) {
    try {
      recorded = await postApi(resultUrl, token, report);
      if (recorded.status < 500) break;
      console.error(`Result route returned ${recorded.status} (attempt ${attempt}).`);
    } catch (error) {
      recorded = undefined;
      console.error(
        `Result route unreachable (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (attempt < RESULT_ATTEMPTS) await sleep(RESULT_BACKOFF_MS[attempt - 1] ?? 0);
  }
  if (!recorded || recorded.status !== 200) {
    console.error(
      `::error::The result for batch ${ready.batchId} was not recorded ` +
        `(${recorded ? `${recorded.status}: ${recorded.text.slice(0, 500)}` : 'unreachable'}). ` +
        'The URLs stay queued and tomorrow resends them; this send has no log row.',
    );
    return 1;
  }
  const result = IndexNowResultResponseSchema.safeParse(recorded.json);
  console.log(`Recorded:  ${result.success ? JSON.stringify(result.data) : recorded.text}`);

  if (sent.ok) return 0;
  if (sent.status >= 400 && sent.status < 500) {
    console.log(
      `::warning::IndexNow refused the batch (${sent.status}). The rows stay queued for ` +
        "tomorrow. The 72 h refusal alert judges a run of these; see docs/RUNBOOKS.md 'IndexNow submissions refused'.",
    );
    return 0;
  }
  console.error(`::error::IndexNow did not answer usefully (status ${sent.status}): ${message}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause) console.error(`  cause: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  });

/**
 * PostHog HogQL read transport for the daily digest (AECI-660, completing AECI-239).
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * AECI-239 shipped the browser instrumentation and has been Done for months, but
 * **nothing ever read it back**. `analytics-digest.ts` queried D1 and only D1, so
 * the digest reported one number with no second opinion. Both
 * `bot-classification.ts` and `POST_LAUNCH_MONITORING.md` §3 describe "the
 * PostHog join" in the future tense; this is that join.
 *
 * The two sources fail in **opposite directions**, which is exactly what makes
 * the pair useful:
 *
 *  - `page_views` is written SERVER-side by the SSR Worker on every full-document
 *    load, including cache hits. A crawler that never runs JavaScript still
 *    counts. It is therefore an **upper bound** on humans.
 *  - PostHog fires CLIENT-side, only when JS executes AND the visitor consented
 *    (the banner plus DNT/GPC gate it). A real person who declines is invisible.
 *    It is therefore a **lower bound**.
 *
 * Reporting both is the whole point. On UTC day 2026-08-23 the digest said "48
 * human views"; PostHog for the same day and host recorded 5 pageviews from 1
 * person, and those 5 were the operator's own session, which the digest had
 * already excluded. The 48 produced zero client-side events. One number looked
 * authoritative; the pair would have been obviously wrong the same morning.
 *
 * **Neither of these is a bound on the other, and the email no longer says it is
 * (AECI-869).** This query filters event, date and host and nothing else, so it
 * counts operators and any bot that runs JavaScript, and `uniq(person_id)` is an
 * identity count rather than a person count. Measured twice against production,
 * its "1 person" WAS the operator (2026-08-23 and 2026-08-26).
 *
 * The Tier 2 half of the gap is closed by {@link fetchPosthogBrowserStarts}
 * below, which AECI-639 made possible and AECI-870 read back: `app_started`
 * fires for ALL visitors including DNT/GPC, so that figure is not
 * consent-limited. It is still not a bound on anything — see its own docblock.
 *
 * ─── Contract ───────────────────────────────────────────────────────────────
 *
 * Pure transport, in the mould of `cloudflare-analytics.ts` and `cache-purge.ts`:
 * it authenticates with what the caller hands it and **never throws**. A missing
 * credential, a network error, a non-2xx, or an unparseable body all come back as
 * a structured `{ ok: false, reason }` so the cron logs and no-ops. An
 * observability outage must never take down the digest — the email degrades to
 * the D1-only report it sends today.
 *
 * `fetchImpl` is injected so specs supply a mock without monkey-patching globals.
 *
 * ─── Credentials ────────────────────────────────────────────────────────────
 *
 * Needs a PostHog **personal API key** (`phx_…`) scoped to `query:read`, as
 * `POSTHOG_QUERY_API_KEY`, plus `POSTHOG_PROJECT_ID`. This is a DIFFERENT
 * credential from the client-side `POSTHOG_KEY` (`phc_…`), which is publishable
 * and inlined into public HTML — never reuse one for the other. A `phx_` key was
 * once mis-provisioned as `POSTHOG_KEY` and served in public HTML; confirm that
 * one is revoked rather than recycling it here.
 *
 * Server-side only. This key must never reach `apps/web`.
 *
 * ─── Two reads, one transport (AECI-870) ────────────────────────────────────
 *
 * There are now two exported reads and they answer different questions:
 *
 *  - {@link fetchPosthogTraffic} counts consented `$pageview`s (Tier 3).
 *  - {@link fetchPosthogBrowserStarts} counts `app_started` (Tier 2), which
 *    fires for **every** visitor with no consent gate. It is the only signal in
 *    the stack that a curl, a headless fetch or a proxy swarm that never runs
 *    JavaScript cannot produce.
 *
 * Each is exactly ONE HogQL request, so a digest run costs two PostHog
 * connections in total. Both go through {@link runHogqlQuery}, which owns the
 * AECI-666 discipline the pair must not diverge on: a bounded
 * `AbortSignal.timeout`, `discardResponseBody` on every path that does not read
 * the body, and no fan-out. A Worker invocation may hold only ~6 connections
 * waiting for headers, and a `fetch` whose body is never consumed keeps holding
 * one — past the limit the runtime cancels it and the promise never settles, so
 * the caller's own `catch` never fires.
 */

import { discardResponseBody } from '@aeci/shared/response-drain';

/** Cap on a single HogQL round trip. A hung analytics vendor must not be able to
 *  stall the 05:00 digest cron or an operator's `?recompute=1`; both callers
 *  already render an "unavailable" note, which is strictly better than a wait. */
const QUERY_TIMEOUT_MS = 10_000;

/** Credentials for the query API. Optional so callers pass env values straight
 *  through; absent → `posthog_credentials_missing`. */
export type PosthogCredentials = {
  /** Personal API key scoped to `query:read`. */
  apiKey: string | undefined;
  /** Numeric project id (e.g. `354071`). */
  projectId: string | undefined;
  /** API host. Defaults to US Cloud when unset. */
  host?: string | undefined;
};

/** The half-open window plus the host the query is scoped to. */
export type PosthogWindow = {
  /** Inclusive ISO start. */
  startIso: string;
  /** Exclusive ISO end. */
  endIso: string;
  /**
   * The `$host` this environment owns (e.g. `www.aecintegrations.com`).
   *
   * NOT optional, and the query is useless without it. PostHog is split on one
   * axis — the prod project (`aec-integrations`) and the non-prod project
   * (`aec-integrations-dev`, shared by staging, demo and PR previews) — so an
   * unscoped read still folds demo and preview traffic into the staging figure.
   * The host filter is what separates tiers inside a project.
   */
  host: string;
};

/** What the digest gets back. */
export type PosthogTraffic = {
  /** `$pageview` events in the window for this host. */
  pageviews: number;
  /** Distinct `person_id`s behind them. The more telling of the two. */
  people: number;
};

export type PosthogQueryOutcome =
  | { ok: true; traffic: PosthogTraffic }
  | { ok: false; reason: string };

const DEFAULT_HOST = 'https://us.posthog.com';

/**
 * Count consented `$pageview`s and distinct people for one host and window.
 *
 * `uniq(person_id)` rather than `distinct_id` deliberately: one person owns many
 * distinct ids, so counting distinct ids overstates people. The window is bound
 * on `timestamp` in the `WHERE` clause (not inside an aggregate) so ClickHouse
 * can actually use the table's date-first sort key.
 */
export async function fetchPosthogTraffic(
  creds: PosthogCredentials,
  window: PosthogWindow,
  fetchImpl: typeof fetch,
): Promise<PosthogQueryOutcome> {
  if (!creds.apiKey || !creds.projectId) {
    return { ok: false, reason: 'posthog_credentials_missing' };
  }
  if (!window.host) {
    return { ok: false, reason: 'posthog_host_missing' };
  }

  const query = [
    'SELECT count() AS pageviews, uniq(person_id) AS people',
    'FROM events',
    "WHERE event = '$pageview'",
    `  AND timestamp >= toDateTime('${sqlLiteral(window.startIso)}')`,
    `  AND timestamp < toDateTime('${sqlLiteral(window.endIso)}')`,
    `  AND properties.$host = '${sqlLiteral(window.host)}'`,
  ].join('\n');

  const outcome = await runHogqlQuery(creds, query, fetchImpl, 2);
  if (!outcome.ok) return outcome;

  const [pageviews, people] = outcome.row;
  return { ok: true, traffic: { pageviews, people } };
}

// ─── app_started, the Tier 2 browser-start beacon (AECI-870) ─────────────────

/**
 * Successful browser-bundle executions for one host and window.
 *
 * **Three counts, and the difference between them is the finding.** `startsAll`
 * is every `app_started` row; `starts` removes the operator and the clients
 * PostHog itself flagged as bots; `searchReferred` is the subset of `starts`
 * whose referrer PostHog classified as a search engine.
 */
export type PosthogBrowserStarts = {
  /** Every `app_started` row in the window, before either exclusion. */
  startsAll: number;
  /** `startsAll` less the operator's own starts and PostHog-detected bots. */
  starts: number;
  /** Of `starts`, those carrying a non-empty `$search_engine`. */
  searchReferred: number;
};

export type PosthogBrowserStartsOutcome =
  | { ok: true; starts: PosthogBrowserStarts }
  | { ok: false; reason: string };

/**
 * Count `app_started` for one host and window, excluding the operator and
 * PostHog-detected bots.
 *
 * ─── Starts, never people (ANALYTICS.md §5) ─────────────────────────────────
 *
 * Tier 2 runs with `persistence: 'memory'`, so every full page load mints a
 * fresh anonymous distinct id and PostHog resolves a fresh person behind it. On
 * the Sep 7–10 production sample, persons ≈ starts. `uniq(person_id)` over this
 * event is therefore not an audience figure and must never be reported as one —
 * which is why this function returns no people count at all rather than
 * returning one the caller is trusted not to print.
 *
 * ─── The two exclusions, and why neither is `$is_identified` ────────────────
 *
 * **Operator.** The analogue of the D1 `NOT_INTERNAL` retro-join: resolve the
 * persons behind the admins' Supabase user ids from their `$identify` events
 * over a trailing window, then exclude those persons. It has to be a retro-join
 * because on the operator's own `app_started` rows `$is_identified` is FALSE —
 * the Tier 2 beacon fires at bootstrap and the `$identify` merge happens later
 * in the same session. Keying the exclusion on `$is_identified`, or on country,
 * would exclude nothing and look like it worked. Measured: the operator was 41
 * of 109 starts over Sep 7–10, i.e. well over a third of the raw figure.
 *
 * `adminDistinctIds` empty → the subquery is **omitted entirely**. `IN ()` is a
 * syntax error in ClickHouse, and an empty-set `NOT IN` that silently matched
 * nothing would be worse: the caller would get an unfiltered number labelled
 * "operator excluded".
 *
 * **Bots.** `$virt_traffic_type = 'Regular'` is PostHog's own bot verdict, not
 * ours. About one start a day is tagged `AI Agent`. A real headless browser
 * that PostHog does not recognise still produces a start, so this narrows the
 * population without ever making it a human count — a successful start proves
 * *execution*, not humanity.
 *
 * ─── What it can never see ──────────────────────────────────────────────────
 *
 * The client posts straight to `us.i.posthog.com` with no reverse proxy, so any
 * browser running a tracker blocker emits nothing. This is a floor with a
 * blocker-shaped hole in it, and every surface that prints the number says so.
 */
export async function fetchPosthogBrowserStarts(
  creds: PosthogCredentials,
  window: PosthogWindow,
  adminDistinctIds: readonly string[],
  fetchImpl: typeof fetch,
): Promise<PosthogBrowserStartsOutcome> {
  if (!creds.apiKey || !creds.projectId) {
    return { ok: false, reason: 'posthog_credentials_missing' };
  }
  if (!window.host) {
    return { ok: false, reason: 'posthog_host_missing' };
  }

  // Same predicate in all three aggregates, built once: a `countIf` that drifted
  // from its siblings would make `searchReferred` describe a population `starts`
  // does not, and nothing about the numbers would look wrong.
  const clean = [
    "properties.$virt_traffic_type = 'Regular'",
    ...(adminDistinctIds.length > 0
      ? [`person_id NOT IN (${operatorPersons(window, adminDistinctIds)})`]
      : []),
  ].join(' AND ');

  const query = [
    'SELECT count() AS starts_all,',
    `       countIf(${clean}) AS starts,`,
    `       countIf(${clean} AND notEmpty(properties.$search_engine)) AS starts_search_referred`,
    'FROM events',
    "WHERE event = 'app_started'",
    `  AND timestamp >= toDateTime('${sqlLiteral(window.startIso)}')`,
    `  AND timestamp < toDateTime('${sqlLiteral(window.endIso)}')`,
    `  AND properties.$host = '${sqlLiteral(window.host)}'`,
  ].join('\n');

  const outcome = await runHogqlQuery(creds, query, fetchImpl, 3);
  if (!outcome.ok) return outcome;

  const [startsAll, starts, searchReferred] = outcome.row;
  return { ok: true, starts: { startsAll, starts, searchReferred } };
}

/** How far back to look for an admin's `$identify`, so a person identified on an
 *  earlier day is still recognised on this one. A person id is stable once
 *  merged, so a wider window only ever finds the same persons sooner. */
const OPERATOR_IDENTIFY_LOOKBACK_DAYS = 30;

/** The `$identify` retro-join subquery: which PostHog persons are admins. */
function operatorPersons(window: PosthogWindow, adminDistinctIds: readonly string[]): string {
  const ids = adminDistinctIds.map((id) => `'${sqlLiteral(id)}'`).join(', ');
  const since = new Date(
    Date.parse(window.startIso) - OPERATOR_IDENTIFY_LOOKBACK_DAYS * 86_400_000,
  ).toISOString();
  return (
    `SELECT person_id FROM events WHERE event = '$identify'` +
    ` AND distinct_id IN (${ids})` +
    ` AND timestamp >= toDateTime('${sqlLiteral(since)}')` +
    ` AND timestamp < toDateTime('${sqlLiteral(window.endIso)}')`
  );
}

// ─── Shared transport ────────────────────────────────────────────────────────

type HogqlRowOutcome = { ok: true; row: number[] } | { ok: false; reason: string };

/**
 * One HogQL request, one connection, one row of `columns` numbers.
 *
 * Every failure mode comes back as `{ ok: false, reason }` — a missing
 * credential, a timeout, a non-2xx, an unparseable body, a reshaped result. It
 * never throws and it never invents a number: an observability outage must
 * degrade the digest, not take it down, and a fabricated `0` beside a real count
 * reads as a finding rather than as missing data.
 */
async function runHogqlQuery(
  creds: PosthogCredentials,
  query: string,
  fetchImpl: typeof fetch,
  columns: number,
): Promise<HogqlRowOutcome> {
  const host = (creds.host || DEFAULT_HOST).replace(/\/+$/, '');

  let response: Response;
  try {
    response = await fetchImpl(`${host}/api/projects/${creds.projectId}/query/`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${creds.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, reason: `posthog_fetch_failed: ${errorText(error)}` };
  }

  if (!response.ok) {
    // Nothing below reads this body, and an unread body holds a connection until
    // the runtime cancels it (AECI-666). The error path is exactly where that is
    // easiest to forget and hardest to notice.
    discardResponseBody(response);
    return { ok: false, reason: `posthog_http_${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, reason: `posthog_body_unparseable: ${errorText(error)}` };
  }

  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results) || results.length === 0) {
    // A well-formed response with no rows is a real answer for a quiet day, but
    // PostHog returns `results: []` only when the aggregate itself is missing —
    // `count()` over an empty set still yields one row of zeros. So an empty
    // array means the shape changed, not that traffic was zero. Do not coerce it
    // to 0: a fabricated zero beside a real 48 reads as a finding.
    return { ok: false, reason: 'posthog_empty_result' };
  }

  const raw = results[0];
  if (!Array.isArray(raw) || raw.length < columns) {
    return { ok: false, reason: 'posthog_unexpected_row_shape' };
  }

  const row = raw.slice(0, columns).map(Number);
  if (row.some((value) => !Number.isFinite(value))) {
    return { ok: false, reason: 'posthog_non_numeric_result' };
  }

  return { ok: true, row };
}

/**
 * Escape a value for embedding in HogQL.
 *
 * Every value this module interpolates is server-derived (ISO timestamps from
 * `DigestWindow`, a host from `PUBLIC_SITE_URL`), so this is defence in depth
 * rather than the primary control — but the primary control is "no caller ever
 * passes user input", which is a convention, and conventions erode. Strips the
 * quote and backslash characters that could break out of the literal.
 */
function sqlLiteral(value: string): string {
  return value.replace(/['\\]/g, '');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The env's own public host, for {@link PosthogWindow.host}. Returns null when
 *  `PUBLIC_SITE_URL` is unset or malformed, which the caller reports as a skip
 *  rather than querying every tier's traffic at once. */
export function publicHostOf(publicSiteUrl: string | undefined): string | null {
  if (!publicSiteUrl) return null;
  try {
    return new URL(publicSiteUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

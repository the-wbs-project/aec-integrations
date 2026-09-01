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
 * (AECI-639 will narrow the gap from the other side: its Tier 2 "browser
 * operational" slice fires for ALL visitors including DNT/GPC, so the lower bound
 * stops being consent-limited. Until `stage-2` merges, read this as a floor.)
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
 */

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

  const host = (creds.host || DEFAULT_HOST).replace(/\/+$/, '');
  const query = [
    'SELECT count() AS pageviews, uniq(person_id) AS people',
    'FROM events',
    "WHERE event = '$pageview'",
    `  AND timestamp >= toDateTime('${sqlLiteral(window.startIso)}')`,
    `  AND timestamp < toDateTime('${sqlLiteral(window.endIso)}')`,
    `  AND properties.$host = '${sqlLiteral(window.host)}'`,
  ].join('\n');

  let response: Response;
  try {
    response = await fetchImpl(`${host}/api/projects/${creds.projectId}/query/`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${creds.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
    });
  } catch (error) {
    return { ok: false, reason: `posthog_fetch_failed: ${errorText(error)}` };
  }

  if (!response.ok) {
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

  const row = results[0];
  if (!Array.isArray(row) || row.length < 2) {
    return { ok: false, reason: 'posthog_unexpected_row_shape' };
  }

  const pageviews = Number(row[0]);
  const people = Number(row[1]);
  if (!Number.isFinite(pageviews) || !Number.isFinite(people)) {
    return { ok: false, reason: 'posthog_non_numeric_result' };
  }

  return { ok: true, traffic: { pageviews, people } };
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

/**
 * Cloudflare GraphQL Analytics transport for WAF firewall events (AECI-262).
 *
 * The free path to surface WAF rate-limit / challenge events in Datadog on our
 * **Pro** plan (Logpush is Enterprise-only): a scheduled poller queries the
 * zone's `firewallEventsAdaptiveGroups` over the Cloudflare GraphQL Analytics
 * API and emits the grouped counts via the existing `submitCount` intake
 * (`./datadog`). See `docs/waf-rate-limits.md` §5 and `docs/OBSERVABILITY.md`.
 *
 * This is *pure transport*: it authenticates with the token the caller hands it
 * and never throws — a network error, non-2xx, or a GraphQL
 * `errors[]` body comes back as a structured `{ ok: false }` outcome so the cron
 * can log + no-op without a try/catch (an observability outage must never tear
 * down the run). `fetchImpl` is injected (defaults to the global `fetch` at the
 * call site) so tests supply a mock without monkey-patching the global.
 *
 * The token must be scoped to `Zone Analytics: Read` on the target zone — a
 * narrow, read-only scope (distinct from the retired `Zone.Cache Purge` purge
 * token), so it is a separate secret (`CF_ANALYTICS_API_TOKEN`). The `zoneId` is
 * reused from the existing `CF_ZONE_ID` (the shared `aecintegrations.com` zone).
 */

/** Max groups requested per call. Cardinality is low (a handful of rules ×
 *  actions × one host), so 100 is generous; the outcome's `truncated` flag is set
 *  if the cap is ever hit so the caller can log it rather than silently dropping. */
export const WAF_EVENTS_GROUP_LIMIT = 100;

export type CfAnalyticsCredentials = {
  /**
   * Cloudflare API token scoped to `Zone Analytics: Read` on the target zone.
   * Optional so callers can pass an env value straight through; absent →
   * `cf_credentials_missing`.
   */
  apiToken: string | undefined;
  /** Cloudflare zone ID (GraphQL `zoneTag`). Absent → `cf_credentials_missing`. */
  zoneId: string | undefined;
};

/** The half-open time window + host the query is scoped to. */
export type WafEventsWindow = {
  /** ISO-8601 inclusive lower bound (`datetime_geq`). */
  startIso: string;
  /** ISO-8601 exclusive upper bound (`datetime_lt`). */
  endIso: string;
  /** Host to scope to (`clientRequestHTTPHost` filter) — one host per env so a
   *  shared zone isn't triple-counted across the `env:` tag. */
  host: string;
};

/** One `firewallEventsAdaptiveGroups` group, flattened to a metric-friendly shape. */
export type WafEventGroup = {
  /** Number of firewall events in the group (the metric value). */
  count: number;
  /** Mitigation taken — `block`, `managed_challenge`, `js_challenge`, … */
  action: string;
  /** WAF product the event came from — `ratelimit`, `firewallcustom`, … */
  source: string;
  /** The rule id that fired (opaque hash; mapped to names in `docs/waf-rate-limits.md`). */
  ruleId: string;
  /** The matched host (`clientRequestHTTPHost`). */
  host: string;
};

export type WafEventsOutcome =
  | { ok: true; groups: WafEventGroup[]; truncated: boolean }
  | { ok: false; message: string };

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

const FIREWALL_EVENTS_QUERY = `query WafFirewallEvents($zoneTag: String!, $start: Time!, $end: Time!, $host: String!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      firewallEventsAdaptiveGroups(
        filter: { datetime_geq: $start, datetime_lt: $end, clientRequestHTTPHost: $host }
        limit: ${WAF_EVENTS_GROUP_LIMIT}
        orderBy: [count_DESC]
      ) {
        count
        dimensions {
          action
          source
          ruleId
          clientRequestHTTPHost
        }
      }
    }
  }
}`;

type GraphQLResponse = {
  data?: {
    viewer?: {
      zones?: Array<{
        firewallEventsAdaptiveGroups?: Array<{
          count?: number;
          dimensions?: {
            action?: string;
            source?: string;
            ruleId?: string;
            clientRequestHTTPHost?: string;
          };
        }>;
      }>;
    };
  };
  errors?: Array<{ message?: string }>;
};

/** Join a GraphQL `errors[]` body into a single message (or undefined). */
function graphqlErrorMessage(body: GraphQLResponse | undefined): string | undefined {
  if (!body?.errors?.length) return undefined;
  return (
    body.errors
      .map((e) => e.message)
      .filter(Boolean)
      .join('; ') || undefined
  );
}

/**
 * Query the zone's WAF firewall events for `window`, grouped by
 * action/source/ruleId/host. Never throws — every failure mode (missing creds,
 * non-2xx, GraphQL `errors[]`, network error) is a structured `{ ok: false }`.
 *
 * Note the GraphQL API returns HTTP 200 even when the *query* failed, carrying
 * the failure in an `errors[]` body — so a 2xx with `errors` is still `ok:false`.
 */
export async function fetchWafFirewallEvents(
  fetchImpl: typeof fetch,
  creds: CfAnalyticsCredentials,
  window: WafEventsWindow,
): Promise<WafEventsOutcome> {
  if (!creds.apiToken || !creds.zoneId) {
    return { ok: false, message: 'cf_credentials_missing' };
  }
  try {
    const res = await fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${creds.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: FIREWALL_EVENTS_QUERY,
        variables: {
          zoneTag: creds.zoneId,
          start: window.startIso,
          end: window.endIso,
          host: window.host,
        },
      }),
    });

    let body: GraphQLResponse | undefined;
    try {
      body = (await res.json()) as GraphQLResponse;
    } catch {
      // Body wasn't JSON (e.g. an upstream 5xx HTML page).
      body = undefined;
    }

    if (!res.ok) {
      return {
        ok: false,
        message: graphqlErrorMessage(body) ?? res.statusText ?? `cf_http_${res.status}`,
      };
    }
    const errorMessage = graphqlErrorMessage(body);
    if (errorMessage) {
      return { ok: false, message: errorMessage };
    }

    const rawGroups = body?.data?.viewer?.zones?.[0]?.firewallEventsAdaptiveGroups ?? [];
    const groups: WafEventGroup[] = rawGroups.map((g) => ({
      count: g.count ?? 0,
      action: g.dimensions?.action ?? 'unknown',
      source: g.dimensions?.source ?? 'unknown',
      ruleId: g.dimensions?.ruleId ?? 'unknown',
      host: g.dimensions?.clientRequestHTTPHost ?? window.host,
    }));
    return { ok: true, groups, truncated: rawGroups.length >= WAF_EVENTS_GROUP_LIMIT };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'cf_network_error',
    };
  }
}

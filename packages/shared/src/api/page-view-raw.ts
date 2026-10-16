import {
  PAGE_VIEW_IP_HEADERS,
  PAGE_VIEW_RAW_HEADERS,
  readPageViewWriter,
  type PageViewPayload,
  type PageViewWriter,
} from './page-views';

/**
 * The raw page-view envelope (AECI-1384, ADR 0041).
 *
 * One record per capture that reaches the API's `capturePageView`, written to a
 * Cloudflare Pipelines stream with a Parquet sink in R2. It is a backup of what the
 * API received, so a change to what `page_views` stores can be back-filled from
 * source. `page_view_id` and `cf.ray` join it to the D1 row.
 *
 * What it never holds: `cookie`, `authorization`, or any IP-bearing header. The IP
 * survives only as `ip_hash`, an HMAC under a monthly key derived from a Worker
 * secret.
 */
export const RAW_PAGE_VIEW_SCHEMA_VERSION = 1;

/**
 * What became of the capture.
 *
 * - `inserted`: a `page_views` row was written; `page_view_id` is its id.
 * - `conflict`: the insert hit the `dedupe_key` UNIQUE index (a race the probe missed).
 * - `deduped`: the dedupe probe found a row inside the window, so no insert ran.
 * - `sampled_out`: below the `PAGE_VIEWS_MIN_BOT_SCORE` floor.
 * - `failed`: something threw; `outcome_detail` holds the message.
 */
export type RawPageViewOutcome = 'inserted' | 'conflict' | 'deduped' | 'sampled_out' | 'failed';

/** Values the API derived at ingest. Null where the step never ran. */
export interface RawPageViewDerived {
  user_agent_hash: string | null;
  is_bot: boolean | null;
  bot_name: string | null;
  referrer_source: string | null;
  referrer_host: string | null;
  client_signals: Record<string, unknown> | null;
  dedupe_keys: { current: string; previous: string } | null;
  is_operator: boolean | null;
  owner_vendor_id: string | null;
  is_owner_visit: boolean | null;
  product_id: string | null;
  vendor_id: string | null;
  pair_product_a_id: string | null;
  pair_product_b_id: string | null;
  taxonomy_kind: string | null;
  taxonomy_id: string | null;
  locale: string | null;
}

export interface RawPageViewEnvelope {
  schema_version: typeof RAW_PAGE_VIEW_SCHEMA_VERSION;
  captured_at: string;
  env: string | null;
  writer: PageViewWriter | null;
  page_view_id: number | null;
  outcome: RawPageViewOutcome;
  outcome_detail: string | null;
  body: PageViewPayload;
  /** Arrival writes only; null for `browser-spa` (read `headers.referer` there). */
  eyeball_url: string | null;
  cf: Record<string, unknown> | null;
  headers: Record<string, string>;
  ip_hash: string | null;
  derived: RawPageViewDerived;
}

export function emptyRawPageViewDerived(): RawPageViewDerived {
  return {
    user_agent_hash: null,
    is_bot: null,
    bot_name: null,
    referrer_source: null,
    referrer_host: null,
    client_signals: null,
    dedupe_keys: null,
    is_operator: null,
    owner_vendor_id: null,
    is_owner_visit: null,
    product_id: null,
    vendor_id: null,
    pair_product_a_id: null,
    pair_product_b_id: null,
    taxonomy_kind: null,
    taxonomy_id: null,
    locale: null,
  };
}

/** Exact query-parameter names that can carry a credential or a one-time code. */
const SECRET_QUERY_PARAMS = new Set([
  'code',
  'token',
  'access_token',
  'refresh_token',
  'state',
  'key',
  'api_key',
  'session',
]);
const SECRET_QUERY_PARAM_RE = /secret|password|auth/i;

/**
 * Remove query parameters that can carry a secret (AECI-1384). Matches the names in
 * `SECRET_QUERY_PARAMS` case-insensitively, plus any name containing `secret`,
 * `password` or `auth`. Returns null for anything `URL` cannot parse. The hash is
 * kept, because the SSR Worker never sees one.
 */
export function stripSecretQueryParams(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const name of [...parsed.searchParams.keys()]) {
    if (SECRET_QUERY_PARAMS.has(name.toLowerCase()) || SECRET_QUERY_PARAM_RE.test(name)) {
      parsed.searchParams.delete(name);
    }
  }
  return parsed.toString();
}

/** Decoded header values above this are refused, so a forged header cannot balloon a record. */
const CF_RAW_MAX_LENGTH = 16_384;

/**
 * Encode a `request.cf` object for `PAGE_VIEW_RAW_HEADERS.cfRaw`: base64 of its UTF-8
 * JSON. Returns null for a missing object or one that will not serialize.
 */
export function encodeCfRaw(cf: unknown): string | null {
  if (cf === null || cf === undefined || typeof cf !== 'object') return null;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(cf));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  } catch {
    return null;
  }
}

/** Inverse of {@link encodeCfRaw}. Null on absent, oversize, or malformed input. */
export function decodeCfRaw(value: string | null | undefined): Record<string, unknown> | null {
  if (!value || value.length > CF_RAW_MAX_LENGTH) return null;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Headers never written to the raw store. `cookie` and `authorization` carry
 * credentials. So does every `cf-access-*` header ({@link DROPPED_HEADER_PREFIX}).
 * The IP headers are hashed instead. The two raw-store headers land in
 * their own envelope fields (`cf`, `eyeball_url`), so a copy here would be a duplicate
 * and, for the URL, an unstripped one.
 */
const DROPPED_HEADERS: ReadonlySet<string> = new Set([
  'cookie',
  'authorization',
  ...PAGE_VIEW_IP_HEADERS,
  PAGE_VIEW_RAW_HEADERS.cfRaw,
  PAGE_VIEW_RAW_HEADERS.eyeballUrl,
]);

/**
 * Cloudflare Access adds or passes through `cf-access-jwt-assertion`,
 * `cf-access-authenticated-user-email` and the service-token pair
 * `cf-access-client-id` / `cf-access-client-secret` on gated tiers (staging). The
 * proxy path forwards the browser's headers as they came, so the whole family is
 * dropped by prefix.
 */
const DROPPED_HEADER_PREFIX = 'cf-access-';

const OUTCOME_DETAIL_MAX = 500;

export interface BuildRawEnvelopeInput {
  capturedAt: Date;
  env: string | null;
  pageViewId: number | null;
  outcome: RawPageViewOutcome;
  outcomeDetail: string | null;
  body: PageViewPayload;
  /** The headers the API received. Writer, `cf` and eyeball URL are read from them. */
  headers: Headers;
  ipHash: string | null;
  derived: RawPageViewDerived;
}

/**
 * Build one envelope. Pure. The header filter runs before anything else reads the
 * headers, and `Headers` lower-cases names, so no casing slips a credential through.
 */
export function buildRawEnvelope(input: BuildRawEnvelopeInput): RawPageViewEnvelope {
  const headers: Record<string, string> = {};
  input.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (DROPPED_HEADERS.has(lower) || lower.startsWith(DROPPED_HEADER_PREFIX)) return;
    headers[lower] = value;
  });
  if (headers['referer'] !== undefined) {
    const stripped = stripSecretQueryParams(headers['referer']);
    if (stripped === null) delete headers['referer'];
    else headers['referer'] = stripped;
  }

  return {
    schema_version: RAW_PAGE_VIEW_SCHEMA_VERSION,
    captured_at: input.capturedAt.toISOString(),
    env: input.env,
    writer: readPageViewWriter(input.headers),
    page_view_id: input.pageViewId,
    outcome: input.outcome,
    outcome_detail:
      input.outcomeDetail === null ? null : input.outcomeDetail.slice(0, OUTCOME_DETAIL_MAX),
    body: input.body,
    eyeball_url: stripSecretQueryParams(input.headers.get(PAGE_VIEW_RAW_HEADERS.eyeballUrl)),
    cf: decodeCfRaw(input.headers.get(PAGE_VIEW_RAW_HEADERS.cfRaw)),
    headers,
    ip_hash: input.ipHash,
    derived: input.derived,
  };
}

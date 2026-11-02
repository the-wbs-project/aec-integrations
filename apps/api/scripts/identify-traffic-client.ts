/**
 * identify-traffic-client.ts — name a client from its stored user-agent hash and
 * ASN (AECI-1580, `POST_LAUNCH_MONITORING.md` §3b).
 *
 * `page_views` keeps only a hash of the user agent. This lists the user agents
 * Cloudflare saw on one network on one UTC day, hashes each one the way ingest does,
 * and marks the match. For the match, or the busiest user agents when no hash is
 * given, it reports what was fetched and how spread out the client was.
 *
 * SAFETY:
 *   - Read-only. It runs GraphQL queries against Cloudflare's zone analytics. Nothing
 *     is written anywhere.
 *   - It prints a count of IPs and the busiest IP's request count, never an IP.
 *
 * LIMITS:
 *   - Counts are Cloudflare's sample-adjusted figures, so they can differ slightly
 *     from `page_views`.
 *   - It looks at the busiest {@link USER_AGENT_LIMIT} user agents on the network. A
 *     quiet client on a busy network can miss the list.
 *   - It says what the client sends, not who runs it. A generic user agent on rented
 *     addresses stays unnamed.
 *
 * USAGE (from the repo root, with `CF_READONLY_API_TOKEN` set):
 *   pnpm --filter @aeci/api ops:identify-traffic-client -- --asn 14618 --hash 7484a43e --day 2026-11-01
 *   pnpm --filter @aeci/api ops:identify-traffic-client -- --asn 8075 --day 2026-11-01
 *
 * Flags:
 *   --asn <n>            the page view's `cf_asn` (required)
 *   --hash <hex>         `user_agent_hash` or its prefix, 8+ characters. Omit to list
 *   --day YYYY-MM-DD     UTC day; default yesterday
 *   --host <host>        `ClientRequestHost`; default www.aecintegrations.com
 */

import { parseArgs } from 'node:util';

import {
  identifyUserAgents,
  noMatchMessage,
  parseHashPrefix,
  summarizeIpSpread,
  type IdentifiedUserAgent,
} from '../src/lib/traffic-client-identity';

const ZONE_TAG = '2246ff6dadcf91ea2d8a0160427b23ac';
const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const USER_AGENT_LIMIT = 100;
const IP_LIMIT = 1000;
const DETAIL_LIMIT = 5;
const BREAKDOWNS = [
  'edgeResponseContentTypeName',
  'edgeResponseStatus',
  'cacheStatus',
  'clientRequestReferer',
] as const;

type Filter = Record<string, string>;
interface Group {
  count: number;
  dimensions: Record<string, string | number>;
}

async function groupBy(
  token: string,
  dimension: string,
  filter: Filter,
  limit: number,
): Promise<Group[]> {
  const query = `query($zone: String!, $filter: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject!) {
    viewer { zones(filter: { zoneTag: $zone }) {
      httpRequestsAdaptiveGroups(limit: ${limit}, filter: $filter, orderBy: [count_DESC]) {
        count dimensions { ${dimension} }
      }
    } }
  }`;
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { zone: ZONE_TAG, filter } }),
  });
  if (!res.ok) throw new Error(`Cloudflare GraphQL returned ${res.status}`);
  const body = (await res.json()) as {
    errors?: { message: string }[] | null;
    data?: { viewer: { zones: { httpRequestsAdaptiveGroups: Group[] }[] } };
  };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data?.viewer.zones[0]?.httpRequestsAdaptiveGroups ?? [];
}

function yesterday(now = new Date()): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

function dayWindow(day: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new Error(`--day must be YYYY-MM-DD, got "${day}"`);
  }
  const to = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000);
  return { from: `${day}T00:00:00Z`, to: to.toISOString().replace('.000Z', 'Z') };
}

async function printDetail(token: string, row: IdentifiedUserAgent, base: Filter): Promise<void> {
  const filter = { ...base, userAgent: row.userAgent };
  console.log(`\n${row.matches ? 'MATCH ' : ''}${row.userAgent || '(blank user agent)'}`);
  console.log(`  hash      ${row.hash ? row.hash.slice(0, 8) : 'none (stored as NULL)'}`);
  console.log(`  requests  ${row.count}`);
  for (const dimension of BREAKDOWNS) {
    const groups = await groupBy(token, dimension, filter, 5);
    const text = groups
      .map((group) => `${group.dimensions[dimension] || '(none)'}=${group.count}`)
      .join(' ');
    console.log(`  ${dimension}: ${text}`);
  }
  const ips = await groupBy(token, 'clientIP', filter, IP_LIMIT);
  const spread = summarizeIpSpread(
    ips.map((group) => group.count),
    IP_LIMIT,
  );
  console.log(
    `  IPs       ${spread.ips}${spread.capped ? '+' : ''}, at most ${spread.maxPerIp} requests from one`,
  );
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: {
      asn: { type: 'string' },
      hash: { type: 'string' },
      day: { type: 'string' },
      host: { type: 'string', default: 'www.aecintegrations.com' },
    },
  });
  const token = process.env.CF_READONLY_API_TOKEN;
  if (!token) throw new Error('Set CF_READONLY_API_TOKEN (zone Analytics: Read)');
  if (!values.asn || !/^\d+$/.test(values.asn)) throw new Error('--asn <number> is required');

  const prefix = values.hash ? parseHashPrefix(values.hash) : null;
  const day = values.day ?? yesterday();
  const { from, to } = dayWindow(day);
  const base: Filter = {
    clientAsn: values.asn,
    clientRequestHTTPHost: values.host ?? '',
    datetime_geq: from,
    datetime_lt: to,
  };

  const groups = await groupBy(token, 'userAgent', base, USER_AGENT_LIMIT);
  const rows = await identifyUserAgents(
    groups.map((group) => ({
      userAgent: String(group.dimensions.userAgent ?? ''),
      count: group.count,
    })),
    prefix,
  );

  const capped = rows.length >= USER_AGENT_LIMIT ? '+' : '';
  console.log(`AS${values.asn} on ${values.host}, ${day} UTC: ${rows.length}${capped} user agents`);
  for (const row of rows.slice(0, 15)) {
    const hash = row.hash ? row.hash.slice(0, 8) : '--------';
    console.log(
      `${row.matches ? '*' : ' '} ${String(row.count).padStart(7)}  ${hash}  ${row.userAgent || '(blank)'}`,
    );
  }

  const detail = prefix ? rows.filter((row) => row.matches) : rows.slice(0, DETAIL_LIMIT);
  if (prefix && detail.length === 0) {
    console.log(`\n${noMatchMessage(prefix, rows.length, USER_AGENT_LIMIT)}`);
    return 1;
  }
  for (const row of detail) await printDetail(token, row, base);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

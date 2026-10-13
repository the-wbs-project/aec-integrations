#!/usr/bin/env node
//
// pull-moved-zone.mjs — saves the per-request record the OLD aecintegrations.com zone still
// holds for the days between the 2026-10-01 backfill and the move to The WBS Project account
// (AECI-1302). The old zone (`32f7aec2…`, status `moved`) served traffic until about
// 2026-10-04T04:30Z. The new zone (`2246ff6d…`) starts at 04:00Z, so the two overlap.
// `pull.mjs` covers the new zone.
//
// READ-ONLY. It calls the Cloudflare GraphQL Analytics API, which runs queries and writes
// nothing. The old zone sits on the AEC Integrations account, so it needs a token that can
// read zone analytics there. On 2026-10-13 only the wrangler OAuth login could:
//
//   CF_READONLY_API_TOKEN=<wrangler oauth_token> node pull-moved-zone.mjs [from] [to]
//
// A moved zone answers with a reduced field set. On 2026-10-13 it refused `datetimeHour`,
// `clientRequestHTTPHost`, `clientRequestQuery`, `clientAsn`, `clientASNDescription`,
// `clientRefererHost`, `securityAction` and `avg.edgeTimeToFirstByteMs`. Firewall events
// were gone (`notOlderThan` 0). So this pull is coarser than the backfill:
//   - time is `datetimeFifteenMinutes`, not the hour;
//   - host comes from filtering one host at a time; anything else is `(other)`;
//   - query string, network (ASN) and referrer host are lost.
// Client IP addresses are available and are still never requested.
//
// Output: http-requests/<YYYY-MM>.moved-zone.csv.gz beside this script, or under OUT_DIR.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ZONE = '32f7aec29792163c443b6c40f5fb9a56';
const LIMIT = 10_000;
const HOUR = 3_600_000;
const HERE = process.env.OUT_DIR ?? dirname(fileURLToPath(import.meta.url));

// Every host the new zone saw in its first nine days with more than a handful of requests.
// Port-suffixed variants and anything new fall into `(other)` via `_notin`.
const HOSTS = [
  'www.aecintegrations.com',
  'aecintegrations.com',
  'review.aecintegrations.com',
  'demo.aecintegrations.com',
  'staging.aecintegrations.com',
  'stack-test.aecintegrations.com',
  'stage2.aecintegrations.com',
  'us.i.posthog.com',
];

// Overlap the backfill by a day so the two files can be reconciled.
const FROM = Date.parse(process.argv[2] ?? '2026-09-30T00:00:00Z');
const TO = Date.parse(process.argv[3] ?? '2026-10-04T06:00:00Z');

const token = process.env.CF_READONLY_API_TOKEN;
if (!token) throw new Error('Set CF_READONLY_API_TOKEN to a token that reads the old zone');

const SELECT = `count
  sum { visits edgeResponseBytes }
  avg { originResponseDurationMs sampleInterval }
  dimensions { datetimeFifteenMinutes clientRequestPath clientRequestHTTPMethodName
    edgeResponseStatus edgeResponseContentTypeName cacheStatus userAgent verifiedBotCategory
    clientCountryName clientDeviceType securitySource requestSource }`;

async function graphql(query) {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

async function fetchWindow(hostFilter, from, to) {
  const range = `datetime_geq: "${new Date(from).toISOString()}", datetime_lt: "${new Date(to).toISOString()}"`;
  const data = await graphql(
    `{ viewer { zones(filter: { zoneTag: "${ZONE}" }) { httpRequestsAdaptiveGroups(limit: ${LIMIT}, filter: { ${range}, ${hostFilter} }) { ${SELECT} } } } }`,
  );
  const rows = data.viewer.zones[0].httpRequestsAdaptiveGroups;
  if (rows.length < LIMIT) return rows;
  if (to - from <= 15 * 60_000) throw new Error(`a fifteen-minute window still hit ${LIMIT} rows`);
  const mid = from + Math.floor((to - from) / 2 / 900_000) * 900_000;
  return [
    ...(await fetchWindow(hostFilter, from, mid)),
    ...(await fetchWindow(hostFilter, mid, to)),
  ];
}

function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const name = prefix ? `${prefix}_${key}` : key;
    if (value && typeof value === 'object') flatten(value, name, out);
    else out[name] = value;
  }
  return out;
}

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

const partitions = [
  ...HOSTS.map((h) => [h, `clientRequestHTTPHost: "${h}"`]),
  ['(other)', `clientRequestHTTPHost_notin: ${JSON.stringify(HOSTS)}`],
];
const rows = [];
for (const [host, filter] of partitions) {
  let n = 0;
  for (let start = FROM; start < TO; start += 6 * HOUR) {
    for (const r of await fetchWindow(filter, start, Math.min(start + 6 * HOUR, TO))) {
      rows.push({ dimensions_clientRequestHTTPHost: host, ...flatten(r) });
      n += r.count;
    }
  }
  console.error(`${host}: ${n} requests`);
}

const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
const timeKey = 'dimensions_datetimeFifteenMinutes';
mkdirSync(join(HERE, 'http-requests'), { recursive: true });
for (const [month, monthRows] of Map.groupBy(rows, (r) => r[timeKey].slice(0, 7))) {
  // Time, then busiest first. Binary order is fine: the keys are ISO timestamps and numbers.
  monthRows.sort((a, b) =>
    a[timeKey] < b[timeKey] ? -1 : a[timeKey] > b[timeKey] ? 1 : b.count - a.count,
  );
  const csv = [
    columns.join(','),
    ...monthRows.map((r) => columns.map((c) => cell(r[c])).join(',')),
  ];
  const file = join(HERE, 'http-requests', `${month}.moved-zone.csv.gz`);
  writeFileSync(file, gzipSync(`${csv.join('\n')}\n`, { level: 9 }));
  console.error(`${file}: ${monthRows.length} rows`);
}

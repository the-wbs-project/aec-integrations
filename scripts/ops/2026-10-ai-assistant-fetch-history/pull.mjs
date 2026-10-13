#!/usr/bin/env node
//
// pull.mjs — pulls every AI-assistant request Cloudflare still holds for the
// aecintegrations.com zone into a CSV, so the history outlives Cloudflare's retention.
//
// READ-ONLY. It calls the Cloudflare GraphQL Analytics API (`httpRequestsAdaptiveGroups`),
// which runs a query and writes nothing. It needs CF_READONLY_API_TOKEN with zone
// Analytics: Read.
//
// It reaches back as far as the zone's `notOlderThan` setting allows, read at run time (31
// days on the old Pro zone, 90 on the Enterprise zone). It queries one day at a time, which
// keeps each result under the 10,000-row page limit, and it throws rather than truncate if a
// day ever reaches it.
//
// The zone moved to The WBS Project account on 2026-10-04 and got a new zone id. The default
// is the live zone. CF_ZONE_TAG points it at another zone. The old, `moved` zone
// (`32f7aec2…`) refuses this query's host, query and ASN fields, so it cannot be pulled here.
// Filter that zone's `pull-moved-zone.mjs` output on user agent instead.
//
// Every row is one unique combination of the dimensions below, with its request count.
// Counts are Cloudflare's sample-adjusted estimates. No IP addresses are requested.
//
//   node pull.mjs [out.csv]
//
// The default output name is fetches-<first-day>_<last-day>.csv beside this script.
// Successive pulls overlap. De-duplicate on the dimension columns when combining files,
// and prefer the newer file for a day both contain (an older file's last day is partial).

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ZONE = process.env.CF_ZONE_TAG ?? '2246ff6dadcf91ea2d8a0160427b23ac';
const DAY = 86_400_000;

// The on-demand assistant user agents (a person asked, the assistant fetched). Requests
// Cloudflare files under the `AI Assistant` verified category are pulled too, so a new
// assistant is captured before it is named here.
const AGENTS = [
  'ChatGPT-User',
  'Claude-User',
  'Perplexity-User',
  'MistralAI-User',
  'DuckAssistBot',
];

// Networks a consumer `Claude-User` cannot come from. Used only by `genuine_guess`.
const CLOUD_ASN = /Google|Amazon|Cloudflare|Microsoft|Infraly|WS Telecom|DigitalOcean|OVH|Hetzner/i;

const token = process.env.CF_READONLY_API_TOKEN;
if (!token) throw new Error('Set CF_READONLY_API_TOKEN (zone Analytics: Read)');

const QUERY = `query($z:String!,$s:Time!,$e:Time!){viewer{zones(filter:{zoneTag:$z}){
  httpRequestsAdaptiveGroups(limit:10000,filter:{datetime_geq:$s,datetime_lt:$e,OR:[
    ${AGENTS.map((a) => `{userAgent_like:"%${a}%"}`).join(',')},{verifiedBotCategory:"AI Assistant"}]}){
    count dimensions{date clientRequestHTTPHost clientRequestPath clientRequestQuery
      clientRequestHTTPMethodName edgeResponseStatus userAgent verifiedBotCategory
      clientAsn clientASNDescription clientCountryName securitySource}}}}}`;

async function graphql(query, variables) {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

async function pull(from, to) {
  const data = await graphql(QUERY, {
    z: ZONE,
    s: new Date(from).toISOString(),
    e: new Date(to).toISOString(),
  });
  const groups = data.viewer.zones[0].httpRequestsAdaptiveGroups;
  if (groups.length >= 10_000)
    throw new Error(`Page limit reached for ${new Date(from).toISOString()}`);
  return groups;
}

const settings = await graphql(
  'query($z:String!){viewer{zones(filter:{zoneTag:$z}){settings{httpRequestsAdaptiveGroups{notOlderThan}}}}}',
  { z: ZONE },
);
const retentionMs =
  settings.viewer.zones[0].settings.httpRequestsAdaptiveGroups.notOlderThan * 1000;

// Start an hour inside the retention edge so the oldest query is never refused.
const now = Date.now();
const groups = [];
for (let from = now - retentionMs + 3_600_000; from < now; from += DAY) {
  groups.push(...(await pull(from, Math.min(from + DAY, now))));
}

const HEADER = [
  'date',
  'agent',
  'verified',
  'genuine_guess',
  'host',
  'path',
  'query',
  'method',
  'status',
  'country',
  'asn',
  'asn_name',
  'security_source',
  'user_agent',
  'count',
];

const rows = groups
  .map(({ count, dimensions: d }) => {
    const agent = AGENTS.find((a) => d.userAgent.includes(a)) ?? 'other AI assistant';
    const verified = Boolean(d.verifiedBotCategory);
    // Verified by Cloudflare, or a Claude app on someone's own machine. The scanner that
    // borrows assistant names runs from cloud networks and never gets a 2xx.
    const genuine =
      verified || (agent === 'Claude-User' && !CLOUD_ASN.test(d.clientASNDescription));
    return [
      d.date,
      agent,
      verified,
      genuine,
      d.clientRequestHTTPHost,
      d.clientRequestPath,
      d.clientRequestQuery,
      d.clientRequestHTTPMethodName,
      d.edgeResponseStatus,
      d.clientCountryName,
      d.clientAsn,
      d.clientASNDescription,
      d.securitySource,
      d.userAgent,
      count,
    ];
  })
  // Date, then busiest first. Binary order is fine: every key here is an ISO date or a number.
  .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : b.at(-1) - a.at(-1)));

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

const out =
  process.argv[2] ??
  join(dirname(fileURLToPath(import.meta.url)), `fetches-${rows[0][0]}_${rows.at(-1)[0]}.csv`);
writeFileSync(out, [HEADER, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n');

const total = (keep) => rows.filter(keep).reduce((n, r) => n + r.at(-1), 0);
console.error(
  `${out}: ${rows.length} rows, ${total(() => true)} requests, ` +
    `${total((r) => r[2])} verified, ${total((r) => r[3])} genuine_guess`,
);

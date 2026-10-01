#!/usr/bin/env node
//
// pull.mjs — saves every page-view and traffic record Cloudflare still holds for the
// aecintegrations.com zone, before its retention window drops it. Logpush only captures
// traffic from the day it is switched on (AECI-1169), so this is the only backfill.
//
// READ-ONLY. It calls the Cloudflare GraphQL Analytics API, which runs queries and writes
// nothing. It needs CF_READONLY_API_TOKEN with zone Analytics: Read and account Analytics: Read.
//
// Client IP addresses are never requested. Everything else each dataset offers that is
// useful for page-view analysis is kept.
//
// Each dataset is written as gzipped CSV, one file per UTC month:
//   <dataset>/<YYYY-MM>.csv.gz
// A later pull never overwrites one; it writes <YYYY-MM>.pulled-<date>.csv.gz beside it.
// A row is one unique combination of the dataset's dimensions, with its metrics. Counts
// are Cloudflare's sample-adjusted estimates.
//
//   node pull.mjs [dataset ...]      (default: every dataset)
//
// A window that returns the 10,000-row page limit is split in half and re-queried, down to
// five minutes. Below that the script throws rather than keep a truncated window.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ZONE = '32f7aec29792163c443b6c40f5fb9a56';
const ACCOUNT = 'e62ec9d8012c3e0c225f8e4dbab76b79';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LIMIT = 10_000;
const HERE = dirname(fileURLToPath(import.meta.url));

const token = process.env.CF_READONLY_API_TOKEN;
if (!token) throw new Error('Set CF_READONLY_API_TOKEN (zone + account Analytics: Read)');

// `retentionDays` is the dataset's `notOlderThan`, read from the GraphQL settings query on
// 2026-10-01 for the Pro plan. `window` is the first query size; it shrinks on demand.
const DATASETS = {
  'http-requests': {
    scope: 'zone',
    field: 'httpRequestsAdaptiveGroups',
    retentionDays: 31,
    window: 6 * HOUR,
    filter: 'datetime',
    select: `count
      sum { visits edgeResponseBytes }
      avg { edgeTimeToFirstByteMs originResponseDurationMs sampleInterval }
      dimensions { datetimeHour clientRequestHTTPHost clientRequestPath clientRequestQuery
        clientRequestHTTPMethodName edgeResponseStatus edgeResponseContentTypeName cacheStatus
        userAgent verifiedBotCategory clientAsn clientASNDescription clientCountryName
        clientDeviceType clientRefererHost securityAction securitySource requestSource }`,
  },
  'firewall-events': {
    scope: 'zone',
    field: 'firewallEventsAdaptiveGroups',
    retentionDays: 3,
    window: 6 * HOUR,
    filter: 'datetime',
    select: `count
      dimensions { datetimeHour action source ruleId rulesetId description clientRequestHTTPHost
        clientRequestPath clientRequestQuery clientRequestHTTPMethodName edgeResponseStatus
        userAgent verifiedBotCategory clientAsn clientASNDescription clientCountryName
        clientRefererHost }`,
  },
  'daily-rollup': {
    scope: 'zone',
    field: 'httpRequests1dGroups',
    retentionDays: 365,
    window: 120 * DAY,
    filter: 'date',
    select: `dimensions { date }
      uniq { uniques }
      sum { requests pageViews bytes cachedRequests cachedBytes threats
        countryMap { clientCountryName requests bytes threats }
        responseStatusMap { edgeResponseStatus requests }
        browserMap { uaBrowserFamily pageViews }
        contentTypeMap { edgeResponseContentTypeName requests bytes }
        ipClassMap { ipType requests } }`,
  },
  'rum-pageloads': {
    scope: 'account',
    field: 'rumPageloadEventsAdaptiveGroups',
    retentionDays: 184,
    window: 7 * DAY,
    filter: 'datetime',
    select: `count
      sum { visits }
      dimensions { datetimeHour requestHost requestPath refererHost refererPath countryName
        deviceType userAgentBrowser userAgentOS navigationType bot }`,
  },
  // Account RUM queries cap at 30 fields, so FCP is left to rum-performance.
  'rum-web-vitals': {
    scope: 'account',
    field: 'rumWebVitalsEventsAdaptiveGroups',
    retentionDays: 184,
    window: 7 * DAY,
    filter: 'datetime',
    select: `count
      sum { visits lcpGood lcpNeedsImprovement lcpPoor lcpTotal inpGood inpNeedsImprovement inpPoor
        inpTotal clsGood clsNeedsImprovement clsPoor clsTotal ttfbGood ttfbNeedsImprovement ttfbPoor ttfbTotal }
      quantiles { largestContentfulPaintP75 interactionToNextPaintP75 cumulativeLayoutShiftP75
        timeToFirstByteP75 }
      dimensions { date requestHost requestPath deviceType countryName }`,
  },
  'rum-performance': {
    scope: 'account',
    field: 'rumPerformanceEventsAdaptiveGroups',
    retentionDays: 184,
    window: 7 * DAY,
    filter: 'datetime',
    select: `count
      sum { visits }
      avg { pageLoadTime pageRenderTime responseTime firstContentfulPaint dnsTime connectionTime }
      quantiles { pageLoadTimeP50 pageLoadTimeP75 pageLoadTimeP95 responseTimeP50 responseTimeP75 }
      dimensions { date requestHost requestPath deviceType countryName }`,
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function graphql(query) {
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const body = await res.json().catch(() => ({ errors: [{ message: `HTTP ${res.status}` }] }));
    const limited =
      res.status === 429 || body.errors?.some((e) => /rate|quota exceeded/i.test(e.message));
    if (!limited && !body.errors) return body.data;
    if (!limited || attempt === 6) throw new Error(JSON.stringify(body.errors));
    await sleep(attempt * 20_000);
  }
}

function range(ds, from, to) {
  if (ds.filter === 'date') {
    const day = (t) => new Date(t).toISOString().slice(0, 10);
    return `date_geq: "${day(from)}", date_lt: "${day(to)}"`;
  }
  return `datetime_geq: "${new Date(from).toISOString()}", datetime_lt: "${new Date(to).toISOString()}"`;
}

async function fetchWindow(ds, from, to) {
  const scope =
    ds.scope === 'zone'
      ? `zones(filter: { zoneTag: "${ZONE}" })`
      : `accounts(filter: { accountTag: "${ACCOUNT}" })`;
  const data = await graphql(
    `{ viewer { ${scope} { ${ds.field}(limit: ${LIMIT}, filter: { ${range(ds, from, to)} }) { ${ds.select} } } } }`,
  );
  const rows = Object.values(data.viewer)[0][0][ds.field];
  if (rows.length < LIMIT) return rows;
  if (to - from <= 5 * 60_000)
    throw new Error(`${ds.field}: a five-minute window still hit ${LIMIT} rows`);
  const mid = from + Math.floor((to - from) / 2 / 60_000) * 60_000;
  return [...(await fetchWindow(ds, from, mid)), ...(await fetchWindow(ds, mid, to))];
}

// Nested objects become `a_b` columns. Arrays (the daily-rollup maps) stay as JSON text.
function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const name = prefix ? `${prefix}_${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, name, out);
    else out[name] = Array.isArray(value) ? JSON.stringify(value) : value;
  }
  return out;
}

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

async function pull(name) {
  const ds = DATASETS[name];
  const now = Date.now();
  // Daily data is keyed by whole UTC days; start at a day boundary inside retention.
  let from = now - ds.retentionDays * DAY + HOUR;
  if (ds.filter === 'date') from = Math.ceil(from / DAY) * DAY;
  const rows = [];
  for (let start = from; start < now; start += ds.window) {
    rows.push(
      ...(await fetchWindow(ds, start, Math.min(start + ds.window, now))).map((r) => flatten(r)),
    );
    process.stderr.write(
      `${name}: ${new Date(start).toISOString().slice(0, 13)} ${rows.length} rows\n`,
    );
  }
  if (!rows.length) return console.error(`${name}: no rows`);

  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const timeKey = columns.find((c) => /^dimensions_(datetimeHour|date)$/.test(c));
  const months = Map.groupBy(rows, (r) => String(r[timeKey]).slice(0, 7));
  mkdirSync(join(HERE, name), { recursive: true });
  for (const [month, monthRows] of months) {
    // Time, then busiest first. Binary order is fine: the keys are ISO timestamps and numbers.
    monthRows.sort((a, b) =>
      a[timeKey] < b[timeKey] ? -1 : a[timeKey] > b[timeKey] ? 1 : (b.count ?? 0) - (a.count ?? 0),
    );
    const csv = [
      columns.join(','),
      ...monthRows.map((r) => columns.map((c) => cell(r[c])).join(',')),
    ].join('\n');
    // Never overwrite an earlier pull: its oldest month may hold days this run can no longer reach.
    let file = join(HERE, name, `${month}.csv.gz`);
    if (existsSync(file))
      file = join(HERE, name, `${month}.pulled-${new Date(now).toISOString().slice(0, 10)}.csv.gz`);
    writeFileSync(file, gzipSync(`${csv}\n`, { level: 9 }));
  }
  console.error(`${name}: ${rows.length} rows in ${months.size} month files`);
}

for (const name of process.argv.length > 2 ? process.argv.slice(2) : Object.keys(DATASETS)) {
  if (!DATASETS[name])
    throw new Error(`Unknown dataset ${name}. Known: ${Object.keys(DATASETS).join(', ')}`);
  await pull(name);
}

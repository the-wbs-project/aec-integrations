#!/usr/bin/env node
//
// pull-404s.mjs — pulls every 404 the production SSR Worker logged, from Workers Logs,
// into the observed-404s JSON shape that check-corpus.mjs reads.
//
// READ-ONLY. It calls one Cloudflare endpoint, the Workers Observability query API. That
// endpoint is a POST, but it runs a query and writes nothing. It needs an ACCOUNT token
// with "Workers Observability: Read" in CF_READONLY_API_TOKEN. The wrangler OAuth login
// does not carry that scope.
//
// It queries one day at a time, because a multi-day aggregate comes back sampled
// (abr_level > 1) and loses the rare paths. Workers Logs keeps 7 days.
//
// Output keeps the path and counts only. No IPs, no user agents, no query strings.
//
//   node pull-404s.mjs [days=7] [scannerAsn=396982] > observed-404s-YYYY-MM.json

const ACCOUNT = '004dc1af737b22a8aa83b3550fa9b9d3';
const SERVICE = 'aeci-web-production';
const DAY = 86_400_000;

const days = Number(process.argv[2] ?? 7);
const scannerAsn = Number(process.argv[3] ?? 396982);
const token = process.env.CF_READONLY_API_TOKEN;
if (!token)
  throw new Error('Set CF_READONLY_API_TOKEN (account token, Workers Observability: Read)');

const f = (key, operation, type, value) => ({ key, operation, type, value });

async function day(from, to) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queryId: 'aeci-1138-404-paths',
        view: 'calculations',
        limit: 2000,
        timeframe: { from, to },
        parameters: {
          datasets: ['cloudflare-workers'],
          filters: [
            f('$metadata.service', 'eq', 'string', SERVICE),
            f('$workers.event.response.status', 'eq', 'number', 404),
          ],
          calculations: [{ operator: 'count', alias: 'n' }],
          groupBys: [
            { type: 'string', value: '$workers.event.request.url' },
            { type: 'number', value: '$workers.event.request.cf.asn' },
          ],
          limit: 2000,
        },
      }),
    },
  );
  const body = await res.json();
  if (!body.success)
    throw new Error(`Workers Observability query failed: ${JSON.stringify(body.errors)}`);
  const abr = body.result.run.statistics?.abr_level;
  if (abr > 1)
    console.error(`warning: ${new Date(from).toISOString()} came back sampled (abr_level ${abr})`);
  return body.result.calculations[0].aggregates;
}

const now = Date.now();
const agg = new Map();
for (let d = 0; d < days; d++) {
  for (const a of await day(now - (d + 1) * DAY, now - d * DAY)) {
    const [url, asn] = a.groups.map((g) => g.value);
    let path;
    try {
      path = decodeURIComponent(new URL(url).pathname);
    } catch {
      path = new URL(url).pathname;
    }
    const e = agg.get(path) ?? { path, requests: 0, scanner_as396982: 0 };
    e.requests += a.value;
    if (asn === scannerAsn) e.scanner_as396982 += a.value;
    agg.set(path, e);
  }
}

const paths = [...agg.values()].sort(
  (a, b) => b.requests - a.requests || (a.path < b.path ? -1 : 1),
);
const source = `Cloudflare Workers Logs, ${SERVICE}, response.status=404, ${new Date(now - days * DAY).toISOString().slice(0, 10)}..${new Date(now).toISOString().slice(0, 10)} (unsampled per-day pulls)`;
process.stdout.write(`${JSON.stringify({ source, paths }, null, 1)}\n`);

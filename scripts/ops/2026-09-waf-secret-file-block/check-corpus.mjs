#!/usr/bin/env node
//
// check-corpus.mjs — proves the AECI-1138 probe-block rules block no legitimate path, and
// measures how much of the observed scanner traffic they stop.
//
// Every rule is read from docs/waf-rate-limits.md as a fenced ```wirefilter title="…"```
// block and evaluated by cf-expr.mjs, so the check runs against the literal text the doc
// records (and payload.mjs sends). That covers the two new rules and the two pre-existing
// Block rules ("Block scanner probes", "Blocker 2").
//
// Three checks, all must hold for exit 0:
//   1. LEGIT: no rule matches any path we serve — static routes, assets, /.well-known,
//      the IndexNow key file, every API route in apps/api/src, every prod catalog slug.
//   2. OBSERVED-LEGIT: no rule matches an observed 404 that a real client produces —
//      stale build chunks after a deploy, retired slugs, crawler conventions.
//   3. PROBES: every path in PROBES is blocked by some rule.
// Then it prints coverage of an observed-404s file (default: observed-404s-2026-09.json,
// Workers Logs 2026-09-21..28; pull a fresh one with pull-404s.mjs).
//
// STRICTLY LOCAL. It calls nothing. The slug list is an input file you produce with
// read-only D1 queries (README.md §1).
//
//   node scripts/ops/2026-09-waf-secret-file-block/check-corpus.mjs /tmp/aeci-slugs.txt [observed.json]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from './cf-expr.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '../../../');
const slugFile = process.argv[2] ?? '/tmp/aeci-slugs.txt';
const HOST = 'www.aecintegrations.com';

// ---- the rules, read from the doc -----------------------------------------------------
const doc = readFileSync(join(ROOT, 'docs/waf-rate-limits.md'), 'utf8');
const RULES = [...doc.matchAll(/```wirefilter title="([^"]+)"\n([\s\S]*?)```/g)].map((m) => ({
  title: m[1],
  test: compile(m[2].replace(/\s+/g, ' ').trim()),
}));
const NEW = RULES.filter((r) => r.title.includes('AECI-1138'));
if (NEW.length !== 2 || RULES.length !== 4) {
  throw new Error(`Expected 4 wirefilter rules (2 tagged AECI-1138), found ${RULES.length}`);
}
const hits = (path) => RULES.filter((r) => r.test({ host: HOST, path })).map((r) => r.title);

// ---- 1. the legitimate corpus ---------------------------------------------------------
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
  });
const scan = (dir, re) =>
  new Set(
    walk(join(ROOT, dir)).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(re)].map((m) => m[1]),
    ),
  );
const apiRoutes = scan(
  'apps/api/src',
  /\.(?:get|post|put|patch|delete|all)\(\s*['`](\/[^'`]*)['`]/g,
);
const ngRoutes = scan('apps/web/src/app', /path: '([^']*)'/g);

const slugs = readFileSync(slugFile, 'utf8')
  .trim()
  .split('\n')
  .map((l) => l.split(' '));
const by = (k) => slugs.filter(([kind]) => kind === k).map(([, s]) => s);
const fill = (r) => r.replace(/:[A-Za-z]+(\{[^}]*\})?/g, 'x1').replace('*', 'x1');

const LEGIT = [
  '/',
  '/_version',
  '/sitemap.xml',
  '/robots.txt',
  '/0123456789abcdef0123456789abcdef.txt',
  '/favicon.ico',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/manifest.webmanifest',
  '/3rdpartylicenses.txt',
  '/branding/home-og.png',
  '/branding/monogram-dark.svg',
  '/branding/monogram-light.svg',
  '/branding/email-logo-banner.png',
  '/main-ABCD1234.js',
  '/chunk-ABCD1234.js',
  '/chunk-ABCD1234.js.map',
  '/polyfills-ABCD1234.js',
  '/styles-ABCD1234.css',
  '/.well-known/security.txt',
  '/.well-known/acme-challenge/tok',
  '/.well-known/assetlinks.json',
  '/.well-known/apple-app-site-association',
  '/.well-known/cf-custom-hostname-challenge/x',
  '/.well-known/traffic-advice',
  '/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1',
  '/auth/callback',
  '/admin/purge',
  `/api/logos/${'a'.repeat(64)}`,
  ...[...ngRoutes]
    .filter((r) => r && r !== '**')
    .flatMap((r) => [`/${fill(r)}`, `/admin/${fill(r)}`, `/preview/${fill(r)}`]),
  ...[...apiRoutes].map(fill),
];
for (const v of by('v'))
  LEGIT.push(
    `/vendors/${v}`,
    `/vendors/${v}/claim`,
    `/vendors/${v}/correction`,
    `/vendor/${v}`,
    `/vendor/${v}/overview`,
    `/api/vendors/${v}`,
  );
for (const p of by('p'))
  LEGIT.push(
    `/products/${p}`,
    `/products/${p}/claim`,
    `/products/${p}/correction`,
    `/products/${p}/review`,
    `/products/${p}/integrations/${p}`,
    `/api/products/${p}`,
    `/api/products/${p}/reviews`,
  );
for (const s of by('r')) LEGIT.push(`/products/${s}`, `/vendors/${s}`);
for (const [k, pre] of [
  ['c', 'categories'],
  ['a', 'audiences'],
  ['ph', 'phases'],
  ['t', 'trades'],
])
  for (const s of by(k)) LEGIT.push(`/${pre}/${s}`);
for (const m of readFileSync(join(ROOT, 'apps/web/src/app/docs/docs-content.ts'), 'utf8').matchAll(
  /slug: '([^']+)'/g,
))
  LEGIT.push(`/docs/vendors/${m[1]}`);

// ---- 2. observed 404s that real clients produce -----------------------------------------
// A stale chunk after a deploy, fetched at the root or relative to a nested route, is the
// big one: blocking it would turn a harmless 404 into a 403 for a real browser mid-session.
const observedFile = process.argv[3] ?? join(HERE, 'observed-404s-2026-09.json');
const observed = JSON.parse(readFileSync(observedFile, 'utf8')).paths;
const ROUTE_PREFIX =
  /^\/(products|vendors|vendor|categories|audiences|phases|trades|integrations|docs|legal|admin|auth|claims|connectors|disciplines|invite|preview|search)(\/|$)/;
const ASSET = /\/(chunk|main|polyfills|styles|worker)-[A-Za-z0-9]+\.(js|css)(\.map)?$/;
const OBSERVED_LEGIT = [
  ...observed
    .map((e) => e.path)
    .filter((p) => ASSET.test(p) || (ROUTE_PREFIX.test(p) && !p.includes('/.'))),
  '/favicon.png',
  '/llms.txt',
  '/ads.txt',
  '/blog/',
  '/health',
  '/info',
  '/team',
];

// ---- 3. probes that MUST be blocked -------------------------------------------------------
const PROBES = [
  '/terraform.tfstate',
  '/terraform.tfstate.backup',
  '/.terraform/terraform.tfstate',
  '/terraform.tfvars',
  '/firebase-adminsdk.json',
  '/app/firebase-adminsdk-abc12-1234.json',
  '/.env',
  '/.env.local',
  '/api/.env',
  '/production.env',
  '/config/.env.production',
  '/.git/config',
  '/.aws/credentials',
  '/.ssh/id_rsa',
  '/id_rsa',
  '/credentials.json',
  '/service-account.json',
  '/config/service_account.json',
  '/serviceAccountKey.json',
  '/wp-config.php.bak',
  '/Wp-Json/gravitysmtp/v1/tests/mock-data',
  '/wp/',
  '/dump.sql',
  '/backup.sql.gz',
  '/database.sqlite',
  '/www.zip',
  '/server.key',
  '/cert.pem',
  '/.htpasswd',
  '/.codex/auth.json',
  '/.vite/manifest.json',
  '/__vite_rsc_findSourceMapURL',
  '/_next/build-manifest.json',
  '/__nuxt_config.json',
  '/pages/index.astro.mjs.map',
  '/_payload.json',
  '/api/config',
  '/api/v1/keys',
  '/inngest',
  '/functionRouter',
  '/proc/self/cgroup',
  '/var/run/secrets/kubernetes.io/serviceaccount/token',
  '/config.js',
  '/aws-exports.js',
  '/application.properties',
  '/config/prod.exs',
  '/elmah.axd',
  '/config.ts',
  '/credentials',
  '/private-key',
];

// ---- run ---------------------------------------------------------------------------------
let failures = 0;
for (const p of LEGIT) {
  const h = hits(p);
  if (h.length) {
    failures++;
    console.log(`FALSE POSITIVE (served path)   ${p}  <- ${h.join(' | ')}`);
  }
}
for (const p of OBSERVED_LEGIT) {
  const h = hits(p);
  if (h.length) {
    failures++;
    console.log(`FALSE POSITIVE (observed 404)  ${p}  <- ${h.join(' | ')}`);
  }
}
for (const p of PROBES)
  if (!hits(p).length) {
    failures++;
    console.log(`MISSED PROBE  ${p}`);
  }

// ---- coverage of the observed 404s ----------------------------------------------------------
const tally = (key) => {
  let total = 0,
    blocked = 0;
  const missed = new Map();
  for (const e of observed) {
    const n = e[key];
    if (!n) continue;
    total += n;
    if (hits(e.path).length) blocked += n;
    else missed.set(e.path, n);
  }
  return { total, blocked, missed };
};
for (const [label, key] of [
  ['AS396982 scanner', 'scanner_as396982'],
  ['all callers', 'requests'],
]) {
  const { total, blocked, missed } = tally(key);
  const pct = total ? ((100 * blocked) / total).toFixed(1) : '0';
  console.log(
    `coverage ${label}: ${blocked}/${total} logged 404s blocked (${pct}%), ${missed.size} paths not matched`,
  );
  if (process.env.SHOW_MISSED === key)
    for (const [p, n] of [...missed].sort((a, b) => b[1] - a[1]))
      console.log(`  ${String(n).padStart(5)} ${p}`);
}

console.log(
  `legit=${LEGIT.length} observed-legit=${OBSERVED_LEGIT.length} probes=${PROBES.length} slugs=${slugs.length} failures=${failures}`,
);
process.exit(failures ? 1 : 0);

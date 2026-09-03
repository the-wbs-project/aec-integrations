#!/usr/bin/env node
//
// verify.mjs — the scraper-rule probe from docs/waf-rate-limits.md §4 check 3, run
// across every host the rules are meant to cover.
//
// STRICTLY READ-ONLY and side-effect-free: four hosts x two user agents = eight GETs
// of /products. It writes nothing, submits nothing, and sends no email. This is the
// check that produced the table in AECI-659, so a before/after pair is directly
// comparable.
//
// Expected AFTER apply.mjs: scraperUA -> 403 (Managed Challenge), browserUA -> 200,
// on all four hosts. Before it, www. and prod. both read 200/200 — the bug.
//
// The RATE-LIMIT rules are deliberately NOT probed here. Tripping one blocks the
// calling IP from those endpoints for an hour, and on production the endpoints send
// real email. Verify those by hand, on staging, per README.md → Verifying the rate
// limit.
//
// staging. sits behind Cloudflare Access (docs/access.md), so set
// CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET or it is skipped.
//
// USAGE (no Cloudflare API token needed — these are ordinary public requests):
//   node scripts/ops/2026-09-waf-host-scope/verify.mjs
//   node scripts/ops/2026-09-waf-host-scope/verify.mjs --path /vendors
//
// Exits 0 when every probed host challenges the scraper UA and serves the browser UA,
// 1 when any host does not, 2 on a usage error.

import { NEW_HOSTS, UsageError } from './rules.mjs';

const SCRAPER_UA = 'python-requests/2.31';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Cloudflare serves the Managed Challenge interstitial as 403.
const CHALLENGED = 403;

function parseArgs(argv) {
  const args = { path: '/products' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--path') {
      args.path = argv[i + 1];
      if (!args.path) throw new UsageError('--path needs a value');
      i += 1;
    } else {
      throw new UsageError(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

const accessHeaders = () => {
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  return id && secret ? { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret } : null;
};

async function probe(host, path, userAgent, headers) {
  try {
    const res = await fetch(`https://${host}${path}`, {
      headers: { 'User-Agent': userAgent, ...headers },
      redirect: 'manual',
    });
    // The body is never read here, so release it — an unconsumed response body holds a
    // connection open (CLAUDE.md, AECI-666). Node's fetch needs an explicit cancel.
    await res.body?.cancel();
    return String(res.status);
  } catch (err) {
    return `ERR ${err.cause?.code ?? err.message}`;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const access = accessHeaders();

  console.log(`GET ${args.path} — scraper UA "${SCRAPER_UA}" vs a real browser UA\n`);
  console.log('HOST                                scraperUA  browserUA  verdict');

  let failures = 0;
  for (const host of NEW_HOSTS) {
    const needsAccess = host.startsWith('staging.');
    if (needsAccess && !access) {
      console.log(
        `${host.padEnd(35)} ${'—'.padEnd(10)} ${'—'.padEnd(10)} skipped (set CF_ACCESS_CLIENT_ID/SECRET)`,
      );
      continue;
    }
    const headers = needsAccess ? access : {};
    const scraper = await probe(host, args.path, SCRAPER_UA, headers);
    const browser = await probe(host, args.path, BROWSER_UA, headers);
    const ok = scraper === String(CHALLENGED) && browser === '200';
    if (!ok) failures += 1;
    const verdict = ok
      ? 'ok — challenged'
      : scraper === '200'
        ? 'NOT COVERED — scraper UA served normally'
        : 'unexpected';
    console.log(`${host.padEnd(35)} ${scraper.padEnd(10)} ${browser.padEnd(10)} ${verdict}`);
  }

  if (failures > 0) {
    console.error(
      `\n${failures} host(s) not behaving as expected. Confirm attribution in Security → Events.`,
    );
    process.exit(1);
  }
  console.log('\nAll probed hosts challenge the scraper UA and serve the browser UA.');
  process.exit(0);
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`verify.mjs: ${err.message}`);
    process.exit(2);
  }
  console.error(err.stack ?? String(err));
  process.exit(2);
});

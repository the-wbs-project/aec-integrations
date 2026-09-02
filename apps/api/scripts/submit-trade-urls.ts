/**
 * submit-trade-urls.ts — announce published `/trades/:slug` pages to IndexNow and
 * IndexNow, outside a promote.
 *
 * WHY THIS EXISTS. The indexing pings normally ride the post-commit promote hooks
 * (`src/routes/promote.ts` → `callIndexNow`), so a URL only
 * gets announced when a promote touches it. Retuning
 * `TRADE_PUBLISH_MIN_PRODUCTS` (`@aeci/shared`, `TRADES_VOCABULARY.md` §6) changes
 * which trade pages are indexable **with no promote behind it** — terms cross the
 * floor because the floor moved, not because the catalog did. Nothing then tells
 * an indexing service the pages exist. That is what this script is for. It is the
 * Node shell around the tested transports (`src/lib/indexnow.ts`,
 * `src/lib/indexnow.ts`): it supplies argv, discovery, credentials, and
 * `console`. Same shape as `retract-product.ts` / `backfill-metrics-daily.ts`.
 *
 * HOW IT PICKS URLS — it reads indexability off the deployed site rather than
 * recomputing the floor:
 *   1. `GET {site}/api/taxonomy` → every trade with `product_count > 0`.
 *      (The API is deliberately ungated, so this sees all 34 terms with real
 *      counts; the zero-count ones can never be indexable and are dropped here.)
 *   2. For each candidate, `GET {site}/trades/{slug}` and keep it only if the page
 *      returns 200 **and** carries no `<meta name="robots" content="noindex">`.
 *   3. Submit that set plus the `/trades` index.
 *
 * Step 2 is the point. Deriving the set from `TRADE_PUBLISH_MIN_PRODUCTS` in this
 * process would announce what the floor says *locally*, which is not necessarily
 * what the deployed site serves — a stale deploy or an unpurged edge cache would
 * make the script confidently ping `noindex` pages. Submitting a `noindex` URL to
 * an indexing service is precisely the correctness bug that
 * `src/routes/promote-trade-publication.ts` exists to prevent, so this asks the
 * site instead of trusting a constant. It also means the script cannot drift when
 * the floor is retuned again, and it doubles as proof the deploy and the cache
 * purge actually landed before anything is announced.
 *
 * Re-runnable. It submits every currently-indexable trade page, not a hand-kept
 * "newly published" list: IndexNow is idempotent and unmetered at this size
 * (≤ 35 URLs). Nothing is tracked between runs.
 *
 * USAGE (from anywhere; run via pnpm):
 *   # dry-run — discover and report, submit nothing (needs no credentials):
 *   pnpm --filter @aeci/api ops:submit-trade-urls -- --env production
 *   # submit (production requires the extra guard flag):
 *   INDEXNOW_KEY=… pnpm --filter @aeci/api ops:submit-trade-urls -- \
 *     --env production --apply --allow-production
 *   # against an arbitrary origin (PR preview, local dev):
 *   pnpm --filter @aeci/api ops:submit-trade-urls -- --site http://localhost:8788
 *
 * Credentials (read from the ambient environment; this script does NOT auto-load
 * .dev.vars). `--apply` only:
 *   - INDEXNOW_KEY                      required
 * All three live only as GitHub Actions secrets and Wrangler Worker secrets, both
 * of which are write-only stores — `wrangler secret list` returns names, not
 *
 * SAFETY:
 *   - Dry-run by default; `--apply` performs the outbound submissions.
 *   - Refuses `production` submissions without `--allow-production`.
 *   - Refuses to submit if the `{key}.txt` verification file does not resolve on
 *     the target origin — IndexNow would reject the batch anyway, and a 404 there
 *     means the web Worker's INDEXNOW_KEY is missing or does not match the API's.
 *   - Read-only against our own systems: no D1, no Algolia, no cache purge. The
 *     only writes are the outbound pings, and they are gated behind --apply.
 *   - Emits NO `audit_log` row: nothing about domain state changes (ADR 0022).
 *
 * Exit codes: 0 clean · 1 submission failure or refusal · 2 usage / credentials.
 */

import { callIndexNow } from '../src/lib/indexnow';

// ─── Args + target resolution ────────────────────────────────────────────────

/** Public origin per deployed env — mirrors `PUBLIC_SITE_URL` in wrangler.jsonc. */
const SITE_BY_ENV = {
  staging: 'https://staging.aecintegrations.com',
  demo: 'https://demo.aecintegrations.com',
  production: 'https://www.aecintegrations.com',
} as const;

type SiteEnv = keyof typeof SITE_BY_ENV;

const USAGE = `usage: ops:submit-trade-urls (--env <staging|demo|production> | --site <origin>)
                            [--apply] [--allow-production]

  --env <name>         Target a deployed env by its PUBLIC_SITE_URL.
  --site <origin>      Target an arbitrary origin (PR preview, localhost).
  --apply              Actually submit. Without it, discover and report only.
  --allow-production    Required alongside --apply when the target is production.`;

function readValueFlag(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

interface Target {
  /** Origin with any trailing slash stripped, e.g. `https://www.aecintegrations.com`. */
  site: string;
  /** Bare hostname for the IndexNow `host` field — a full URL there is a common 422. */
  host: string;
  label: string;
  isProduction: boolean;
}

function resolveTarget(argv: string[]): Target {
  const site = readValueFlag(argv, '--site');
  const env = readValueFlag(argv, '--env');
  if (site && env) throw new Error('Pass exactly one of --site or --env, not both.');

  let raw: string;
  let label: string;
  if (site) {
    raw = site;
    label = site;
  } else {
    if (!env || !(env in SITE_BY_ENV)) {
      throw new Error(
        `Set --env ${Object.keys(SITE_BY_ENV).join('|')} (or --site <origin>). Got: ${env ?? '(unset)'}.`,
      );
    }
    raw = SITE_BY_ENV[env as SiteEnv];
    label = env;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--site must be an absolute origin (e.g. https://example.com). Got: ${raw}`);
  }
  return {
    site: raw.replace(/\/+$/, ''),
    host: url.host,
    label,
    isProduction: env === 'production' || url.host === new URL(SITE_BY_ENV.production).host,
  };
}

// ─── Discovery ───────────────────────────────────────────────────────────────

interface TaxonomyTerm {
  slug: string;
  product_count: number;
}

async function fetchTrades(site: string): Promise<TaxonomyTerm[]> {
  const url = `${site}/api/taxonomy`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`GET ${url} returned ${res.status} ${res.statusText}. Is the site reachable?`);
  }
  const body = (await res.json()) as { trades?: TaxonomyTerm[] };
  if (!Array.isArray(body.trades)) {
    throw new Error(`GET ${url} returned no \`trades\` array. Got keys: ${Object.keys(body)}`);
  }
  return body.trades;
}

/**
 * True when the HTML carries a robots directive containing `noindex`. Tolerant of
 * attribute order and quoting: Angular's `MetaService.setEntityMeta({ noindex })`
 * emits `<meta name="robots" content="noindex">`, but the check should not be
 * brittle about how the serializer happens to spell it.
 */
export function hasNoindex(html: string): boolean {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  return metaTags.some(
    (tag) =>
      /\bname\s*=\s*["']robots["']/i.test(tag) &&
      /\bcontent\s*=\s*["'][^"']*\bnoindex\b/i.test(tag),
  );
}

type Verdict = 'indexable' | 'noindex' | `http_${number}` | 'unreachable';

interface Candidate {
  slug: string;
  productCount: number;
  url: string;
  verdict: Verdict;
}

async function classify(site: string, term: TaxonomyTerm): Promise<Candidate> {
  const url = `${site}/trades/${term.slug}`;
  const base = { slug: term.slug, productCount: term.product_count, url };
  try {
    const res = await fetch(url, { headers: { accept: 'text/html' } });
    if (!res.ok) return { ...base, verdict: `http_${res.status}` };
    return { ...base, verdict: hasNoindex(await res.text()) ? 'noindex' : 'indexable' };
  } catch {
    return { ...base, verdict: 'unreachable' };
  }
}

// ─── Verification file ───────────────────────────────────────────────────────

async function assertKeyFileResolves(site: string, key: string): Promise<void> {
  const url = `${site}/${key}.txt`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (error) {
    throw new Error(`Could not reach the IndexNow verification file at ${url}.`, { cause: error });
  }
  if (!res.ok) {
    throw new Error(
      `IndexNow verification file ${url} returned ${res.status}. The web Worker's ` +
        `INDEXNOW_KEY is unset or does not match the key being submitted — IndexNow ` +
        `would reject the batch. Fix the secret before submitting.`,
    );
  }
  const body = (await res.text()).trim();
  if (body !== key) {
    throw new Error(
      `IndexNow verification file ${url} does not contain the submitted key. The web ` +
        `and API Workers have different INDEXNOW_KEY values; they must match byte for byte.`,
    );
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }

  const target = resolveTarget(argv);
  const apply = argv.includes('--apply');

  if (apply && target.isProduction && !argv.includes('--allow-production')) {
    console.error('REFUSING: production submissions need --allow-production.');
    return 1;
  }

  console.log(`Target: ${target.label} (${target.site})`);
  console.log(apply ? 'Mode:   APPLY — will submit\n' : 'Mode:   DRY-RUN — will submit nothing\n');

  const trades = await fetchTrades(target.site);
  const tagged = trades
    .filter((t) => t.product_count > 0)
    .sort((a, b) => b.product_count - a.product_count || a.slug.localeCompare(b.slug));

  console.log(
    `Taxonomy: ${trades.length} trade terms, ${tagged.length} carrying at least one product.`,
  );
  if (tagged.length === 0) {
    console.log('Nothing to announce.');
    return 0;
  }

  console.log('Checking each page as the crawler would see it...\n');
  const checked = await Promise.all(tagged.map((t) => classify(target.site, t)));

  const pad = Math.max(...checked.map((c) => c.slug.length));
  for (const c of checked) {
    const mark = c.verdict === 'indexable' ? '✓' : '·';
    console.log(
      `  ${mark} ${c.slug.padEnd(pad)}  ${String(c.productCount).padStart(3)}  ${c.verdict}`,
    );
  }

  const indexable = checked.filter((c) => c.verdict === 'indexable');
  const broken = checked.filter(
    (c) => c.verdict === 'unreachable' || c.verdict.startsWith('http_'),
  );
  if (broken.length > 0) {
    console.log(
      `\nWARNING: ${broken.length} page(s) did not return 200 and were skipped: ` +
        broken.map((c) => c.slug).join(', '),
    );
  }

  if (indexable.length === 0) {
    console.log(
      '\nNo indexable trade page found. If the floor was just lowered, the deploy or the ' +
        'edge cache purge has not landed yet — purge `index:trades`, `taxonomy`, and ' +
        '`sitemap`, then re-run.',
    );
    return 1;
  }

  const urlList = [...indexable.map((c) => c.url), `${target.site}/trades`];
  console.log(`\n${urlList.length} URL(s) to submit:`);
  for (const u of urlList) console.log(`  ${u}`);

  if (!apply) {
    console.log('\nDRY-RUN complete. Nothing was submitted.');
    console.log(
      `Re-run to submit:  pnpm --filter @aeci/api ops:submit-trade-urls -- ` +
        `${target.label === target.site ? `--site ${target.site}` : `--env ${target.label}`} --apply` +
        `${target.isProduction ? ' --allow-production' : ''}`,
    );
    return 0;
  }

  // ── IndexNow ──
  const key = process.env['INDEXNOW_KEY'];
  if (!key) {
    console.error(
      '\nMissing INDEXNOW_KEY. It is a Wrangler + GitHub Actions secret (write-only in ' +
        'both stores), so it has to be supplied out of band:\n' +
        '  INDEXNOW_KEY=… pnpm --filter @aeci/api ops:submit-trade-urls -- …',
    );
    return 2;
  }
  await assertKeyFileResolves(target.site, key);

  let failed = false;
  const indexNow = await callIndexNow(fetch, {
    host: target.host,
    key,
    keyLocation: `${target.site}/${key}.txt`,
    urlList,
  });
  if (indexNow.ok) {
    console.log(`\nIndexNow: OK (${indexNow.status}) — ${urlList.length} URL(s) submitted.`);
  } else {
    console.error(`\nIndexNow: FAILED (${indexNow.status}) — ${indexNow.message}`);
    failed = true;
  }

  console.log(
    '\nNOT done by this script: cache purge (`index:trades`, `taxonomy`, `sitemap`) and ' +
      'any Search Console follow-up. Indexing services queue submissions — expect hours ' +
      'to days before the pages appear.',
  );
  return failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    // Network failures arrive wrapped; the cause carries the actual reason.
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause) console.error(`  cause: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(2);
  });

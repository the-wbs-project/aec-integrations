/**
 * What the two retraction CLIs (`scripts/retract-product.ts`, `scripts/retract-vendor.ts`)
 * do after the D1 delete, and what they print for the operator (AECI-1945).
 *
 * **The sitemap.** A retraction removes `/products/:slug` or `/vendors/:slug` from
 * `sitemap.xml`. In the Worker, every such writer calls `markSitemapDirty`
 * (`sitemap-store.ts`), and the `sitemap-rebuild` cron rebuilds within 15 minutes. The
 * CLIs run in Node with no `TAXONOMY_KV` binding, so they cannot call that helper. They
 * write the same key with the same value, an ISO timestamp, through
 * `wrangler kv key put`. That is the command `docs/runbooks/alerts.md` "Sitemap is stale"
 * gives for a forced rebuild. If the put fails, the CLI prints that command as the first
 * follow-up. The daily 05:00 backstop still marks dirty, so a failed put costs at most a
 * day. A dry run writes nothing.
 *
 * **The follow-ups.** The rest of a retraction is not the CLI's to do: the edge purge
 * needs `ADMIN_PURGE_TOKEN` on the SSR Worker, the reconcilers are their own CLIs, and
 * the review app is upstream. The CLI prints them as one numbered list, in run order, so
 * none of them is left to memory. Order and wording: `docs/runbooks/catalog.md`
 * "Retracting a product or vendor by hand".
 *
 * Pure: no I/O. The CLIs own `spawnSync` and `console`.
 */
import { SITEMAP_DIRTY_KEY } from './sitemap-store';

/** The slice of a CLI's resolved D1 target these helpers read. */
export interface RetractCliTarget {
  /** `local`, `staging`, `demo` or `production`. */
  label: string;
  /** The wrangler target flags: `['--local']` or `['--env', <env>, '--remote']`. They
   *  select the same tier for `wrangler kv` as for `wrangler d1`. */
  flags: readonly string[];
  remote: boolean;
}

/** Argv for `wrangler` that marks the sitemap dirty on the target's tier. Run from
 *  `apps/api`, so `--binding TAXONOMY_KV --env <env>` resolves through its wrangler.jsonc. */
export function sitemapDirtyWranglerArgs(target: RetractCliTarget, now: string): string[] {
  return ['kv', 'key', 'put', SITEMAP_DIRTY_KEY, now, '--binding', 'TAXONOMY_KV', ...target.flags];
}

/** The same write as {@link sitemapDirtyWranglerArgs}, as a command an operator pastes. */
export function sitemapDirtyManualCommand(target: RetractCliTarget): string {
  return (
    `pnpm exec wrangler kv key put ${SITEMAP_DIRTY_KEY} "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" ` +
    `--binding TAXONOMY_KV ${target.flags.join(' ')}`
  );
}

export interface FollowUpOptions {
  target: RetractCliTarget;
  /** The Cache-Tags the retraction touched. */
  tags: readonly string[];
  /** `--skip-cache` was passed. */
  cacheSkipped: boolean;
  /** The CLI's own `sitemap:dirty` put succeeded. */
  sitemapMarked: boolean;
}

function sitemapStep(o: FollowUpOptions): string[] {
  if (o.sitemapMarked) return [];
  return [
    `Mark the sitemap dirty. The CLI's own write failed. From apps/api:\n` +
      `     ${sitemapDirtyManualCommand(o.target)}`,
  ];
}

function cacheStep(o: FollowUpOptions, everyTier: boolean): string[] {
  if (o.cacheSkipped || o.tags.length === 0) return [];
  return [
    'Purge the edge cache. POST to the SSR Worker, auth ADMIN_PURGE_TOKEN:\n' +
      `     POST /admin/purge  {"tags": ${JSON.stringify(o.tags)}}` +
      (everyTier
        ? '\n     Staging, demo and production are cached. Run it on each tier you touched.'
        : ''),
  ];
}

/** Both reconcilers target local, staging and production only. Demo has no step. */
function reconcilerReaches(target: RetractCliTarget): boolean {
  return !target.remote || target.label === 'staging' || target.label === 'production';
}

function algoliaStep(o: FollowUpOptions): string[] {
  if (!reconcilerReaches(o.target)) return [];
  const where = o.target.remote ? `--env ${o.target.label}` : '--local';
  const guard = o.target.label === 'production' ? ' --allow-production' : '';
  return [
    'Measure Algolia drift. It reports any orphan the de-index missed:\n' +
      `     pnpm --filter @aeci/api db:reconcile-algolia-drift -- ${where}\n` +
      `     Re-run with --apply${guard} only if it reports orphans.`,
  ];
}

function countsStep(o: FollowUpOptions): string[] {
  if (!reconcilerReaches(o.target)) return [];
  const { label, remote } = o.target;
  const cmd = remote
    ? `RECONCILE_ENV=${label} pnpm --filter @aeci/api db:reconcile-counts`
    : 'pnpm --filter @aeci/api db:reconcile-counts -- --local';
  const guard = label === 'production' ? ' --allow-production' : '';
  return [
    'Check the product counts the delete repaired:\n' +
      `     ${cmd}\n` +
      `     Re-run with -- --fix${guard} only if it reports drift.`,
  ];
}

/** Remaining follow-ups after `retract-product --apply`, in run order. */
export function productRetractFollowUps(o: FollowUpOptions): string[] {
  const steps = [...sitemapStep(o), ...cacheStep(o, false), ...algoliaStep(o), ...countsStep(o)];
  if (o.target.label === 'production') {
    steps.push(
      'Upstream: delete the product in the review app (delete_product). That opens a retraction\n' +
        '     journal entry for a row that is already gone. Read back the 404 here, then call\n' +
        '     confirm_retractions on that entry, or the next strand audit goes red.',
    );
  }
  return steps;
}

/** Remaining follow-ups after `retract-vendor --apply`, in run order. A retractable vendor
 *  owns no product, so no product count changes and there is no counts step. */
export function vendorRetractFollowUps(o: FollowUpOptions): string[] {
  const steps = [...sitemapStep(o), ...cacheStep(o, true), ...algoliaStep(o)];
  if (o.target.label === 'production') {
    steps.push(
      "Upstream: clear each review-app record's supabase_vendor_id, then delete the record.",
    );
  }
  return steps;
}

/** The numbered block both CLIs print last. */
export function formatFollowUps(steps: readonly string[]): string {
  if (steps.length === 0) return 'Nothing left to do.';
  return ['Remaining follow-ups, in run order:', ...steps.map((s, i) => `  ${i + 1}. ${s}`)].join(
    '\n',
  );
}

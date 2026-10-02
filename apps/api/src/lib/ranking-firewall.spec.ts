/**
 * The ranking firewall for the operator-only activity tables (epic AECI-1207, PLAN
 * §5; `STAGE_2_PAID_TIERS_SPEC.md`: no pay-for-placement).
 *
 * `user_activity_daily` (AECI-1208), `vendor_activity_daily` (AECI-1210) and
 * `notification_sends` (AECI-1202) say who used the product and what we emailed
 * them. None of that may ever reach a ranking, a search record, the home stats or
 * a public listing. A vendor who logs in more must never rank higher.
 *
 * This is an INVARIANT test, asserted over module SOURCE: behaviour cannot see a
 * read that does not exist yet, and a source scan can. It fails if any module on
 * those paths, in `apps/api/src` or `packages/shared/src`, names one of the tables
 * by its SQL name or its Drizzle identifier. Same idea as the `banned_at` writer
 * scan (`routes/banned-at-writers.spec.ts`).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Vitest runs with cwd = apps/api. */
const API_SRC = join(process.cwd(), 'src');
const SHARED_SRC = join(process.cwd(), '..', '..', 'packages', 'shared', 'src');

/**
 * The firewalled paths, matched against the path relative to each `src/`: search
 * and Algolia sync, ranking and sort keys, the denormalized counters, home stats,
 * listing tiers, and the public catalog read routes.
 */
const FIREWALLED =
  /algolia|home-stats|search|rank|listing|sort|(^|\/)stats\.ts$|product-facets|taxonomy|recompute-counts|^routes\/(products|vendors|integrations)\.ts$/;

/** The operator-only tables, by SQL name and by Drizzle identifier. */
const FORBIDDEN = [
  'user_activity_daily',
  'userActivityDaily',
  'vendor_activity_daily',
  'vendorActivityDaily',
  'notification_sends',
  'notificationSends',
];

function sourceFiles(root: string, dir = root, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'node_modules') continue;
      sourceFiles(root, full, acc);
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;
    acc.push(full.slice(root.length + 1).replaceAll('\\', '/'));
  }
  return acc;
}

function firewalled(root: string): Array<{ rel: string; full: string }> {
  return sourceFiles(root)
    .filter((rel) => FIREWALLED.test(rel))
    .map((rel) => ({ rel, full: join(root, rel) }));
}

describe('ranking firewall: operator-only activity tables', () => {
  const api = firewalled(API_SRC);
  const shared = firewalled(SHARED_SRC);

  it('scans the modules it means to (the scan is not vacuous)', () => {
    const rels = api.map((f) => f.rel);
    for (const must of [
      'lib/algolia-sync.ts',
      'lib/algolia-transforms.ts',
      'lib/home-stats.ts',
      'lib/sort.ts',
      'lib/recompute-counts.ts',
      'routes/products.ts',
      'routes/vendors.ts',
      'routes/stats.ts',
    ]) {
      expect(rels).toContain(must);
    }
    expect(shared.map((f) => f.rel)).toEqual(
      expect.arrayContaining(['algolia-records.ts', 'listing-tier.ts']),
    );
  });

  it('no search, ranking, home-stats or listing module names an activity table', () => {
    const offenders = [...api, ...shared].flatMap(({ rel, full }) => {
      const src = readFileSync(full, 'utf8');
      return FORBIDDEN.filter((name) => src.includes(name)).map((name) => `${rel}: ${name}`);
    });
    expect(offenders).toEqual([]);
  });
});

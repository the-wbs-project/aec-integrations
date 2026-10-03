import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * AECI-1181 — a vendor's reply to a review never moves ranking
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.10, extending `STAGE_2_PAID_TIERS_SPEC.md`
 * §3.2). The shared half is block 6 of `packages/shared/src/entitlements.spec.ts`,
 * which checks the Algolia settings, record shapes, public sort keys and the
 * `listing_tier` inputs as DATA. This is the source half: a reply could still
 * reach a ranking input through a JOIN or an import that the data never names.
 *
 * So every file that computes a ranking input is scanned for the reply table,
 * its Drizzle handle, its module and the public `vendor_responses` field. A
 * single match fails the build. Comments are stripped first, so a note that
 * says "replies never rank" does not trip it.
 */

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** Paths relative to `apps/api`, the vitest cwd. */
const read = (rel: string) => strip(readFileSync(join(process.cwd(), rel), 'utf8'));

/**
 * Every reply-shaped name: the table (`review_responses`), its Drizzle handle
 * (`reviewResponses`), its module (`review-responses`), the public wire field
 * (`vendor_responses` / `vendorResponses`) and any name built on `reply` or
 * `replies` (`reply_count`, `hasReply`).
 */
const REPLY_NAME = /review[-_]?responses?|vendor[-_]?responses?|repl(?:y|ies)/i;

/**
 * The files that decide ranking or order. A new ranking input belongs here; a
 * renamed one fails the existence check below rather than silently dropping out.
 */
const RANKING_INPUT_FILES = [
  // D1 orderBy for every public list (`?sort=`).
  'src/lib/sort.ts',
  // Product counts and rating averages, which feed the `rating` and `reviews` sorts.
  'src/lib/recompute-counts.ts',
  // The Algolia record builders, the sync and the nightly drift reconcile.
  'src/lib/algolia-transforms.ts',
  'src/lib/algolia-sync.ts',
  'src/lib/algolia-drift.ts',
  'src/lib/algolia-drift-deps.ts',
  'scripts/reconcile-algolia-drift.ts',
  // The shared Algolia settings (`customRanking`, searchable, facets), record
  // schemas and the `listing_tier` computation.
  '../../packages/shared/src/algolia.ts',
  '../../packages/shared/src/algolia-records.ts',
  '../../packages/shared/src/listing-tier.ts',
  // The datatool full reindex, the second Algolia record builder.
  '../datatool/src/algolia-reindex.ts',
] as const;

/** Public read paths whose `orderBy` must stay reply-free. */
const PUBLIC_ORDER_FILES = [
  'src/routes/products.ts',
  'src/routes/product-reviews.ts',
  'src/routes/vendors.ts',
] as const;

describe('a reply never reaches a ranking input (§11c.10) [invariant]', () => {
  it.each(RANKING_INPUT_FILES)('%s names no reply table, field or module', (rel) => {
    const src = read(rel);
    expect(src.length, `${rel} is empty or missing`).toBeGreaterThan(200);
    const match = src.match(REPLY_NAME);
    expect(match?.[0] ?? null, `${rel} reads reply data`).toBeNull();
  });

  it('no public list or review orderBy names a reply', () => {
    for (const rel of PUBLIC_ORDER_FILES) {
      const orderLines = read(rel)
        .split('\n')
        .filter((line) => /orderBy/.test(line));
      expect(orderLines.length, `${rel} has no orderBy to check`).toBeGreaterThan(0);
      for (const line of orderLines) {
        expect(line, `${rel}: ${line.trim()}`).not.toMatch(REPLY_NAME);
      }
    }
  });

  it('keeps reviews in created_at DESC, id ASC, reply or not', () => {
    // §11c.10 bullet 4: the order of reviews on the page is untouched by replies.
    // Both public review paths (the paginated list and the 24-review embed).
    for (const rel of ['src/routes/product-reviews.ts', 'src/routes/products.ts']) {
      expect(read(rel), rel).toContain('orderBy: [desc(reviews.createdAt), asc(reviews.id)]');
    }
  });

  it('is not a vacuous scan: the pattern finds the reply where it does live', () => {
    // The public read joins replies in, so the same pattern must see them there.
    expect(read('src/lib/review-responses.ts')).toMatch(REPLY_NAME);
    expect(read('src/routes/products.ts')).toMatch(REPLY_NAME);
    for (const name of [
      'review_responses',
      'reviewResponses',
      'review-responses',
      'vendor_responses',
      'vendorResponses',
      'reply',
      'replies',
      'reply_count',
      'hasReply',
    ]) {
      expect(name).toMatch(REPLY_NAME);
    }
    // And it does not fire on the words ranking code legitimately uses.
    for (const name of [
      'review_count',
      'reviewCount',
      'reviews',
      'responsive',
      'replace',
      'repeat',
    ]) {
      expect(name).not.toMatch(REPLY_NAME);
    }
  });
});

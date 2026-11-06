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

/**
 * AECI-1613 — a reviewer's update to a published review reaches ranking ONLY
 * through the averages in `recompute-counts.ts` (`STAGE_1_SPEC.md` §4.7a). The
 * latest approved update that carries ratings is that review's rating in
 * `rating_*_avg`, which the `rating` sort and Algolia read as stored values.
 * Nothing else may read `review_updates`: not `review_count`, not a sort key, not
 * an Algolia record builder, not `listing_tier`, not any vendor or plan input.
 */
const UPDATE_NAME = /review[-_]?updates?/i;

describe('a reviewer update reaches ranking only through the averages (AECI-1613) [invariant]', () => {
  it.each(RANKING_INPUT_FILES.filter((rel) => rel !== 'src/lib/recompute-counts.ts'))(
    '%s names no review-update table or module',
    (rel) => {
      const match = read(rel).match(UPDATE_NAME);
      expect(match?.[0] ?? null, `${rel} reads review updates`).toBeNull();
    },
  );

  it('recompute-counts.ts reads review_updates only inside effectiveRatingSql', () => {
    const src = read('src/lib/recompute-counts.ts');
    const start = src.indexOf('function effectiveRatingSql');
    expect(start, 'effectiveRatingSql is missing').toBeGreaterThan(0);
    const end = src.indexOf('\n}\n', start);
    const outside = (src.slice(0, start) + src.slice(end))
      // The import of the Drizzle handle is the one other mention allowed.
      .replace(/import \{[^}]*\} from '\.\.\/db\/schema';/, '');
    expect(outside.match(UPDATE_NAME)?.[0] ?? null).toBeNull();
  });

  it('review_count never reads the effective rating or an update', () => {
    const src = read('src/lib/recompute-counts.ts');
    const countLine = src.split('\n').find((line) => /reviewCount: sql/.test(line));
    expect(countLine, 'the set-based review_count expression is missing').toBeDefined();
    expect(countLine).not.toMatch(/effectiveRatingSql|review[-_]?updates?/i);
  });

  it('only the two averages call effectiveRatingSql', () => {
    const src = read('src/lib/recompute-counts.ts');
    const callers = src
      .split('\n')
      .filter((line) => /effectiveRatingSql\(|roundedApprovedAvgSql\(/.test(line))
      .filter((line) => !/function (effectiveRatingSql|roundedApprovedAvgSql)/.test(line))
      .map((line) => line.trim());
    for (const line of callers) {
      expect(line).toMatch(/overall|onboarding|AVG\(/i);
    }
  });

  it('is not a vacuous scan: the pattern finds updates where they do live', () => {
    expect(read('src/lib/review-updates.ts')).toMatch(UPDATE_NAME);
    expect(read('src/lib/recompute-counts.ts')).toMatch(UPDATE_NAME);
    for (const name of ['review_updates', 'reviewUpdates', 'review-updates', 'reviewUpdate']) {
      expect(name).toMatch(UPDATE_NAME);
    }
    for (const name of ['updated_at', 'updatedAt', 'review_count', 'reviews']) {
      expect(name).not.toMatch(UPDATE_NAME);
    }
  });
});

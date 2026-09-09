/**
 * Denormalized Algolia record shapes (AECI-137 / Phase 3.2).
 *
 * The Zod schemas + inferred types for the three search indexes, per
 * `STAGE_1_SPEC.md` §7.1. Every record is "zero-join" — all display + facet +
 * ranking fields are flattened onto the record so a search hit renders a card
 * without a follow-up fetch (these feed the `/search` hit cards, 3.9).
 *
 * Nullability and field-level validation mirror the API contracts in `./api/*`
 * (`logo_url` is a nullable URL, counts are non-negative ints, `mechanism_kind`
 * / `direction` reuse the integration enums) so the index stays in lockstep with
 * what the API already surfaces — the transform
 * (`apps/api/src/lib/algolia-transforms.ts`) reuses the same coerced DB values.
 *
 * This module is kept SEPARATE from `./algolia` (index naming + settings) on
 * purpose: it imports `zod`, and `./algolia` must stay dependency-free so the
 * operator/CI `.mjs` scripts can type-strip it. Exposed via the `./algolia-records`
 * package export; not re-exported from the barrel (mirrors `./algolia`).
 *
 * Spec: `STAGE_1_SPEC.md` §7.1 (record shapes). Settings/ranking: `./algolia`.
 */

import { z } from 'zod';

import { IntegrationDirectionSchema, IntegrationMechanismKindSchema } from './api/integrations';

/**
 * `products` index record (§7.1). `objectID` is the Supabase product UUID.
 * `vendor_name` / `vendor_slug` denormalize the product's primary vendor and are
 * nullable because a product may carry no vendor link (AECI-115, mirrors
 * `ProductListItem.vendor`). `categories` / `audiences` / `phases` / `trades` are
 * arrays of taxonomy term **names** (faceted in `./algolia`).
 *
 * The two trade fields (AECI-545, `STAGE_1_SPEC.md` §5.5a) are deliberately
 * asymmetric:
 *   - `trades` — the product's trade term names. Searchable AND faceted; this is
 *     what the `/search` Trades refinement list and the card chips read.
 *   - `trade_aliases` — every alias of those trades, flattened
 *     (`taxonomy_trades.aliases`), so colloquial queries ("blacktop", "glazier",
 *     "dirt work") reach the right products. **Searchable only — never faceted,
 *     never rendered.** It is matching metadata, not a label
 *     (`SEARCH_RANKING.md` §3.1, `TRADES_VOCABULARY.md` §4).
 * Both `.default([])` so records indexed before AECI-545 still parse, reading as
 * the untagged baseline (the AECI-529 `verified` precedent). Trades are SPARSE by
 * design — most products carry zero (`TRADES_VOCABULARY.md` §1.1), so an empty
 * array is the normal case, not missing data.
 */
export const AlgoliaProductRecordSchema = z.object({
  objectID: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().nullable(),
  vendor_name: z.string().nullable(),
  vendor_slug: z.string().nullable(),
  categories: z.array(z.string()),
  audiences: z.array(z.string()),
  phases: z.array(z.string()),
  trades: z.array(z.string()).default([]),
  trade_aliases: z.array(z.string()).default([]),
  // AECI-825 — the case-folded copy of `name` the `*_products_name_asc` replica
  // ranks on. See `algoliaSortKey`. Never searchable, never faceted, never
  // rendered; it exists only so `asc()` has something to sort that case cannot
  // reorder.
  //
  // REQUIRED, unlike `trades` / `verified`, which carry `.default()` so records
  // written before they existed still parse. This one is deliberately strict: the
  // datatool's raw-SQL builder has no compile-time link to this type, and a
  // `.default('')` would let it forget the field, emit an empty key, and sort
  // every product to the top of A–Z with nothing failing. The Zod parse in
  // `apps/datatool/src/algolia-reindex.spec.ts` is the only guard against that,
  // so it has to be able to fail.
  name_sort: z.string().min(1),
  integration_count: z.number().int().min(0),
  review_count: z.number().int().min(0),
  rating_overall_avg: z.number().nullable(),
  has_api_docs: z.boolean(),
  logo_url: z.string().url().nullable(),
});

export type AlgoliaProductRecord = z.infer<typeof AlgoliaProductRecordSchema>;

/**
 * Builds the `trade_aliases` value for a product record (AECI-545).
 *
 * Lives here, next to the schema, because BOTH record builders must produce
 * byte-identical output or the nightly incremental sync and the datatool full
 * reindex would disagree on the same product: `toAlgoliaProduct`
 * (`apps/api/src/lib/algolia-transforms.ts`, Drizzle rows) and
 * `buildProductRecords` (`apps/datatool/src/algolia-reindex.ts`, raw SQL).
 *
 * `aliasGroups` is one entry per linked trade — `taxonomy_trades.aliases` is a
 * nullable JSON column, so a group may be `null`/absent/garbage and is skipped.
 * Values are deduped against each other AND against `tradeNames` (the canonical
 * name already lives in `trades`; repeating it buys no extra matching), and
 * insertion order is preserved so record output is deterministic.
 */
export function flattenTradeAliases(
  tradeNames: readonly string[],
  aliasGroups: readonly (readonly string[] | null | undefined)[],
): string[] {
  const seen = new Set(tradeNames);
  const out: string[] = [];
  for (const group of aliasGroups) {
    if (!Array.isArray(group)) continue;
    for (const alias of group) {
      if (typeof alias !== 'string' || alias.length === 0 || seen.has(alias)) continue;
      seen.add(alias);
      out.push(alias);
    }
  }
  return out;
}

/**
 * The case-folded sort key for a display name (AECI-825).
 *
 * ── WHY A SEPARATE ATTRIBUTE ────────────────────────────────────────────────────
 * Algolia documents an alphabetical sort as the **lexicographical Unicode order of
 * a string's first 50 characters**, which ranks every capital ahead of every
 * lowercase letter — the same defect SQLite's `BINARY` collation produced on the
 * D1 side, so `asc(name)` put `ADP Workforce Now` above `Access Coins Evo` and
 * `eSUB` after `Zoho`. Algolia exposes no case-insensitive collation for a sort
 * attribute, and its "some normalized characters" caveat is not specified further,
 * so precomputing the key is the only way to make the order deterministic from
 * this side rather than dependent on undocumented normalization.
 * `SEARCH_RANKING.md` §5a.
 *
 * Lives here, beside {@link flattenTradeAliases}, for the same reason that one
 * does: BOTH record builders must produce byte-identical output or the nightly
 * incremental sync (`apps/api/src/lib/algolia-transforms.ts`) and the datatool
 * full reindex (`apps/datatool/src/algolia-reindex.ts`) would disagree about
 * where the same product belongs.
 *
 * `toLowerCase()` matches D1's `COLLATE NOCASE` across the ASCII catalog. The two
 * diverge on accented capitals — `É` folds here and does not under NOCASE — which
 * is a divergence in the right direction and affects no record today.
 *
 * **Adding this field to the schema does not backfill it.** The incremental sync
 * is watermarked on `updated_at`, so existing records keep whatever they had until
 * a full reindex runs per environment.
 */
export function algoliaSortKey(name: string): string {
  return name.toLowerCase();
}

/**
 * `vendors` index record (§7.1). `objectID` is the Supabase vendor UUID.
 * `product_count` / `integration_count` are the same denormalized counts the
 * `/vendors` pages show (sourced from the `_count` aggregation in the transform,
 * so the index matches the live site).
 */
export const AlgoliaVendorRecordSchema = z.object({
  objectID: z.string().uuid(),
  company_name: z.string().min(1),
  slug: z.string().min(1),
  // AECI-529: the owning `vendors.verified` bit, denormalized so the `/search`
  // Vendors-tab card can render `aec-verified-badge`. Display-only — never a
  // searchable attribute or custom-ranking signal (no pay-for-placement).
  // `.default(false)` keeps parsing resilient to records indexed before this
  // field existed; they read as the unverified baseline.
  verified: z.boolean().default(false),
  description: z.string().nullable(),
  headquarters: z.string().nullable(),
  founded_year: z.number().int().nullable(),
  // AECI-825 — the case-folded copy of `company_name` the `*_vendors_name_asc`
  // replica ranks on. Required for the same reason as the product record's
  // `name_sort` — see the note there.
  company_name_sort: z.string().min(1),
  product_count: z.number().int().min(0),
  integration_count: z.number().int().min(0),
  logo_url: z.string().url().nullable(),
});

export type AlgoliaVendorRecord = z.infer<typeof AlgoliaVendorRecordSchema>;

/**
 * `integrations` index record (§7.1) + a derived `mechanism_rank`. `objectID` is
 * the Supabase integration UUID. Source / target products denormalize as
 * name + slug. `mechanism_rank` is the numeric weight for `mechanism_kind`
 * (`mechanismRank()` in `./algolia`) that realizes the §7.3 mechanism priority —
 * Algolia `customRanking` can only sort by a numeric attribute, so the string
 * `mechanism_kind` alone can't drive ranking.
 */
export const AlgoliaIntegrationRecordSchema = z.object({
  objectID: z.string().uuid(),
  source_product_name: z.string().min(1),
  source_product_slug: z.string().min(1),
  target_product_name: z.string().min(1),
  target_product_slug: z.string().min(1),
  mechanism_kind: IntegrationMechanismKindSchema.nullable(),
  mechanism_name: z.string().nullable(),
  direction: IntegrationDirectionSchema.nullable(),
  description: z.string().nullable(),
  mechanism_rank: z.number().int().min(0),
});

export type AlgoliaIntegrationRecord = z.infer<typeof AlgoliaIntegrationRecordSchema>;

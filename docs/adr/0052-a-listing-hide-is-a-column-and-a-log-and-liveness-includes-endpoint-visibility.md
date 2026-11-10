# ADR 0052: A listing hide is a column and a log, and liveness includes endpoint visibility

- Status: Accepted. Built as AECI-1238 PR 1 (the whole-listing hide). The single-value hide is planned in AECI-1238 PR 2.
- Date: 2026-11-09
- Issue: AECI-1238. Counsel's Q20 and Q21 answers (2026-11-04, follow-up 2026-11-05) and Chris's rulings of 2026-11-09.
- Relates to: ADR 0030 (no delete inferred from absence), ADR 0035 (integration ownership and the lossless retire), ADR 0039 (field corrections), ADR 0042 (record ownership), ADR 0044 (the review mirror); `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.6 and §11d.6, `STAGE_1_5_SPEC.md` §13.5, `docs/RUNBOOKS.md` "Removal requests"

## Context

AECi could not take a company or a product off the public site. Every row in D1 was public. The Listing Accuracy Policy draft already promises it: "When we remove a listing, we hide it". Counsel's Q20 answer says a reversible hidden state "will normally meet the practical purpose of removal". The listing must leave the site and search, and its data must stay so a restore is exact.

Three existing tools did not fit.

1. **A delete** loses the data. It also cascades through claims and attestations, so a restore could not be exact.
2. **`promotion_status`** cannot hold a hide. Promote resets it on every push.
3. **A new status value under a CHECK** on `vendors` or `products` forces a drizzle-kit table recreate. On D1 the recreate's `DROP` fires `ON DELETE CASCADE` two levels deep (`docs/migrations.md` §0).

An integration also names two products, and a connector-powered row names a third. A pair page about a hidden product would still name the listing AECi took down.

## Decision

1. **The hide is two columns on the row.** `vendors` and `products` gain `hidden_at` and `hidden_hide_id`. Both are a plain `ADD COLUMN` with no CHECK (migration `0112_listing_hides.sql`). A partial index on `(id) WHERE hidden_at IS NOT NULL` serves the hidden set. A row is **visible** when `hidden_at IS NULL`.
2. **The history is a log table.** `listing_hides` holds one row per hide, and it is never deleted. A restore stamps `restored_by`, `restored_at` and `restore_reason` on it. The row also records `kind`, the vendor reason, the internal note, `received_at` and `source_url`. It has no FK and no CHECK, on the `field_overrides` precedent. Zod owns the vocabulary in `packages/shared/src/api/listing-hides.ts`.
3. **A company hide covers every joined product** (ruled 2026-11-09). That includes a product shared with a live company. Each product gets a child `listing_hides` row, linked by `parent_id`. A product already hidden by its own hide keeps that hide and gets no child row.
4. **A restore clears only what its hide set.** A company restore re-shows only its child products. A child still joined to another hidden company is re-homed under that company's hide, never shown. A product restore refuses with `409 LISTING_HIDDEN_WITH_VENDOR` while its active hide is a child row, or while any joined company is hidden.
5. **Liveness includes endpoint visibility.** `liveIntegrationOn` and `liveEvidencedPairOn` gain a `NOT EXISTS` clause over hidden products. For an integration it checks the source, target and connector. For a pair it checks product A, product B and the connector. Every count, id set and public read that already filtered retired rows inherits the clause at once. The raw-SQL twins in `@aeci/shared/live-integration` carry the same clause.
6. **A retire guard is not a liveness test.** A write that asks only "has this been retired?" uses `notRetiredIntegrationOn`. The portal keeps working while a listing is hidden, so the owner can still edit a row that touches a hidden product.
7. **Promote never writes `hidden_*`.** A hidden record that promote updates stays hidden. A new product joined to a hidden company is skipped at plan time.
8. **A hidden builder leaves its integration live, unnamed.** A company hide hides the company's own products, so every edge between them leaves the site. A third-party builder of an edge between two visible products is not an endpoint, so the edge stays live. Every public read then drops the builder: `built_by_vendor` is `null`, and no "Maintained by" caption names it (`visibleBuilder` in `lib/drizzle-helpers.ts`). A caption that names attesting vendors leaves out a hidden one too. The pair page renders the row as it does a row with no known builder. The Algolia integration record never carried the builder, so search needs no change.
9. **The review mirror does not carry the hide.** `hidden_at` and `hidden_hide_id` are banned from the mirror (`review-mirror-fields.spec.ts`). A `REVIEW - ` follow-up covers showing the hide state to curators.

## Rejected

- **A delete or a soft-delete table.** It loses the claims and attestations, or moves them, so a restore is not exact.
- **A `promotion_status` value.** Promote resets it.
- **A CHECK-constrained status column.** It forces a recreate that cascades on D1.
- **Hiding a product by reading its company's column.** A shared product would need a join on every read. The cascade writes the product's own column instead, so every product read tests one column.

## Consequences

- Every public read of a company or product filters through `lib/listing-visibility.ts`. The raw-SQL twin is `packages/shared/src/listing-visibility.ts`, for the datatool, the agent and the scripts.
- The DDL-probed `liveIntegrationSqlIf` and `liveEvidencedPairSqlIf` take a third required flag, `hasHiddenColumn`. A tool that queries a tier before migration `0112` degrades the clause to always-true.
- Algolia membership is promoted **and** visible. The hide route syncs every changed record by id after commit, because the orphan sweep's 50-delete cap would refuse a bulk hide.
- A new data-quality check, `product_live_under_hidden_vendor` (severity `error`), backstops the promote race window.
- A hidden record keeps its data in D1. Counsel's Q20 answer notes that retained data "remains discoverable", and that hiding "does not meet an order or duty requiring deletion of the underlying data". Such an order needs a separate decision.

# ADR 0051: A claim ends on a stored date, and unclaimed listings lose vendor logos

- Status: Accepted. Built. The two open questions were decided by Chris on 2026-11-06 (see the end).
- Date: 2026-11-05
- Issue: AECI-1618. Rulings 3, 8 and 9 on AECI-1363 (counsel's Q12 and Q4 answers).
- Amends: ADR 0032 (unreferenced uploads), ADR 0042 (decision 3, and `logo_source` staying `vendor`)
- Relates to: ADR 0035, ADR 0044, `docs/STAGE_2_5_SPEC.md` §11 and §12.2, `docs/REVIEW_APP_PROMOTE_API.md` §4a, `docs/LEGAL_IMPACT_REVIEW.md`

## Context

The Vendor Terms and the Managed plan agreement promise three things. We remove the claimed label at once when a claim ends. We remove uploaded logos within 14 days. For 30 days after Managed ends, an owner seat may ask us to remove the text it wrote. The text was merged before any of it existed in code.

Three facts in the code made this more than a cron job.

1. Ownership (`owned_at`) is stored and survives seat loss (ADR 0042). So "the claim ended" had no answer anywhere.
2. A vendor logo save overwrites `logo_url`, and promote refuses owned records. The AECi logo was not stored, so there was nothing to restore.
3. Logo objects in R2 are content-addressed and can be shared by many records (ADR 0032).

## Decision

1. **The claim end is a stored date.** `vendors.claim_ended_at` is set in the same batch as the seat loss. A vendor is claimed when `owned_at IS NOT NULL AND claim_ended_at IS NULL`. A product is claimed when any joined vendor is. Ownership does not move, so promote's fence is unchanged. A suspension changes nothing. The date is set by the last-seat revoke, an account erasure, Terminate and a return to AECi. A new unbanned seat clears it, together with the hold and removed stamps. A `vendor.claim_ended` or `vendor.claim_restored` audit row rides the batch.
2. **Public pages read Unclaimed at once.** `claim_status` is on the vendor, product and pair responses. No public label says Claimed, because none existed (AECI-1264, AECI-1266). The claim-end paths purge `vendor:{slug}`, each `product:{slug}` and `index:products`, and stamp `updated_at` so the nightly Algolia sync sees the flip.
3. **The AECi logo is kept.** `vendors.sourced_logo_url` and `products.sourced_logo_url` hold it. A logo save copies `logo_url` there when `logo_source IS NULL`. Promote never writes it.
4. **Ruling 9, option (a).** An unclaimed listing keeps a small sourced logo on the page's own subject, with "Unclaimed · not affiliated with or endorsed by this vendor" beside it. Lists, cards, rows and search show the initial tile. The server returns `logo_url: null` there, in the public mappers, `lib/algolia-transforms.ts` and the datatool reindex. Portal and admin reads keep the real value. `listing_tier` reads the stored logo, so hiding one cannot move a rank.
5. **A daily job removes vendor-set logos.** `brand_asset_removal` runs at `0 16 * * *` through the queue `aeci-brand-assets-{env}`. Per company, one guarded update puts `sourced_logo_url` back into `logo_url` on every row with `logo_source = 'vendor'` and clears the source. Admin logos stay. A product another claimed vendor holds is skipped. After the commit it deletes R2 objects no stored logo references, found through the vendor's audit history as well as the current rows. Only then does it stamp `brand_assets_removed_at`, so a failed run retries. The audit rows are `vendor.brand_assets_removed` for the D1 half and `vendor.brand_assets_removal_completed` for the R2 stamp.
6. **A hold delays the job, never past the promise.** An operator hold (`brand_assets_hold_at`) is overridden from 13 days after the claim ended, not 14. The job runs once a day, so the 13-day run is the last one before the 14-day limit, whatever the hour the claim ended.
7. **Remove on objection.** The admin logo routes accept `objection: true` with `logo_url: null`. It also clears `sourced_logo_url`, so nothing restores the logo, and deletes the object when nothing else references it.
8. **The removal election.** For 30 UTC days after Managed ends, an owner seat may blank the product's description, "How teams use it" narrative and the two doc URLs, when the vendor wrote them. Tags stay as catalog data. `usefulness_source` and `maintained_by` stay, so promote cannot refill. The window is computed from the license end date, so it needs no job. `STAGE_2_5_SPEC.md` §12.2 has the rules.

## As built, against the plan

- A banned seat granted to a company that was never owned leaves it Unclaimed. The grant stamps `owned_at`, no unbanned seat holds the claim, and the same batch ends it.
- `apps/datatool/src/algolia-reindex.ts` hides unclaimed logos too, so a full reindex agrees with the nightly sync.
- The admin removals section under `/admin/vendors` has no paging. The API returns the full set, and it holds only companies with a removal pending.
- Vendors have no screenshot upload. The job covers logos only. A future screenshot feature must join it.
- An upload that was never saved has no record, so it cannot be attributed and stays in R2. It was never shown publicly.

## Consequences

- Most of the directory changes at deploy. Unclaimed listings lose list logos until a full Algolia reindex runs per environment. The backfills in `scripts/ops/2026-11-brand-asset-backfill/` set `sourced_logo_url` and `claim_ended_at` for existing rows, each with a dry run. The sourced-logo one runs first. Its README has the order and the commands.
- The cron count is twenty-five, and a new queue exists in every environment.
- `docs/CACHE_STRATEGY.md` "Logo assets" no longer holds for a removed hash. A cached `/api/logos/<hash>` can outlive its object until the Cache Rule item carries purge by URL.
- TEXT 10.5 (sooner than 14 days, at-once objection, the sourced-logo conditions) follows on the legal branch under AECI-1363. Today's "within 14 days" stays true.

## Decided 2026-11-06 (Chris)

These two were open questions in the first draft. Both are decided and built.

1. **Term pages need no new purge tag.** The first draft said category, audience, phase and trade pages carry no tag that a claim end or a removal purges. That was wrong. Each term page embeds `product:{slug}` for every product its term carries (`taxonomy-browse.resolver.ts`, `CACHE_STRATEGY.md` §3 rule 2). Every AECI-1618 path already purges `product:{slug}` for the company's products: the claim end, the claim restore, the removal job, a product-logo objection and the removal election. So those pages repaint in the same purge. Per-term tags would add nothing, and the index tags would purge far more. The term index pages show names and counts, not logos. A vendor-logo objection purges `vendor:{slug}` only, which is enough because term-page cards show the vendor's name and never its logo. The cards show no description, so the election changes nothing there. No code changed for this item.
2. **Share cards on unclaimed pages use the site default image.** A share card, a search result and structured data carry no "not affiliated" wording. So for `claim_status === 'unclaimed'`, `og:image` and `twitter:image` fall back to `DEFAULT_OG_IMAGE`, the vendor `Organization` JSON-LD drops `logo`, and the pair page's `about` nodes drop `image` for an unclaimed endpoint. One helper decides it: `shareableLogo` in `apps/web/src/app/core/meta.helpers.ts`. The product `SoftwareApplication` node never carried an image. The pair page's `og:image` was already the default. Claimed pages keep their logo.

### Left as it is

- The home page shows product logos from `stats_cache`. Those values change on the daily home-stats run, which purges `index:home`. So a removed or objected logo can stay on the home page for up to a day. That is inside 14 days, but it is not "at once" for an objection.

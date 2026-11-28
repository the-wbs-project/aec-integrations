# Catalog freshness check

Not an alert. A manual check, run once a month, that finds live products that were retired,
discontinued, renamed, merged or pivoted out of AEC. It keeps the directory from going stale
between promotes. Run it in an agent session in this repo. Nothing schedules it.

The Listing Accuracy Policy (`/legal/listing-accuracy-policy`, "What we will and will not change")
promises that we "remove listings for defunct companies or discontinued products". This check is
how we find them. It adds no new promise. The takedown itself is the existing listing hide,
`catalog.md` "Removal requests", row 3.

## When to run it

In the first week of each month. One run takes about an hour for a bucket of 50 to 100 products.
Open a Linear issue for the run before you start (step 1). The issue is the record.

## What it checks, and what it skips

The check splits live products into two lanes. Neither lane checks whether a large company still
exists.

| Lane | Which products | What you check | How often |
|---|---|---|---|
| A. Small or unknown vendors | The vendor is not public, not a subsidiary, not `201-1000` or `1001+` staff, and holds no live claim | The company and the product | Each product once every 4 months. One bucket of four each month |
| B. Large vendors | Every other unclaimed vendor with a live product | The product only. One page per vendor, its retired or end-of-life products list, not one search per product | Every month, every vendor |

Skipped on purpose:

- **Claimed vendors.** A vendor with a live claim (`vendors.owned_at` set, `claim_ended_at` null)
  maintains its own records. It is alive by definition. A claimed vendor that retires a product
  is the vendor's to report.
- **Hidden listings.** A product or company already hidden is not live.
- **Integrations.** This check is about products. A retired integration on a live product is
  reported through the correction and contest routes.

## The evidence standard

The policy sets it. A product is discontinued, or a company defunct, only when one of these says so:

- the product's own site, or its vendor's site, says it is discontinued, retired, end of life or no
  longer sold;
- the acquirer's site says the product was replaced or folded into another product;
- a public dissolution record, such as a state business registry or Companies House entry.

A dead website on its own does not meet it. Neither does a quiet blog, an old release date or a
news story with no primary source. Those make a product a **watch** (step 5).

## 1. Open the run issue

File one Linear issue on the AECi team, in the **Platform** project, assigned to Chris. Title it
`Catalog freshness check: YYYY-MM` with the year and month. Paste the results table from step 6 into
it at the end. Close it when every row is resolved or carried forward.

## 2. Pull lane A for this month

Run this from the repo root. It reads production D1 and writes nothing. The bucket comes from the
month, so January, May and September check the same quarter of the catalog. A product's bucket is
the last hex digit of its id, so it never moves.

```bash
cd apps/api && pnpm exec wrangler d1 execute aeci-app-production --env production --remote --json --command "SELECT p.slug, p.name, p.website, v.slug AS vendor_slug, v.company_name, v.website AS vendor_website, v.company_size, v.founded_year, p.integration_count, p.review_count, p.promoted_at FROM products p JOIN product_vendors pv ON pv.product_id = p.id AND pv.is_primary = 1 JOIN vendors v ON v.id = pv.vendor_id WHERE p.hidden_at IS NULL AND v.hidden_at IS NULL AND (v.owned_at IS NULL OR v.claim_ended_at IS NOT NULL) AND COALESCE(v.public_private, '') <> 'public' AND COALESCE(v.ownership_type, '') NOT IN ('public', 'subsidiary') AND COALESCE(v.company_size, '') NOT IN ('201-1000', '1001+') AND (instr('0123456789abcdef', lower(substr(p.id, -1))) - 1) % 4 = (CAST(strftime('%m', 'now') AS INTEGER) - 1) % 4 ORDER BY v.slug, p.slug" > /tmp/aeci-freshness-lane-a.json
```

Save the output under `.context/` in the workspace if you want it beside the session. It holds no
personal data, but do not commit it.

## 3. Pull lane B

```bash
cd apps/api && pnpm exec wrangler d1 execute aeci-app-production --env production --remote --json --command "SELECT v.slug AS vendor_slug, v.company_name, v.website AS vendor_website, count(*) AS live_products, group_concat(p.name, '; ') AS products FROM products p JOIN product_vendors pv ON pv.product_id = p.id AND pv.is_primary = 1 JOIN vendors v ON v.id = pv.vendor_id WHERE p.hidden_at IS NULL AND v.hidden_at IS NULL AND (v.owned_at IS NULL OR v.claim_ended_at IS NOT NULL) AND (v.public_private = 'public' OR v.ownership_type IN ('public', 'subsidiary') OR v.company_size IN ('201-1000', '1001+')) GROUP BY v.id ORDER BY v.slug" > /tmp/aeci-freshness-lane-b.json
```

## 4. Check each row

Work lane A product by product, and lane B vendor by vendor.

**Lane A, in this order. Stop at the first step that settles it.**

1. **Fetch the product's `website`.** Send a browser user agent. Note the final URL after
   redirects and the status. A redirect to another company's domain is a sign of an acquisition.
   A DNS failure, a parked domain or a 404 makes it a watch, not a finding.
2. **Read the page.** Look for "discontinued", "end of life", "sunset", "retired", "no longer
   available", "has been replaced by" or "is now part of". Check that the product name still
   appears.
3. **If the product page is gone, try the vendor's `vendor_website`.** Is the product still in its
   product list or pricing page?
4. **Search the web once** for the product name with "discontinued", "acquired" or "shut down". Use
   a hit only to find a primary source. Never act on the article.
5. **For a dead company, check a registry** if one is public in its country. Record the URL.

**Lane B.** Find the vendor's retired or end-of-life products page once. Compare it with the
`products` list from step 3. Check only the names that appear on it. Where a vendor publishes no
such page, skip it this month and note it in the run issue.

## 5. Decide each finding

| What you found | Outcome | What to do |
|---|---|---|
| Still sold, same name, still for AEC | **Live** | Nothing. One row in the results table |
| Site down, or unclear, with no primary source either way | **Watch** | Carry it to next month's run issue. Two months running with no primary source: give it to Chris |
| Discontinued, and the evidence meets the standard | **Retired** | Hide the product as `defunct` ("Hide a listing" in `catalog.md`). The source is the evidence URL. The received date is today. If the vendor has no other live product and is itself defunct, hide the company instead |
| Renamed, same product | **Renamed** | Correct the name in the review app and promote it. Then follow `catalog.md` "Rename a live slug" if the slug must change |
| Merged into another product we list | **Merged** | Give it to Chris. The path is a retraction plus a `slug_redirects` row onto the survivor (`catalog.md` "`pendingRetractions` is non-zero", last paragraph) |
| Acquired, still sold under its name | **Facts** | Correct the vendor's parent company or ownership in the review app and promote it. No takedown |
| Still sold, but no longer for AEC | **Pivoted** | Give it to Chris. Do not hide it. The policy removes a listing for an error or a defunct product. A product that exists but left AEC fits neither, so each one is his ruling |

Three rules apply to every outcome:

- **Every review-app write is a production action.** `update_product`, `promote_product` and every
  other `aeci-review` write tool needs Chris's go-ahead in the session before you call it.
- **The hide reason never says the listing was false.** Write the fact: "The vendor's site says
  this product was discontinued in 2026." A hide is interim, never a finding (`catalog.md`, "Which
  requests oblige us to act").
- **A hide is the takedown, not a deletion.** It is reversible and promote never writes
  `hidden_*`, so the review app can keep the record. A later permanent retraction is a separate
  decision for Chris.

## 6. Record the run

Paste this table into the run issue, one row per product that is not **Live**, then a count of the
**Live** rows. Name the bucket and the lane B vendors you skipped.

| Product | Vendor | Outcome | Evidence URL | Action taken |
|---|---|---|---|---|

Carry every **Watch** row into next month's issue by hand. Nothing else remembers it.

## When something looks wrong

- **Lane A returns nothing.** Every vendor in the bucket is claimed, large or hidden. That is
  possible but rare. Run the query without the bucket clause to check the filter itself.
- **A product you expected is in neither list.** Both queries join on the product's primary
  vendor row (`product_vendors.is_primary = 1`). A product with no primary row is missing from
  both. Report it on the run issue. It is a data defect, not a freshness finding.
- **A hidden product is back in search.** See `catalog.md` "When something looks wrong" under
  "Removal requests".

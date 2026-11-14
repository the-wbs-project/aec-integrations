# Baseline screenshots (AECI-1817)

"Before" images for the AECI-1720 site redesign. Reviewers compare a redesign PR against these.
Pixel-diff tooling was ruled out on 2026-10-23, so these are for human eyes only.

- **Date taken:** 2026-11-14
- **Origin used:** `http://localhost:8792`
- **Viewports:** 1440 px and 390 px wide, full page, PNG
- **Files:** 70 screenshots, 29.5 MB in total

## Re-run

From the repo root, with the origin of a running site (never production):

```bash
BASELINE_ORIGIN=http://localhost:8792 pnpm baseline:screenshots
```

The origin may also be passed as the first argument. The script is
`apps/web/scripts/baseline-screenshots.mjs`. It deletes and rewrites this folder, README included.
Set `BASELINE_FORMAT=jpeg` to write JPEG at quality 80 if the set grows past about 40 MB.
Set `BASELINE_SLUGS` to a JSON object to override the slugs below when the origin serves other data.

Staging (`https://staging.aecintegrations.com`) is behind Cloudflare Access, so an unauthenticated
run there captures the Access login page. The committed set came from a local `pnpm dev:agent`
stack with the local seed data. That data is small: no product has more than 2 integrations, so
"many integrations" is the best the seed offers.

## Slugs used

| Role | Slug |
|---|---|
| Product, normal | `dynamo-for-revit` |
| Product, many integrations | `revit` |
| Product, zero integrations | `pyrevit` |
| Pair with integrations | `fixture-procore / fixture-acme-connector` |
| Pair without integrations | `revit / dynamo-for-revit` |
| Vendor | `autodesk` |
| Category, audience, phase, trade term | `accounting-erp`, `accounting-finance`, `concept-planning`, `concrete` |
| Docs section, article | `getting-started`, `getting-started/taxonomy` |

## Screenshots

| Route | Viewport | HTTP status | File |
|---|---|---|---|
| `/` | 1440 | 200 | [home-1440.png](./home-1440.png) |
| `/products` | 1440 | 200 | [products-1440.png](./products-1440.png) |
| `/products/dynamo-for-revit` | 1440 | 200 | [product-normal-1440.png](./product-normal-1440.png) |
| `/products/revit` | 1440 | 200 | [product-many-integrations-1440.png](./product-many-integrations-1440.png) |
| `/products/pyrevit` | 1440 | 200 | [product-zero-integrations-1440.png](./product-zero-integrations-1440.png) |
| `/products/fixture-procore/integrations/fixture-acme-connector` | 1440 | 200 | [pair-with-integrations-1440.png](./pair-with-integrations-1440.png) |
| `/products/revit/integrations/dynamo-for-revit` | 1440 | 200 | [pair-without-integrations-1440.png](./pair-without-integrations-1440.png) |
| `/vendors/autodesk` | 1440 | 200 | [vendor-1440.png](./vendor-1440.png) |
| `/categories` | 1440 | 200 | [categories-1440.png](./categories-1440.png) |
| `/categories/accounting-erp` | 1440 | 200 | [category-term-1440.png](./category-term-1440.png) |
| `/audiences` | 1440 | 200 | [audiences-1440.png](./audiences-1440.png) |
| `/audiences/accounting-finance` | 1440 | 200 | [audience-term-1440.png](./audience-term-1440.png) |
| `/phases` | 1440 | 200 | [phases-1440.png](./phases-1440.png) |
| `/phases/concept-planning` | 1440 | 200 | [phase-term-1440.png](./phase-term-1440.png) |
| `/trades` | 1440 | 200 | [trades-1440.png](./trades-1440.png) |
| `/trades/concrete` | 1440 | 200 | [trade-term-1440.png](./trade-term-1440.png) |
| `/search` | 1440 | 200 | [search-1440.png](./search-1440.png) |
| `/about` | 1440 | 200 | [about-1440.png](./about-1440.png) |
| `/methodology` | 1440 | 200 | [methodology-1440.png](./methodology-1440.png) |
| `/updates` | 1440 | 200 | [updates-1440.png](./updates-1440.png) |
| `/roadmap` | 1440 | 200 | [roadmap-1440.png](./roadmap-1440.png) |
| `/vendor-program` | 1440 | 200 | [vendor-program-1440.png](./vendor-program-1440.png) |
| `/vendor-program/list-your-product` | 1440 | 200 | [list-your-product-1440.png](./list-your-product-1440.png) |
| `/contact` | 1440 | 200 | [contact-1440.png](./contact-1440.png) |
| `/docs` | 1440 | 200 | [docs-home-1440.png](./docs-home-1440.png) |
| `/docs/getting-started` | 1440 | 200 | [docs-section-1440.png](./docs-section-1440.png) |
| `/docs/getting-started/taxonomy` | 1440 | 200 | [docs-article-1440.png](./docs-article-1440.png) |
| `/legal/terms` | 1440 | 200 | [legal-terms-1440.png](./legal-terms-1440.png) |
| `/legal/privacy` | 1440 | 200 | [legal-privacy-1440.png](./legal-privacy-1440.png) |
| `/legal/review-guidelines` | 1440 | 200 | [legal-review-guidelines-1440.png](./legal-review-guidelines-1440.png) |
| `/legal/listing-accuracy` | 1440 | 200 | [legal-listing-accuracy-1440.png](./legal-listing-accuracy-1440.png) |
| `/legal/vendor-terms` | 1440 | 200 | [legal-vendor-terms-1440.png](./legal-vendor-terms-1440.png) |
| `/legal/managed-plan-agreement` | 1440 | 200 | [legal-managed-plan-agreement-1440.png](./legal-managed-plan-agreement-1440.png) |
| `/auth/login` | 1440 | 200 | [sign-in-1440.png](./sign-in-1440.png) |
| `/this-page-does-not-exist` | 1440 | 404 | [not-found-1440.png](./not-found-1440.png) |
| `/` | 390 | 200 | [home-390.png](./home-390.png) |
| `/products` | 390 | 200 | [products-390.png](./products-390.png) |
| `/products/dynamo-for-revit` | 390 | 200 | [product-normal-390.png](./product-normal-390.png) |
| `/products/revit` | 390 | 200 | [product-many-integrations-390.png](./product-many-integrations-390.png) |
| `/products/pyrevit` | 390 | 200 | [product-zero-integrations-390.png](./product-zero-integrations-390.png) |
| `/products/fixture-procore/integrations/fixture-acme-connector` | 390 | 200 | [pair-with-integrations-390.png](./pair-with-integrations-390.png) |
| `/products/revit/integrations/dynamo-for-revit` | 390 | 200 | [pair-without-integrations-390.png](./pair-without-integrations-390.png) |
| `/vendors/autodesk` | 390 | 200 | [vendor-390.png](./vendor-390.png) |
| `/categories` | 390 | 200 | [categories-390.png](./categories-390.png) |
| `/categories/accounting-erp` | 390 | 200 | [category-term-390.png](./category-term-390.png) |
| `/audiences` | 390 | 200 | [audiences-390.png](./audiences-390.png) |
| `/audiences/accounting-finance` | 390 | 200 | [audience-term-390.png](./audience-term-390.png) |
| `/phases` | 390 | 200 | [phases-390.png](./phases-390.png) |
| `/phases/concept-planning` | 390 | 200 | [phase-term-390.png](./phase-term-390.png) |
| `/trades` | 390 | 200 | [trades-390.png](./trades-390.png) |
| `/trades/concrete` | 390 | 200 | [trade-term-390.png](./trade-term-390.png) |
| `/search` | 390 | 200 | [search-390.png](./search-390.png) |
| `/about` | 390 | 200 | [about-390.png](./about-390.png) |
| `/methodology` | 390 | 200 | [methodology-390.png](./methodology-390.png) |
| `/updates` | 390 | 200 | [updates-390.png](./updates-390.png) |
| `/roadmap` | 390 | 200 | [roadmap-390.png](./roadmap-390.png) |
| `/vendor-program` | 390 | 200 | [vendor-program-390.png](./vendor-program-390.png) |
| `/vendor-program/list-your-product` | 390 | 200 | [list-your-product-390.png](./list-your-product-390.png) |
| `/contact` | 390 | 200 | [contact-390.png](./contact-390.png) |
| `/docs` | 390 | 200 | [docs-home-390.png](./docs-home-390.png) |
| `/docs/getting-started` | 390 | 200 | [docs-section-390.png](./docs-section-390.png) |
| `/docs/getting-started/taxonomy` | 390 | 200 | [docs-article-390.png](./docs-article-390.png) |
| `/legal/terms` | 390 | 200 | [legal-terms-390.png](./legal-terms-390.png) |
| `/legal/privacy` | 390 | 200 | [legal-privacy-390.png](./legal-privacy-390.png) |
| `/legal/review-guidelines` | 390 | 200 | [legal-review-guidelines-390.png](./legal-review-guidelines-390.png) |
| `/legal/listing-accuracy` | 390 | 200 | [legal-listing-accuracy-390.png](./legal-listing-accuracy-390.png) |
| `/legal/vendor-terms` | 390 | 200 | [legal-vendor-terms-390.png](./legal-vendor-terms-390.png) |
| `/legal/managed-plan-agreement` | 390 | 200 | [legal-managed-plan-agreement-390.png](./legal-managed-plan-agreement-390.png) |
| `/auth/login` | 390 | 200 | [sign-in-390.png](./sign-in-390.png) |
| `/this-page-does-not-exist` | 390 | 404 | [not-found-390.png](./not-found-390.png) |

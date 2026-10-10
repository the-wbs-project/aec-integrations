# ADR 0040: Product docs live inside apps/web

- Status: Accepted
- Date: 2026-10-08
- Issue: AECI-1247 (epic AECI-634)
- Promotes: `STAGE_2_PRODUCT_DOCS_SPEC.md` §2, which asked for this record "when the epic is decomposed"

## Context

Stage 2 made the vendor the first user AECi has to teach. That needs a public help center: how to claim a listing, attest, own an integration, and what a plan does and does not buy. Readers and reviewers need the same kind of page for the directory itself.

A help center is usually its own site. Most teams reach for a docs generator on a `docs.` subdomain. AECi already had a working pattern for build-time Markdown pages: the legal pages (AECI-237) and `/methodology` (AECI-804). AECI-1104 shipped the vendor guide on that pattern on 2026-09-23, ahead of this record.

## Decision

1. **Docs ship as a lazy `/docs` route area inside `apps/web`.** No separate app, no second framework, no subdomain, no separate Worker on a `/docs/*` route.
2. **Content is Markdown with scalar frontmatter in `apps/web/src/content/docs/<section>/<slug>.md`.** The esbuild `text` loader inlines it at build time. The docs manifest (`apps/web/src/app/docs/docs-content.ts`) parses it with `marked` once per isolate and drives the routes, the navigation and the sitemap.
3. **Docs are edited in the same PR as the surface they describe.** That is the sync rule in `docs/CODE_REVIEW_CHECKLIST.md`.

## Why not a separate site

- **One design system.** A second framework means a second token sync, and it drifts.
- **The platform work is already paid for.** SSR, the native Workers Cache, i18n, the a11y discipline, the sitemap, and the four-tier deploy with Access all exist. A separate site buys all of it again.
- **Freshness is free.** The cache key includes the Worker version, so build-inlined content is fresh on every deploy with no purge wiring.
- **Staleness is the failure that matters most.** In-repo docs can change in the same diff as the portal they describe. A separate site cannot be held to that.
- **One domain.** `/docs` on `www` builds the main domain's authority. A subdomain splits it.

## Consequences

- A docs edit ships with an app deploy. Deploys are cheap and gated, so this is accepted.
- The docs content adds to the bundle, but only to a lazy chunk loaded on `/docs` routes.
- Docs have no runtime search at v0. The deferred path is an Algolia `docs_{env}` index on the existing Algolia app.
- **Re-open trigger.** Revisit a dedicated docs generator when any of these is true: the corpus passes about 75 pages, versioned docs become a requirement, or a public or partner API reference ships.
- The build contract is `docs/STAGE_2_PRODUCT_DOCS_SPEC.md`.

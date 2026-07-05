# ADR 0011: Canonical URLs use the serving origin (self-referential, multi-host)

**Status:** Accepted (amended 2026-07-05 — canonical host flipped apex → `www.`; see [Amendment](#amendment-2026-07-05--canonical-host-is-www) below)
**Date:** 2026-06-08
**Context owner:** chrisw@thewbsproject.com
**Issue:** AECI-147
**Interacts with:** #210 (web prod points at `demo.aecintegrations.com`), #211 (CI secret/seed fix)

> **Amendment 2026-07-05:** the self-referential mechanism below is unchanged, but the
> **canonical served host is now `www.aecintegrations.com`**, not the bare apex. The SSR
> Worker 301s the bare apex → `www.` (reversing the original AECI-247 www→apex direction),
> and the no-request fallback / `PUBLIC_SITE_URL` follow. See the [Amendment](#amendment-2026-07-05--canonical-host-is-www) section for details. Where the text below says "the production
> apex `https://aecintegrations.com`" as the fallback/canonical host, read `www.`.

---

## Context

Phase 2 Spec §9.1 requires every page to emit `<link rel="canonical">` (no query params) and an `og:url`, but is silent on **which host** the canonical points at. Two implementations had drifted apart:

- **Browse + detail resolvers** built the canonical from the **request origin** (`new URL(request.url).origin`), falling back to the apex only when `REQUEST` was absent.
- **Index surfaces** (`/products`, `/vendors`, `/integrations`, `/categories`) **hardcoded** the production apex `https://aecintegrations.com`.

This surfaced as a CI failure: served from `localhost:8788`, the browse/detail pages emitted a `localhost` canonical, so `apps/web/e2e/taxonomy-browse.spec.ts` (which asserted the apex) failed for all three taxonomy kinds. The failure had been masked on `main` because the seed-agnostic taxonomy specs `test.skip(...)` when a kind has no terms; once `DIRECT_URL_STAGING` was repointed at the pooler (the IPv6-only direct host was unreachable from IPv4 runners) the dev DB seeded taxonomy terms and the assertions executed for the first time.

The host topology is the crux. Pre-launch, the web app serves **`demo.aecintegrations.com` only**; the apex (`aecintegrations.com`) and `www.` are served by the **landing** Worker (`apps/landing`), and non-prod tiers serve from PR-preview `*.workers.dev` subdomains and `staging.aecintegrations.com` (see `docs/environments.md`, `apps/web/wrangler.jsonc`). So a hardcoded-apex canonical points crawlers at a host the web app does not currently serve.

The decision was framed (in AECI-147) as a binary — always the apex, or the request origin — and the owner chose **request origin**.

Alternatives considered:

- **Option A — hardcode the production apex everywhere.** Matches what the index pages and the original E2E/unit assertions already did, and is the "obvious" consistency fix. **Rejected:** pre-launch the apex is served by the landing Worker, so the canonical would reference content the web app doesn't serve; and it would have to be re-pointed (demo → apex/www) at launch anyway.
- **Option B (chosen) — self-referential, request/serving origin.** Each host canonicalises to itself.

## Decision

- Canonical (`<link rel="canonical">`) and `og:url` use the **serving origin** for the current render — self-referential, multi-host. There is **one** construction point: `apps/web/src/app/core/canonical.ts` → `canonicalUrl(path)`.
  - **Server** (`RenderMode.Server`): the inbound SSR `REQUEST` origin.
  - **Client** (hydration / CSR): `location.origin` — the same host the SSR request came from, so a canonical rebuilt on the client matches the SSR HTML (no hydration drift). This matters because the index pages set meta from `createPaginatedIndex`, which runs on both server and client.
  - **Fallback** (no request, no DOM — e.g. a build-time prerender): the production apex `https://aecintegrations.com`.
- All canonical-building sites consume `canonicalUrl()`: the browse + detail resolvers (`taxonomy-browse.resolver.ts`, `create-detail-resolver.ts`), the index pages (`products-index.ts`, `vendors-index.ts`, `integrations-index.ts`), and the taxonomy index resolver (`taxonomy-index.resolver.ts`, covering `/categories`, `/audiences`, `/phases`). The previously-divergent `DEFAULT_ORIGIN` constant / inline apex strings are removed.
- The **sitemap** (`server/sitemap.ts` via `server-runtime.ts`) and **robots.txt** already build against `new URL(c.req.url).origin`, so sitemap `<loc>` ⇄ page canonical ⇄ `robots` `Sitemap:` line are consistent with **no edits** — the consistency falls out of this decision.
- **Exceptions (documented):** the 404 page (`not-found.resolver.ts`) self-references the *requested* URL on a `noindex` page; the `/preview/*` design-sample routes (e.g. `preview/vendor-detail`) keep a fixed apex canonical. Neither is real content.
- The E2E canonical assertions were over-specified (hardcoded apex) and are relaxed to the **serving origin** (derived from `res.url()`).

## Why this is the right call

- **Future-proof.** When the directory promotes from `demo.aecintegrations.com` to the apex/www at launch, canonicals follow the serving host automatically — no code change.
- **No index leakage.** Non-prod hosts (PR previews, `staging.`) sit behind Cloudflare Access (`docs/access.md`), so their self-canonicals never reach the public index. Only the public `demo.` host self-canonicalises, which is correct for the host actually serving the content.
- **Single source of truth.** One helper builds every canonical/og:url, so the index-vs-resolver drift that caused AECI-147 cannot recur.

## Consequences

- ➕ Canonical behaviour is consistent across index / browse / detail / sitemap / robots, and built in exactly one place.
- ➕ The demo → apex launch move needs no canonical code change.
- ➖ Canonicals are environment-dependent. Tests must assert the **serving origin**, not a fixed string (done). Any future canonical-asserting test must follow suit.
- ➖ The apex literal survives only as the no-request fallback and in two documented exceptions (404, `/preview/*`); a reviewer scanning for `aecintegrations.com` will still find those — they are intentional.
- ➖ If a non-prod tier ever became publicly crawlable (Access removed), its self-canonical would be indexable. The mitigation is the Access gate, not the canonical; revisit if that gate changes.

## Amendment (2026-07-05): canonical host is `www.`

The apex cutover (AECI-247/277) originally made the **bare apex** the canonical served host: production binds both `aecintegrations.com` and `www.aecintegrations.com` to the SSR Worker, and the Worker 301'd any `www.` host → the bare apex. That direction is now **reversed** — the canonical public host is **`www.aecintegrations.com`**.

- **What changed:** the SSR Worker's host-redirect middleware (`apps/web/src/server-runtime.ts`) now folds the **exact bare apex → `www.`** (301, path + query preserved, edge-cacheable); `www.` serves directly. Other hosts (`prod.`/`demo.`/`staging.`, `localhost`, `*.workers.dev`) are untouched, and `www.` never redirects, so there is no apex↔www loop by construction.
- **What did NOT change:** the self-referential decision above. Canonicals, `og:url`, sitemap `<loc>`s, and the `robots` `Sitemap:` line still derive from the **serving origin**, so with `www.` as the served host they all become `www.` **automatically — no per-surface code change**. Only three baked-in apex literals flipped to `www.`: the no-request **fallback** in `apps/web/src/app/core/canonical.ts`, the **404** fallback (`not-found.resolver.ts`), and the `/preview/*` design sample (`preview/vendor-detail`).
- **Non-web surface:** the API Worker's `PUBLIC_SITE_URL` (production) flipped to `https://www.aecintegrations.com` — it builds absolute links in transactional email, IndexNow submissions, and Google Indexing pings, so those now emit canonical `www.` URLs (no redirect hop, consistent with the sitemap). The AECI-262 WAF-metrics cron host-scopes on `PUBLIC_SITE_URL`, so it now polls firewall events for the `www.` host.
- **Deploy note:** the retired `www.→apex` 301 is cached (≤1h browser via `max-age`, ≤24h edge via `s-maxage`). A client still replaying it from cache can loop against the new apex→www 301 until the entry expires; **purge the Cloudflare edge cache after the direction flip deploys**, and note the browser side self-heals within the hour. Done pre-launch, exposure is minimal.
- **Why:** operator preference for `www.` as the indexed canonical (an apex-vs-www SEO choice). Because canonicals were already self-referential, the flip is a one-line direction change plus the baked-in fallbacks and `PUBLIC_SITE_URL`.

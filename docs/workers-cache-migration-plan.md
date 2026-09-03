# Workers Cache Migration — Linear Issues (retired)

> **Retired by WC-11 (AECI-325), 2026-07.** The Workers Cache migration — epic **AECI-314**,
> WC-1…WC-11 / **AECI-315…325** — is complete, and this planning doc has been reduced to a stub.
> Where its content went:
>
> - **Decision & rationale** → **[ADR 0020 — Native Workers Cache + cross-Worker purge via Queue](adr/0020-workers-cache-and-queue-purge.md)** (amends ADR 0004; reverses ADR 0010's mechanism). The pinned Cloudflare facts, code touch-points, sequencing, and resolved open questions this file used to carry now live there.
> - **Current cache model** (tag vocabulary, TTLs, key normalization, invalidation, cookie hygiene, SEO/`noindex`, observability, local-dev) → **[`docs/CACHE_STRATEGY.md`](CACHE_STRATEGY.md)** — the source of truth.
> - **Per-issue Context / Scope / Acceptance Criteria** → **Linear**, see the WC-N → AECI-N map below.
>
> The former body is preserved in git history. All issues sit under epic **AECI-314** (Stage 2 Build,
> AECI team, base branch `stage-2`).

## Issue map (WC-N → Linear)

| Handle | Linear | Title |
|---|---|---|
| **epic** | [AECI-314](https://linear.app/aec-integrations/issue/AECI-314) | Workers Cache Migration (epic) |
| WC-1 | [AECI-315](https://linear.app/aec-integrations/issue/AECI-315) | ADR + spike: adopt Workers Cache; cross-Worker purge via Queue |
| WC-2 | [AECI-316](https://linear.app/aec-integrations/issue/AECI-316) | Upgrade Cloudflare Workers toolchain + bump compatibility dates |
| WC-3 | [AECI-317](https://linear.app/aec-integrations/issue/AECI-317) | Enable Workers Cache on the SSR Worker; remove the manual `caches.default` pipeline |
| WC-4 | [AECI-318](https://linear.app/aec-integrations/issue/AECI-318) | Preserve cache-key normalization (utm strip, per-route allowlist, canonical order) |
| WC-5 | [AECI-319](https://linear.app/aec-integrations/issue/AECI-319) | Cross-Worker purge via Cloudflare Queue (promote → SSR cache) |
| WC-6 | [AECI-320](https://linear.app/aec-integrations/issue/AECI-320) | Migrate `POST /admin/purge` to native `ctx.cache.purge()` |
| WC-7 | [AECI-321](https://linear.app/aec-integrations/issue/AECI-321) | datatool bulk purge via the purge queue |
| WC-8 | [AECI-322](https://linear.app/aec-integrations/issue/AECI-322) | Observability + `X-Robots-Tag` under a front-of-Worker cache |
| WC-9 | [AECI-323](https://linear.app/aec-integrations/issue/AECI-323) | Tests + local-dev verification for the new cache model |
| WC-10 | [AECI-324](https://linear.app/aec-integrations/issue/AECI-324) | Retire the HTTP purge transport + prune now-unused secrets |
| WC-11 | [AECI-325](https://linear.app/aec-integrations/issue/AECI-325) | Documentation sweep |

> **Note on deployment status:** native caching is live on the `preview` + `staging` SSR envs;
> `demo` + `production` ship the same two-entrypoint code but currently run **uncached** (no `exports`
> block in `apps/web/wrangler.jsonc`). The prod-enable gate (WC-4/5/6/8) is met; flipping demo/prod on
> is a deliberate step beyond WC-1…WC-11. See `docs/CACHE_STRATEGY.md` (top-of-doc "Deployment status").

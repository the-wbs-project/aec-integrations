# ADR 0006: Algolia + InstantSearch over Cloudflare AI Search

**Status:** Accepted (search ships in Phase 3)
**Date:** Stage 1 planning · **Recorded:** 2026-06-01
**Context owner:** _unset — confirm_

> _Rationale reconstructed from repo evidence (`STAGE_1_SPEC.md` §7, the `chris-walton-wbs/cloudflare-ai-search-plan` branch) during the 2026-06-01 audit; confirm the head-to-head._

---

## Context

Search is the core discovery surface (`STAGE_1_SPEC.md` §7). A directory needs fast **faceted browse**, typo tolerance, customizable ranking, and **per-locale indexes** for i18n. Cloudflare AI Search (semantic / RAG-oriented) was evaluated — see the `cloudflare-ai-search-plan` branch — alongside **Algolia + `angular-instantsearch`**.

## Decision

Use **Algolia + InstantSearch Angular**. One index per entity type at launch; per-locale parallel indexes (`products_es`, …) when locales are added. Bulk sync via `scripts/algolia-bulk-sync.ts`; a daily incremental-sync Worker at 08:00 UTC (= 03:00 EST); real-time webhook sync deferred to Stage 2 (when vendors edit their own data).

## Consequences

- ➕ Mature faceting, typo-tolerance, and ranking customization suited to directory browse; first-class Angular InstantSearch widgets; a clean per-locale index story for i18n.
- ➖ A third-party dependency with per-search/record pricing, plus a sync pipeline to maintain (Algolia↔Supabase index drift is a listed risk in `STAGE_1_SPEC.md`).
- ➖ Not semantic / RAG out of the box; if natural-language or semantic search becomes a requirement, revisit Cloudflare AI Search / Vectorize in a later stage.

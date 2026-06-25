---
name: algolia-no-orphan-sweep
description: Algolia search index has no orphan-removal / full-reindex path; records deleted-from or never-in D1 strand as searchable orphans
metadata:
  type: project
---

The Algolia sync (`apps/api/src/lib/algolia-sync.ts`) is incremental + watermark-based and reads **D1**. It only emits a `deleteObject` for a row that the D1 query **returns** (still exists, `updated_at` in window) whose `promotion_status !== 'promoted'` (`buildFromStatusRows`). A record **absent from D1** never comes back from the query, so no delete is ever issued for it.

There is **no** `replaceAllObjects` / `clearObjects` / orphan-sweep / full-reindex anywhere (verified by grep, 2026-06). The `algolia-bulk-sync` module the drift check's docstring points to as the repair path **does not exist** (only referenced in `algolia-drift.ts` comments — AECI-138 never landed). The daily drift check (`algolia-drift.ts`, AECI-140) is **report-only** — it emits `aeci.algolia.index_drift` but does not remediate.

**Consequence:** any record deleted from D1, or stranded by the Supabase→D1 catalog cutover (ADR 0016), remains a live searchable orphan indefinitely. First observed case: the "Fixture Procore" AECI-65 axe/Lighthouse fixture (`...062` product, `...061` vendor, `...065` integration) — seeded only to Supabase staging via `deploy.yml` "Seed Phase 2 CI fixtures" (never to remote D1), indexed pre-cutover, now in staging search but 404 on detail (D1 has no row).

**Why:** the index lifecycle assumed D1 is the only writer and rows are flipped (status change) not hard-deleted; a migration that replaces the underlying DB breaks that assumption with no backstop.

**How to apply:** when debugging "in search but doesn't exist," suspect an Algolia orphan first. Immediate fix = deindex by objectID (= the D1 UUID). Systemic fix = implement a replace-all/orphan-sweep reindex or add a delete-orphans pass to the drift job. The phase-2 fixture seed to Supabase staging is now also dead weight (app reads D1, not Supabase). Related: [[fixtures-seeded-to-supabase-not-d1]].

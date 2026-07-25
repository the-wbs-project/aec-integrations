# Prod catalog reset — 2026-07 (keep products & vendors)

One-off operator runbook: wipe the integration catalog + taxonomy in
**`aeci-app-production`** ahead of a full re-promotion from the review-app,
while **keeping** `products` and `vendors` rows (stable IDs + slugs).

Prepared 2026-07-25 against live prod (row counts in the SQL comments were
verified that day: 397 integrations / 712 claims / 712 attestations /
123 products / 83 vendors). Reviews, vendor_requests, feedback, and
mailing_list were all confirmed **empty**; the 2 `profiles` rows are
disposable auto-created `reviewer` rows.

## Why this shape (and not a full wipe)

- **Kept product/vendor IDs** mean: `page_views` FKs stay intact (trending
  and one month of real traffic history survive), product/vendor URLs and
  Algolia records stay stable (zero SEO cost), and the review-app's stored
  product/vendor `supabaseId`s remain valid.
- **`taxonomy_data_objects` must never be wiped**: the promote endpoint
  resolves claims against it but never creates it (frozen vocabulary,
  `docs/DATA_OBJECT_VOCABULARY.md`).
- **`page_views` / `audit_log` are the only irreplaceable data in prod** —
  a full-DB wipe or `datatool copy` (whole-database mirror) would destroy
  both for no benefit.
- **The silent no-op trap**: promote's update path is a blind
  `UPDATE … WHERE id = ?` that reports `operation: "updated"` even when it
  matches zero rows. After this reset, any re-push carrying a stale
  **integration** `supabaseId` silently writes nothing — the stored
  integration IDs in Airtable MUST be cleared first. (Product/vendor IDs
  stay valid and must be kept.)

## Execution order

1. **Freeze promotes** (stop review-app pushes).
2. Run **`reset.sql`** in Cloudflare dashboard → D1 → `aeci-app-production`
   → Console. Not atomic across statements; child-first order means a
   partial run is FK-consistent — re-run from where it stopped. Per-statement
   `rows written` should match the `-- expect` comments.
3. Run **`verify.sql`** — every value must match its comment.
4. In Airtable, **bulk-clear the stored integration `supabaseId`s**
   (leave product/vendor IDs alone).
5. **Full re-push** from the review-app. Products/vendors update in place
   (join sets replace wholesale; scalar fields merge — the push must send
   complete payloads with explicit `null`s for cleared fields, or old
   values silently survive). Integrations re-create fresh.
6. **Manual Algolia reindex + orphan purge** (datatool) — don't wait for
   the 03:00 UTC cron; stale integration records point at dead IDs.
7. **Edge-cache purge** (`POST /admin/purge`).
8. Run **`orphan-diff.sql`** (set the re-push start timestamp) — anything
   listed was deleted/merged during the Airtable cleanup and needs
   `pnpm ops:retract-product` (apps/api) or a manual delete (NULL the
   matching `page_views.product_id`/`vendor_id` first; those FKs have no
   ON DELETE action).

## Expected fallout during/after the window

- Product/vendor pages show empty categories/vendors/integrations
  sections; integration pair pages 404 — until the re-push lands.
- Home stats show stale integration counts until the 07:00 UTC recompute
  cron. Trending unaffected (product IDs kept).
- If the window spans 03:00 UTC, the Algolia cron syncs search to the
  empty integration set (self-heals on step 6). If it spans 04:00 UTC,
  the data-quality digest will complain — expected noise.

## Files

| File | Purpose |
|---|---|
| `reset.sql` | The wipe + `integration_count` reset + audit row |
| `verify.sql` | Post-reset count assertions |
| `orphan-diff.sql` | Post-re-push orphan detection (products/vendors to retract) |

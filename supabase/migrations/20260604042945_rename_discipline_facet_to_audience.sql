-- AECI-121 — Rename the taxonomy facet "Discipline" → "Audience".
--
-- WHY: a separate "Roles" facet was rejected (~55% overlapped Disciplines). We
-- instead rename the existing facet to "Audience" ("who is this for?") and
-- expand it with cross-cutting personas (the persona rows land via the
-- code-managed reference data, supabase/reference-data/taxonomy.sql).
--
-- This migration is a PURE RENAME: it preserves every row and id. No table is
-- dropped or recreated. Postgres automatically carries the following along with
-- the table OID, so they need no action here:
--   * the PostgREST GRANTs (`grant select ... to anon, authenticated`)
--   * the RLS enabled flag (ALTER TABLE ... ENABLE ROW LEVEL SECURITY)
--   * the RLS policies' attachment and the FK *targets*
-- Everything whose identifier literally embeds "discipline" keeps its old name
-- across a table rename and is renamed explicitly below.

-- 1. Rename the join FK column FIRST, before the table rename. The composite PK
--    (product_id, discipline_id) auto-updates its column list to the new name.
ALTER TABLE "product_disciplines"
  RENAME COLUMN "discipline_id" TO "audience_id";

-- 2. Rename the two tables. GRANTs, the RLS-enabled flag, the RLS policies, and
--    the FK target (product_audiences.audience_id -> taxonomy_audiences.id) all
--    follow the OID automatically; only the table names change here.
ALTER TABLE "taxonomy_disciplines" RENAME TO "taxonomy_audiences";
ALTER TABLE "product_disciplines"  RENAME TO "product_audiences";

-- 3. Rename the primary-key constraints (they do NOT follow a table rename).
ALTER TABLE "taxonomy_audiences"
  RENAME CONSTRAINT "taxonomy_disciplines_pkey" TO "taxonomy_audiences_pkey";
ALTER TABLE "product_audiences"
  RENAME CONSTRAINT "product_disciplines_pkey" TO "product_audiences_pkey";

-- 4. Rename the foreign-key constraints (targets auto-followed; only the
--    identifier strings are stale).
ALTER TABLE "product_audiences"
  RENAME CONSTRAINT "product_disciplines_product_id_fkey"
                 TO "product_audiences_product_id_fkey";
ALTER TABLE "product_audiences"
  RENAME CONSTRAINT "product_disciplines_discipline_id_fkey"
                 TO "product_audiences_audience_id_fkey";

-- 5. Rename the indexes: the unique slug key, the slug lookup index, and the
--    join FK index (whose name also embeds the old column).
ALTER INDEX "taxonomy_disciplines_slug_key"      RENAME TO "taxonomy_audiences_slug_key";
ALTER INDEX "taxonomy_disciplines_slug_idx"      RENAME TO "taxonomy_audiences_slug_idx";
ALTER INDEX "product_disciplines_discipline_idx" RENAME TO "product_audiences_audience_idx";

-- 6. Rename the updated_at trigger (the shared set_updated_at() function is
--    untouched).
ALTER TRIGGER "taxonomy_disciplines_updated_at" ON "taxonomy_audiences"
  RENAME TO "taxonomy_audiences_updated_at";

-- 7. Re-create the RLS policies under the new names. The policy bodies are
--    unchanged (they reference product_id / promotion_status only — no renamed
--    column). Drop-by-old-name-then-create matches the idempotent house style in
--    20260602051513_rls_grants_and_policies.sql; the old-named policies still
--    exist on the renamed tables until dropped here.
drop policy if exists "taxonomy_disciplines: public read" on "taxonomy_audiences";
create policy "taxonomy_audiences: public read"
  on "taxonomy_audiences"
  for select to anon, authenticated
  using (true);

drop policy if exists "product_disciplines: public read when product promoted" on "product_audiences";
create policy "product_audiences: public read when product promoted"
  on "product_audiences"
  for select to anon, authenticated
  using (exists (select 1 from products p where p.id = product_id and p.promotion_status = 'promoted'));

-- 8. translations.entity_type vocabulary: retire 'discipline', allow 'audience'.
--    A CHECK ... IN (...) can't be edited in place, so drop + re-add. The
--    defensive UPDATE first migrates any existing rows (none expected locally;
--    covers remote rows). A CHECK constraint cannot be renamed to change its
--    predicate, hence the drop/re-add rather than a rename.
update "translations" set "entity_type" = 'audience' where "entity_type" = 'discipline';
alter table "translations" drop constraint if exists "translations_entity_type_check";
alter table "translations"
  add constraint "translations_entity_type_check"
  check ("entity_type" in ('product', 'vendor', 'category', 'audience', 'phase', 'integration'));

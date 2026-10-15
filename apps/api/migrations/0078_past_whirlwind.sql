-- AECI-1366: record the vendor-terms acceptance given on a typed-in listing request
-- (`docs/DATABASE_SCHEMA.md` §8.6d, `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §15.4).
--
-- ADDITIVE ONLY: one `ALTER TABLE ... ADD`, no table recreate. drizzle-kit generated
-- this column, but its `ADD ... REFERENCES` dropped the `ON DELETE SET NULL` clause
-- (docs/migrations.md §0, the 0047 precedent), so the FK is written in full here. A
-- NULL column with a FK is valid on every existing row.
ALTER TABLE `agreement_acceptances` ADD `listing_request_id` text REFERENCES listing_requests(id) ON DELETE SET NULL;

-- AECI-978 — the general retired-slug → surviving-slug map (`STAGE_3_SPEC.md` §2.6
-- option B), plus the two production rows it exists to hold.
--
-- ╔════════════════════════════════════════════════════════════════════════════════╗
-- ║ HAND-EDITED. The CREATE is drizzle-kit's, verbatim. The two INSERTs below are   ║
-- ║ NOT — a regeneration drops them silently, and the table applies clean and empty.║
-- ║ `src/test/migration-0039.spec.ts` asserts both rows and fails if they go.       ║
-- ╚════════════════════════════════════════════════════════════════════════════════╝
--
-- Seeding data in a migration rather than in `seed/` is deliberate: `seed/*.sql` is
-- local-only, and these two rows have to reach PRODUCTION for the redirects to work
-- at all. They are the whole point of the change, not fixtures. The table is new, so
-- no recreate and no cascade — this file is additive end to end.
CREATE TABLE `slug_redirects` (
	`entity` text NOT NULL,
	`from_slug` text NOT NULL,
	`to_slug` text NOT NULL,
	`reason` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`entity`, `from_slug`),
	CONSTRAINT "slug_redirects_entity_check" CHECK("entity" IN ('product', 'vendor')),
	CONSTRAINT "slug_redirects_distinct_check" CHECK("from_slug" <> "to_slug")
);
--> statement-breakpoint
-- AECI-809 — Autodesk Construction Cloud merges into Autodesk Forma and the ACC
-- record retires. This row ships AHEAD of that retirement (the ticket sequences it
-- that way) and is INERT until it lands: the resolver reads this map only after the
-- product read returned nothing, so while the ACC row is still live its page renders
-- and this row does nothing. AECI-953's `integration_endpoint_moves` covers the 28
-- pair pages; this covers the one URL nothing else did, `/products/autodesk-construction-cloud`.
INSERT INTO `slug_redirects` ("entity", "from_slug", "to_slug", "reason", "created_at")
  VALUES ('product', 'autodesk-construction-cloud', 'autodesk-forma', 'AECI-809 — ACC merged into Autodesk Forma; the ACC record retires.', '2026-09-15T00:00:00.000Z');
--> statement-breakpoint
-- AECI-685 — both Bluebeam products were re-parented to Nemetschek Group, leaving the
-- `bluebeam` vendor with zero products, and the row was deleted. This shipped as a
-- hardcoded Worker route in `apps/web/src/server-runtime.ts`; AECI-978 deletes that
-- route and moves the case here, which is what its own comment asked the next person
-- to do. Behaviour is unchanged for a reader: same 301, same target.
INSERT INTO `slug_redirects` ("entity", "from_slug", "to_slug", "reason", "created_at")
  VALUES ('vendor', 'bluebeam', 'nemetschek-group', 'AECI-685 — Bluebeam products re-parented to Nemetschek Group; the vendor row was deleted.', '2026-09-15T00:00:00.000Z');

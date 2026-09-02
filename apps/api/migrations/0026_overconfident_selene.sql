CREATE TABLE `connector_catalog_surfaces` (
	`id` text PRIMARY KEY NOT NULL,
	`catalog_id` text NOT NULL,
	`surface_role` text NOT NULL,
	`index_kind` text,
	`index_url` text,
	`last_ingested_at` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`catalog_id`) REFERENCES `connector_catalogs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_catalog_surfaces_role_idx` ON `connector_catalog_surfaces` (`catalog_id`,`surface_role`);--> statement-breakpoint
CREATE TABLE `connector_catalogs` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_product_id` text NOT NULL,
	`connector_authorship` text,
	`managed_by` text DEFAULT 'review' NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`connector_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "connector_catalogs_authorship_check" CHECK("connector_authorship" IN ('platform', 'partner', 'mixed')),
	CONSTRAINT "connector_catalogs_managed_by_check" CHECK("managed_by" IN ('review', 'vendor'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_catalogs_product_idx` ON `connector_catalogs` (`connector_product_id`);--> statement-breakpoint
CREATE TABLE `connector_evidenced_pairs` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_product_id` text NOT NULL,
	`product_a_id` text NOT NULL,
	`product_b_id` text NOT NULL,
	`name` text,
	`built_by_vendor_id` text,
	`mechanism_name` text,
	`direction` text,
	`description` text,
	`website` text,
	`listing_url` text,
	`docs_url` text,
	`mechanism_url` text,
	`pricing_model` text,
	`maturity` text,
	`notes` text,
	`last_reviewed_at` text,
	`maintained_by` text DEFAULT 'aeci' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`connector_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_a_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_b_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`built_by_vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "connector_evidenced_pairs_maintained_by_check" CHECK("maintained_by" IN ('aeci', 'vendor')),
	CONSTRAINT "connector_evidenced_pairs_canonical_order" CHECK("product_a_id" < "product_b_id"),
	CONSTRAINT "connector_evidenced_pairs_distinct_connector" CHECK("connector_product_id" <> "product_a_id" AND "connector_product_id" <> "product_b_id"),
	CONSTRAINT "connector_evidenced_pairs_direction_check" CHECK("direction" IN ('a_to_b', 'b_to_a', 'both'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_evidenced_pairs_pair_idx` ON `connector_evidenced_pairs` (`connector_product_id`,`product_a_id`,`product_b_id`);--> statement-breakpoint
CREATE INDEX `connector_evidenced_pairs_product_a_idx` ON `connector_evidenced_pairs` (`product_a_id`);--> statement-breakpoint
CREATE INDEX `connector_evidenced_pairs_product_b_idx` ON `connector_evidenced_pairs` (`product_b_id`);--> statement-breakpoint
CREATE INDEX `connector_evidenced_pairs_connector_idx` ON `connector_evidenced_pairs` (`connector_product_id`);--> statement-breakpoint
CREATE INDEX `connector_evidenced_pairs_built_by_idx` ON `connector_evidenced_pairs` (`built_by_vendor_id`) WHERE "built_by_vendor_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `connector_pairs` (
	`id` text PRIMARY KEY NOT NULL,
	`catalog_id` text NOT NULL,
	`stub_a_id` text NOT NULL,
	`stub_b_id` text NOT NULL,
	`url_a_to_b` text,
	`url_b_to_a` text,
	`surface` text DEFAULT 'unknown' NOT NULL,
	`classified_at` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`removed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`catalog_id`) REFERENCES `connector_catalogs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stub_a_id`) REFERENCES `connector_stubs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stub_b_id`) REFERENCES `connector_stubs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "connector_pairs_canonical_order" CHECK("stub_a_id" < "stub_b_id"),
	CONSTRAINT "connector_pairs_surface_check" CHECK("surface" IN ('curated', 'generated', 'unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_pairs_pair_idx` ON `connector_pairs` (`catalog_id`,`stub_a_id`,`stub_b_id`);--> statement-breakpoint
CREATE INDEX `connector_pairs_stub_b_idx` ON `connector_pairs` (`stub_b_id`);--> statement-breakpoint
CREATE TABLE `connector_stub_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`stub_id` text NOT NULL,
	`catalog_id` text NOT NULL,
	`product_id` text,
	`status` text NOT NULL,
	`confidence` text,
	`evidence_url` text,
	`decided_by` text,
	`decided_at` text,
	`checked_at` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`stub_id`) REFERENCES `connector_stubs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`catalog_id`) REFERENCES `connector_catalogs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "connector_stub_mappings_status_check" CHECK("status" IN ('mapped', 'ruled_out', 'out_of_scope', 'no_record', 'ambiguous_parked')),
	CONSTRAINT "connector_stub_mappings_confidence_check" CHECK("confidence" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_stub_mappings_pair_idx` ON `connector_stub_mappings` (`stub_id`,`product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `connector_stub_mappings_decision_idx` ON `connector_stub_mappings` (`stub_id`) WHERE "status" IN ('out_of_scope', 'no_record', 'ambiguous_parked');--> statement-breakpoint
CREATE INDEX `connector_stub_mappings_product_idx` ON `connector_stub_mappings` (`product_id`);--> statement-breakpoint
CREATE INDEX `connector_stub_mappings_status_idx` ON `connector_stub_mappings` (`catalog_id`,`status`);--> statement-breakpoint
CREATE TABLE `connector_stubs` (
	`id` text PRIMARY KEY NOT NULL,
	`catalog_id` text NOT NULL,
	`slug` text NOT NULL,
	`label` text,
	`url` text,
	`direction_role` text,
	`action_count` integer,
	`actions` text,
	`actions_hash` text,
	`actions_fetched_at` text,
	`previous_labels` text,
	`meta` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`removed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`catalog_id`) REFERENCES `connector_catalogs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_stubs_catalog_slug_idx` ON `connector_stubs` (`catalog_id`,`slug`);--> statement-breakpoint
CREATE INDEX `connector_stubs_label_idx` ON `connector_stubs` (`label`);
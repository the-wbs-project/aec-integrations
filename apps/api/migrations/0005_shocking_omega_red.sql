CREATE TABLE `attestations` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`source` text NOT NULL,
	`asserted` integer DEFAULT true NOT NULL,
	`introduced_at` text,
	`deprecated_at` text,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "attestations_source_check" CHECK("source" IN ('aeci', 'vendor_a', 'vendor_b'))
);
--> statement-breakpoint
CREATE INDEX `attestations_active_idx` ON `attestations` (`claim_id`) WHERE "deprecated_at" IS NULL;--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`data_object_id` text NOT NULL,
	`direction` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`data_object_id`) REFERENCES `taxonomy_data_objects`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "claims_direction_check" CHECK("direction" IN ('a_to_b', 'b_to_a', 'both'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claims_identity_key` ON `claims` (`integration_id`,`data_object_id`,`direction`);--> statement-breakpoint
CREATE INDEX `claims_data_object_idx` ON `claims` (`data_object_id`);--> statement-breakpoint
CREATE TABLE `taxonomy_data_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`display_order` integer,
	`aliases` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_data_objects_slug_key` ON `taxonomy_data_objects` (`slug`);
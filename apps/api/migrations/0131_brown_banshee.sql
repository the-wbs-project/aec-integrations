CREATE TABLE `sync_service_pair_contests` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`integration_id` text,
	`evidenced_pair_id` text,
	`claim_id` text,
	`current_direction` text,
	`proposed_direction` text,
	`reason` text NOT NULL,
	`submitter_vendor_id` text NOT NULL,
	`submitted_by` text,
	`routed_to` text NOT NULL,
	`owner_vendor_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`decision_note` text,
	`decided_by` text,
	`decided_at` text,
	`accept_mode` text,
	`protest_status` text,
	`protest_basis` text,
	`protest_reason` text,
	`protested_by` text,
	`protested_at` text,
	`protest_decision_note` text,
	`protest_decided_by` text,
	`protest_decided_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidenced_pair_id`) REFERENCES `connector_evidenced_pairs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submitter_vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submitted_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decided_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`protested_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`protest_decided_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sync_service_pair_contests_anchor_check" CHECK((("integration_id" IS NOT NULL) + ("evidenced_pair_id" IS NOT NULL)) = 1),
	CONSTRAINT "sync_service_pair_contests_kind_check" CHECK("kind" IN ('existence', 'data_flow')),
	CONSTRAINT "sync_service_pair_contests_claim_check" CHECK(("kind" = 'data_flow') = ("claim_id" IS NOT NULL)),
	CONSTRAINT "sync_service_pair_contests_direction_check" CHECK("proposed_direction" IS NULL OR "proposed_direction" IN ('a_to_b', 'b_to_a', 'both')),
	CONSTRAINT "sync_service_pair_contests_routed_check" CHECK("routed_to" IN ('owner', 'aeci')),
	CONSTRAINT "sync_service_pair_contests_status_check" CHECK("status" IN ('open', 'accepted', 'declined', 'withdrawn')),
	CONSTRAINT "sync_service_pair_contests_protest_status_check" CHECK("protest_status" IS NULL OR "protest_status" IN ('open', 'upheld', 'rejected', 'withdrawn')),
	CONSTRAINT "sync_service_pair_contests_protest_basis_check" CHECK("protest_basis" IS NULL OR "protest_basis" IN ('declined', 'silence'))
);
--> statement-breakpoint
CREATE INDEX `sync_service_pair_contests_integration_idx` ON `sync_service_pair_contests` (`integration_id`);--> statement-breakpoint
CREATE INDEX `sync_service_pair_contests_pair_idx` ON `sync_service_pair_contests` (`evidenced_pair_id`);--> statement-breakpoint
CREATE INDEX `sync_service_pair_contests_claim_idx` ON `sync_service_pair_contests` (`claim_id`);--> statement-breakpoint
CREATE INDEX `sync_service_pair_contests_submitter_idx` ON `sync_service_pair_contests` (`submitter_vendor_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `sync_service_pair_contests_owner_idx` ON `sync_service_pair_contests` (`owner_vendor_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `sync_service_pair_contests_status_idx` ON `sync_service_pair_contests` (`status`,`routed_to`,`created_at`);--> statement-breakpoint
CREATE TABLE `sync_service_pair_vetoes` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text,
	`evidenced_pair_id` text,
	`connector_product_id` text NOT NULL,
	`product_a_id` text NOT NULL,
	`product_b_id` text NOT NULL,
	`vendor_id` text,
	`vendor_name` text,
	`reason` text NOT NULL,
	`filed_by` text,
	`filed_at` text NOT NULL,
	`ended_at` text,
	`ended_how` text,
	`ended_by` text,
	`end_note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`evidenced_pair_id`) REFERENCES `connector_evidenced_pairs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`connector_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_a_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_b_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`filed_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ended_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sync_service_pair_vetoes_anchor_check" CHECK(("integration_id" IS NULL) OR ("evidenced_pair_id" IS NULL)),
	CONSTRAINT "sync_service_pair_vetoes_order_check" CHECK("product_a_id" < "product_b_id"),
	CONSTRAINT "sync_service_pair_vetoes_ended_how_check" CHECK("ended_how" IS NULL OR "ended_how" IN ('withdrawn', 'lifted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_service_pair_vetoes_open_key` ON `sync_service_pair_vetoes` (`connector_product_id`,`product_a_id`,`product_b_id`,`vendor_id`) WHERE "ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX `sync_service_pair_vetoes_key_idx` ON `sync_service_pair_vetoes` (`connector_product_id`,`product_a_id`,`product_b_id`);--> statement-breakpoint
CREATE INDEX `sync_service_pair_vetoes_integration_idx` ON `sync_service_pair_vetoes` (`integration_id`);--> statement-breakpoint
CREATE INDEX `sync_service_pair_vetoes_pair_idx` ON `sync_service_pair_vetoes` (`evidenced_pair_id`);--> statement-breakpoint
CREATE INDEX `sync_service_pair_vetoes_vendor_idx` ON `sync_service_pair_vetoes` (`vendor_id`,`updated_at`);--> statement-breakpoint
ALTER TABLE `connector_evidenced_pairs` ADD `vetoed_at` text;--> statement-breakpoint
ALTER TABLE `integrations` ADD `vetoed_at` text;
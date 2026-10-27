CREATE INDEX `attestations_claim_idx` ON `attestations` (`claim_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `claims_integration_idx` ON `claims` (`integration_id`) WHERE "integration_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `claims_evidenced_pair_idx` ON `claims` (`connector_evidenced_pair_id`) WHERE "connector_evidenced_pair_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `claims_connector_pair_idx` ON `claims` (`connector_pair_id`) WHERE "connector_pair_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `page_views_created_at_idx` ON `page_views` (`created_at`);--> statement-breakpoint
CREATE INDEX `page_views_vendor_idx` ON `page_views` (`vendor_id`,`created_at`) WHERE "vendor_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `page_views_asn_idx` ON `page_views` (`cf_asn`);--> statement-breakpoint
CREATE INDEX `recrawl_queue_causes_vendor_audit_idx` ON `recrawl_queue_causes` (`vendor_id`,`audit_log_id`);
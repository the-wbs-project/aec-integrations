CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`actor_type` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`before_state` text,
	`after_state` text,
	`metadata` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "audit_log_actor_type_check" CHECK("actor_type" IN ('user', 'admin', 'system', 'workflow')),
	CONSTRAINT "audit_log_entity_type_check" CHECK("entity_type" IN ('product', 'vendor', 'category', 'audience', 'phase', 'integration'))
);
--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_action_idx` ON `audit_log` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_created_at_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor_id`,`created_at`) WHERE "actor_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`features` text,
	`tools` text,
	`email` text,
	`subscribed` integer DEFAULT false NOT NULL,
	`country` text,
	`city` text,
	`region` text,
	`timezone` text,
	`referrer` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `health_check` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`source_product_id` text NOT NULL,
	`target_product_id` text NOT NULL,
	`mechanism_kind` text,
	`mechanism_name` text,
	`direction` text,
	`built_by_vendor_id` text,
	`powered_by_product_id` text,
	`description` text,
	`listing_url` text,
	`docs_url` text,
	`website` text,
	`mechanism_url` text,
	`pricing_model` text,
	`maturity` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`built_by_vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`powered_by_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "integrations_mechanism_kind_check" CHECK("mechanism_kind" IN ('native', 'iPaaS', 'marketplace-app', 'api', 'webhook', 'partner')),
	CONSTRAINT "integrations_direction_check" CHECK("direction" IN ('one-way', 'bidirectional')),
	CONSTRAINT "integrations_distinct_endpoints_check" CHECK("source_product_id" <> "target_product_id")
);
--> statement-breakpoint
CREATE INDEX `integrations_source_idx` ON `integrations` (`source_product_id`);--> statement-breakpoint
CREATE INDEX `integrations_target_idx` ON `integrations` (`target_product_id`);--> statement-breakpoint
CREATE INDEX `integrations_mechanism_kind_idx` ON `integrations` (`mechanism_kind`);--> statement-breakpoint
CREATE INDEX `integrations_updated_at_idx` ON `integrations` (`updated_at`);--> statement-breakpoint
CREATE INDEX `integrations_built_by_idx` ON `integrations` (`built_by_vendor_id`) WHERE "built_by_vendor_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `integrations_powered_by_idx` ON `integrations` (`powered_by_product_id`) WHERE "powered_by_product_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `mailing_list` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`country` text,
	`city` text,
	`region` text,
	`timezone` text,
	`as_organization` text,
	`asn` integer,
	`metro_code` integer,
	`utm_source` text,
	`utm_medium` text,
	`utm_campaign` text,
	`referrer` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailing_list_email_key` ON `mailing_list` (`email`);--> statement-breakpoint
CREATE TABLE `page_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`product_id` text,
	`vendor_id` text,
	`user_id` text,
	`session_id` text,
	`referrer` text,
	`cf_country` text,
	`cf_colo` text,
	`cf_asn` integer,
	`cf_bot_score` integer,
	`user_agent_hash` text,
	`locale` text,
	`profile_role` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `page_views_path_idx` ON `page_views` (`path`,`created_at`);--> statement-breakpoint
CREATE INDEX `page_views_country_idx` ON `page_views` (`cf_country`,`created_at`);--> statement-breakpoint
CREATE INDEX `page_views_product_idx` ON `page_views` (`product_id`,`created_at`) WHERE "product_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `page_views_user_idx` ON `page_views` (`user_id`,`created_at`) WHERE "user_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `product_audiences` (
	`product_id` text NOT NULL,
	`audience_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`product_id`, `audience_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audience_id`) REFERENCES `taxonomy_audiences`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_audiences_audience_idx` ON `product_audiences` (`audience_id`);--> statement-breakpoint
CREATE TABLE `product_categories` (
	`product_id` text NOT NULL,
	`category_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`product_id`, `category_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `taxonomy_categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_categories_category_idx` ON `product_categories` (`category_id`);--> statement-breakpoint
CREATE TABLE `product_extensions` (
	`product_id` text NOT NULL,
	`host_product_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`product_id`, `host_product_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_extensions_distinct_check" CHECK("product_id" <> "host_product_id")
);
--> statement-breakpoint
CREATE INDEX `product_extensions_host_idx` ON `product_extensions` (`host_product_id`);--> statement-breakpoint
CREATE TABLE `product_phases` (
	`product_id` text NOT NULL,
	`phase_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`product_id`, `phase_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`phase_id`) REFERENCES `taxonomy_phases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_phases_phase_idx` ON `product_phases` (`phase_id`);--> statement-breakpoint
CREATE TABLE `product_vendors` (
	`product_id` text NOT NULL,
	`vendor_id` text NOT NULL,
	`is_primary` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`product_id`, `vendor_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_vendors_vendor_idx` ON `product_vendors` (`vendor_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`website` text,
	`tool_integrations_url` text,
	`api_docs_url` text,
	`has_api_docs` integer DEFAULT false NOT NULL,
	`tool_integration_check_notes` text,
	`usefulness` text,
	`product_role` text DEFAULT 'application' NOT NULL,
	`logo_url` text,
	`integration_count` integer DEFAULT 0 NOT NULL,
	`review_count` integer DEFAULT 0 NOT NULL,
	`rating_overall_avg` real,
	`rating_onboarding_avg` real,
	`research_status` text DEFAULT 'pending' NOT NULL,
	`research_notes` text,
	`promotion_status` text DEFAULT 'pending' NOT NULL,
	`priority_tier` text,
	`priority_score` real,
	`score_computed_at` text,
	`google_trends_index` integer,
	`search_volume_monthly` integer,
	`search_checked_at` text,
	`reddit_mentions_24mo` integer,
	`reddit_checked_at` text,
	`admin_notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "products_product_role_check" CHECK("product_role" IN ('application', 'connector', 'hybrid')),
	CONSTRAINT "products_research_status_check" CHECK("research_status" IN ('pending', 'in_progress', 'done', 'blocked')),
	CONSTRAINT "products_promotion_status_check" CHECK("promotion_status" IN ('pending', 'ready', 'promoted', 'retracted', 'rejected')),
	CONSTRAINT "products_priority_tier_check" CHECK("priority_tier" IN ('tier_1', 'tier_2', 'tier_3', 'tier_4', 'tier_5')),
	CONSTRAINT "products_google_trends_check" CHECK("google_trends_index" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_key` ON `products` (`slug`);--> statement-breakpoint
CREATE INDEX `products_name_idx` ON `products` (`name`);--> statement-breakpoint
CREATE INDEX `products_promotion_status_idx` ON `products` (`promotion_status`);--> statement-breakpoint
CREATE INDEX `products_research_status_idx` ON `products` (`research_status`);--> statement-breakpoint
CREATE INDEX `products_priority_tier_idx` ON `products` (`priority_tier`);--> statement-breakpoint
CREATE INDEX `products_product_role_idx` ON `products` (`product_role`);--> statement-breakpoint
CREATE INDEX `products_updated_at_idx` ON `products` (`updated_at`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text,
	`role` text DEFAULT 'reviewer' NOT NULL,
	`vendor_id` text,
	`work_email_verified` integer DEFAULT false NOT NULL,
	`trust_tier` text DEFAULT 'standard' NOT NULL,
	`theme_preference` text DEFAULT 'system' NOT NULL,
	`banned_at` text,
	`ban_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "profiles_role_check" CHECK("role" IN ('reviewer', 'admin', 'vendor_admin')),
	CONSTRAINT "profiles_trust_tier_check" CHECK("trust_tier" IN ('standard', 'verified', 'trusted')),
	CONSTRAINT "profiles_theme_preference_check" CHECK("theme_preference" IN ('system', 'light', 'dark'))
);
--> statement-breakpoint
CREATE INDEX `profiles_role_idx` ON `profiles` (`role`);--> statement-breakpoint
CREATE INDEX `profiles_vendor_idx` ON `profiles` (`vendor_id`) WHERE "vendor_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `profiles_banned_idx` ON `profiles` (`banned_at`) WHERE "banned_at" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`reviewer_id` text,
	`rating_overall` integer NOT NULL,
	`rating_onboarding` integer NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`role_at_company` text,
	`years_using` integer,
	`would_recommend` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`rejection_reason` text,
	`moderated_at` text,
	`moderated_by` text,
	`toxicity_score` integer,
	`verified_work_email` integer DEFAULT false NOT NULL,
	`locale` text DEFAULT 'en-US' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`moderated_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reviews_rating_overall_check" CHECK("rating_overall" BETWEEN 1 AND 5),
	CONSTRAINT "reviews_rating_onboarding_check" CHECK("rating_onboarding" BETWEEN 1 AND 5),
	CONSTRAINT "reviews_role_at_company_check" CHECK("role_at_company" IN ('practitioner', 'manager', 'IT', 'exec', 'other')),
	CONSTRAINT "reviews_would_recommend_check" CHECK("would_recommend" IN ('yes', 'no', 'maybe')),
	CONSTRAINT "reviews_status_check" CHECK("status" IN ('pending', 'approved', 'rejected', 'archived'))
);
--> statement-breakpoint
CREATE INDEX `reviews_product_status_idx` ON `reviews` (`product_id`,`status`);--> statement-breakpoint
CREATE INDEX `reviews_status_created_idx` ON `reviews` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `reviews_reviewer_idx` ON `reviews` (`reviewer_id`) WHERE "reviewer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_unique_per_user_product` ON `reviews` (`product_id`,`reviewer_id`) WHERE "reviewer_id" IS NOT NULL AND "status" <> 'archived';--> statement-breakpoint
CREATE TABLE `stats_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`computed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `taxonomy_audiences` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`display_order` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_audiences_slug_key` ON `taxonomy_audiences` (`slug`);--> statement-breakpoint
CREATE TABLE `taxonomy_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`display_order` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_categories_slug_key` ON `taxonomy_categories` (`slug`);--> statement-breakpoint
CREATE TABLE `taxonomy_phases` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`display_order` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_phases_slug_key` ON `taxonomy_phases` (`slug`);--> statement-breakpoint
CREATE TABLE `translations` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`locale` text NOT NULL,
	`field` text NOT NULL,
	`value` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `translations_entity_type_entity_id_locale_field_key` ON `translations` (`entity_type`,`entity_id`,`locale`,`field`);--> statement-breakpoint
CREATE INDEX `translations_lookup_idx` ON `translations` (`entity_type`,`entity_id`,`locale`);--> statement-breakpoint
CREATE TABLE `vendor_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`submitter_email` text NOT NULL,
	`submitter_name` text,
	`submitter_role` text,
	`domain_match` text DEFAULT 'pending' NOT NULL,
	`body` text NOT NULL,
	`source_url` text,
	`status` text DEFAULT 'open' NOT NULL,
	`linear_issue_id` text,
	`duplicate_of_request_id` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	FOREIGN KEY (`resolved_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`duplicate_of_request_id`) REFERENCES `vendor_requests`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "vendor_requests_kind_check" CHECK("kind" IN ('claim', 'correction')),
	CONSTRAINT "vendor_requests_target_type_check" CHECK("target_type" IN ('product', 'vendor')),
	CONSTRAINT "vendor_requests_domain_match_check" CHECK("domain_match" IN ('pending', 'match', 'no_match', 'manual_review')),
	CONSTRAINT "vendor_requests_status_check" CHECK("status" IN ('open', 'in_review', 'resolved', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `vendor_requests_status_idx` ON `vendor_requests` (`status`);--> statement-breakpoint
CREATE INDEX `vendor_requests_target_idx` ON `vendor_requests` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `vendor_requests_created_at_idx` ON `vendor_requests` (`created_at`);--> statement-breakpoint
CREATE TABLE `vendors` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`company_name` text NOT NULL,
	`description` text,
	`website` text,
	`headquarters` text,
	`founded_year` integer,
	`public_private` text,
	`parent_company` text,
	`linkedin_url` text,
	`x_url` text,
	`facebook_url` text,
	`instagram_url` text,
	`youtube_url` text,
	`crunchbase_url` text,
	`wiki_url` text,
	`source_url` text,
	`github_org` text,
	`phone_number` text,
	`contact_email` text,
	`logo_url` text,
	`verified` integer DEFAULT false NOT NULL,
	`promotion_status` text DEFAULT 'pending' NOT NULL,
	`admin_notes` text,
	`vqs_credibility` real,
	`vqs_momentum` real,
	`vqs_fit` real,
	`vqs_total` real,
	`vqs_computed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "vendors_public_private_check" CHECK("public_private" IN ('public', 'private')),
	CONSTRAINT "vendors_promotion_status_check" CHECK("promotion_status" IN ('pending', 'ready', 'promoted', 'retracted', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_slug_key` ON `vendors` (`slug`);--> statement-breakpoint
CREATE INDEX `vendors_company_name_idx` ON `vendors` (`company_name`);--> statement-breakpoint
CREATE INDEX `vendors_promotion_status_idx` ON `vendors` (`promotion_status`);--> statement-breakpoint
CREATE INDEX `vendors_verified_idx` ON `vendors` (`verified`);--> statement-breakpoint
CREATE INDEX `vendors_updated_at_idx` ON `vendors` (`updated_at`);--> statement-breakpoint
CREATE TABLE `workflow_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`current_state` text NOT NULL,
	`linear_issue_id` text,
	`initiated_by` text,
	`initiated_at` text NOT NULL,
	`completed_at` text,
	`final_outcome` text,
	FOREIGN KEY (`initiated_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workflow_instances_type_check" CHECK("workflow_type" IN ('vendor_claim', 'review_moderation', 'correction_request')),
	CONSTRAINT "workflow_instances_final_outcome_check" CHECK("final_outcome" IN ('approved', 'rejected', 'cancelled', 'completed'))
);
--> statement-breakpoint
CREATE INDEX `workflow_instances_type_entity_idx` ON `workflow_instances` (`workflow_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `workflow_instances_state_idx` ON `workflow_instances` (`workflow_type`,`current_state`) WHERE "completed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `workflow_instances_linear_idx` ON `workflow_instances` (`linear_issue_id`) WHERE "linear_issue_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `workflow_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`from_state` text,
	`to_state` text NOT NULL,
	`actor_id` text,
	`reason` text,
	`metadata` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflow_instances`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_transitions_workflow_idx` ON `workflow_transitions` (`workflow_id`,`created_at`);
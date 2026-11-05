ALTER TABLE `agreement_acceptances` ADD `signer_name` text;--> statement-breakpoint
ALTER TABLE `agreement_acceptances` ADD `signer_title` text;--> statement-breakpoint
ALTER TABLE `agreement_acceptances` ADD `company_legal_name` text;--> statement-breakpoint
ALTER TABLE `listing_requests` ADD `submitter_title` text;--> statement-breakpoint
ALTER TABLE `listing_requests` ADD `company_legal_name` text;--> statement-breakpoint
ALTER TABLE `vendor_requests` ADD `submitter_title` text;--> statement-breakpoint
ALTER TABLE `vendor_requests` ADD `company_legal_name` text;
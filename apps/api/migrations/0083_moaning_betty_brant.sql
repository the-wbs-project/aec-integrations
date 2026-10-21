-- AECI-1415 (E6b.3): record ownership is stored (ADR 0042). `vendors.owned_at` is
-- non-null while the vendor owns its record, its products and the integrations it
-- owns. The ADD COLUMN is drizzle-kit's, unedited. A plain ADD COLUMN, not a table
-- recreate: no CHECK changes, so no implicit DELETE and no ON DELETE cascade
-- (`docs/migrations.md` §0). `src/test/migration-0083.spec.ts` is the tripwire.
--
-- The backfill below is hand-written. It marks every vendor that holds at least one
-- `profiles.role = 'vendor_admin'` seat with that `vendor_id`, banned or not (ruled
-- 2026-10-19: under Q1 a ban never moves ownership, so a ban must not decide it). The stamp is
-- the earliest seat-grant audit row for the vendor (a claim grant, an admin
-- provision or an invite redeem), matched on the `vendor_id` column or, for rows
-- written before AECI-1192, the metadata key. With no such row it is the migration
-- time.
ALTER TABLE `vendors` ADD `owned_at` text;--> statement-breakpoint
UPDATE `vendors`
SET `owned_at` = COALESCE(
  (
    SELECT MIN(`audit_log`.`created_at`)
    FROM `audit_log`
    WHERE `audit_log`.`action` IN ('vendor_claim.granted', 'vendor_seat.provisioned', 'vendor_seat.invite_accepted')
      AND (
        `audit_log`.`vendor_id` = `vendors`.`id`
        OR (
          json_valid(`audit_log`.`metadata`)
          AND `vendors`.`id` IN (
            json_extract(`audit_log`.`metadata`, '$.vendorId'),
            json_extract(`audit_log`.`metadata`, '$.vendor_id')
          )
        )
      )
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
WHERE `owned_at` IS NULL
  AND EXISTS (
    SELECT 1 FROM `profiles`
    WHERE `profiles`.`vendor_id` = `vendors`.`id`
      AND `profiles`.`role` = 'vendor_admin'
  );

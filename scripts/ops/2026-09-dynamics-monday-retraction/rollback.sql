-- Rollback for the AECI-795 microsoft-dynamics-365 → monday-com retraction.
-- Replay order is parent -> child so the FKs hold; INSERT OR IGNORE makes re-runs safe.
-- integrations: 1, claims: 1, attestations: 1
-- `claims.anchor_id` is omitted on purpose: it is a STORED generated column (AECI-721)
-- and SQLite refuses an INSERT that supplies it.
-- Recreating the rows does NOT restore integration_count: re-run
--   RECONCILE_ENV=<env> pnpm --filter @aeci/api db:reconcile-counts -- --fix --allow-production
-- and note that replaying this recreates the STRANDED state, not curator control —
-- no upstream record has ever carried this uuid, so there is nothing to restore it to.
-- If the edge turns out to be real, re-materialise it upstream with current evidence
-- and promote it, rather than replaying this file.
INSERT OR IGNORE INTO "integrations" ("id","name","source_product_id","target_product_id","mechanism_kind","mechanism_name","direction","built_by_vendor_id","powered_by_product_id","description","listing_url","docs_url","website","mechanism_url","pricing_model","maturity","notes","last_reviewed_at","maintained_by","created_at","updated_at") VALUES ('2e6ad5bf-5590-4222-9710-23d43a625f12','monday.com (ipaas)','e9810a7e-8d2c-45df-9163-8d0619768578','d7ac888b-2a51-4ebf-ba22-17a0b0331f5b','iPaaS','Zapier connector','bidirectional',NULL,NULL,NULL,'https://zapier.com/apps/microsoft-dynamics-crm/integrations/monday',NULL,NULL,NULL,NULL,NULL,'sources=ipaas | evidence=https://zapier.com/apps/microsoft-dynamics-crm/integrations/monday | notes=Microsoft Dynamics 365 CRM + monday.com integration on Zapier',NULL,'aeci','2026-07-25T15:45:54.139Z','2026-08-27T09:48:19.054Z');
INSERT OR IGNORE INTO "claims" ("id","integration_id","connector_evidenced_pair_id","data_object_id","direction","origin","created_by_vendor_id","created_at","updated_at") VALUES ('aeda3a66-fc2d-4339-a817-a0f616cc933c','2e6ad5bf-5590-4222-9710-23d43a625f12',NULL,'da30093b-e634-5687-84ed-bdb2addeb8aa','both','aeci',NULL,'2026-08-27T09:48:19.054Z','2026-08-27T09:48:19.054Z');
INSERT OR IGNORE INTO "attestations" ("id","claim_id","source","asserted","introduced_at","deprecated_at","note","created_at","updated_at","retracted_at","attested_by_vendor_id","introduced_version_id","deprecated_version_id") VALUES ('6e90969b-d0ce-496d-a354-bcf607a677ee','aeda3a66-fc2d-4339-a817-a0f616cc933c','aeci',1,NULL,NULL,'ai_seed: Dynamics 365 CRM ↔ monday.com via Zapier syncs CRM contact/account records into monday items — https://zapier.com/apps/microsoft-dynamics-crm/integrations/monday','2026-08-27T09:48:19.054Z','2026-08-27T09:48:19.054Z',NULL,NULL,NULL,NULL);

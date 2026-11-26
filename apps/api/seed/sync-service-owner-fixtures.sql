-- Sync Service owner-flow fixture (AECI-2039, STAGE_2_ATTESTATIONS_SPEC.md §14.10).
--
-- Applied by `db:seed:local` after `connector-fixtures.sql` (the pair) and
-- `data-objects.sql` (the vocabulary). A file of its own because several specs apply
-- `connector-fixtures.sql` alone, without the vocabulary, and because a claimed pair is
-- vendor-held: the retraction specs that read that file expect `fx-evp-3` unclaimed.
--
-- ---------------------------------------------------------------------------
-- AECI-2039: the owner of a Sync Service pair confirms its flows. `fx-evp-3`
-- (Procore and Viewpoint Vista through Agave) is claimed by its builder, Agave Inc.,
-- and carries three flows, one per state the public page draws:
--
--   * Budgets, seeded by AEC Integrations and confirmed by the owner: "Confirmed by
--     Agave Inc. (fixture), which offers this integration".
--   * Cost Codes, seeded and then removed by the owner (a No): absent from every
--     public read, the pair page, the product pages, the connector page, the
--     alternatives lanes and the timeline.
--   * Projects & Jobs, added by the owner (a vendor claim with no attestation) and
--     confirmed.
--
-- The claim stamp is an UPDATE because the pair INSERT in `connector-fixtures.sql` is
-- `DO NOTHING` on a re-seed. The rest is keyed on fixed ids, so a re-seed changes nothing.
-- ---------------------------------------------------------------------------
UPDATE connector_evidenced_pairs
  SET claimed_at = '2026-11-01T00:00:00.000Z', maintained_by = 'vendor'
  WHERE id = '00000000-0000-4000-8000-0000000008a3' AND claimed_at IS NULL;
INSERT INTO claims (id, connector_evidenced_pair_id, data_object_id, direction, origin, created_by_vendor_id, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-0000000008c1','00000000-0000-4000-8000-0000000008a3','32a8cbf5-7bde-5fea-ada9-4ae7a3dea1eb','a_to_b','aeci',NULL,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000008c2','00000000-0000-4000-8000-0000000008a3','8ad70643-8635-5859-ae78-856517b78ece','a_to_b','aeci',NULL,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000008c3','00000000-0000-4000-8000-0000000008a3','d0a80355-d3b7-5a7c-8e35-7246437edf68','both','vendor','00000000-0000-4000-8000-000000000795','2026-11-02T00:00:00.000Z','2026-11-02T00:00:00.000Z')
ON CONFLICT (id) DO NOTHING;
INSERT INTO attestations (id, claim_id, source, asserted, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-0000000008d1','00000000-0000-4000-8000-0000000008c1','aeci',1,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000008d2','00000000-0000-4000-8000-0000000008c2','aeci',1,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')
ON CONFLICT (id) DO NOTHING;
INSERT INTO claim_owner_answers (id, claim_id, vendor_id, asserted, retracted_at, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-0000000008e1','00000000-0000-4000-8000-0000000008c1','00000000-0000-4000-8000-000000000795',1,NULL,'2026-11-02T00:00:00.000Z','2026-11-02T00:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000008e2','00000000-0000-4000-8000-0000000008c2','00000000-0000-4000-8000-000000000795',0,NULL,'2026-11-02T00:00:00.000Z','2026-11-02T00:00:00.000Z'),
  ('00000000-0000-4000-8000-0000000008e3','00000000-0000-4000-8000-0000000008c3','00000000-0000-4000-8000-000000000795',1,NULL,'2026-11-02T00:00:00.000Z','2026-11-02T00:00:00.000Z')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- AECI-2046: Agave's three curated Sync Service facts, so its "What it syncs" block
-- renders locally with all three (ruling 15 on AECI-2035, STAGE_1_5_SPEC.md §13.13).
-- AECi curates them. An UPDATE, as the kind is, because the product INSERT is
-- `DO NOTHING` on a re-seed.
-- ---------------------------------------------------------------------------
UPDATE products
  SET sync_frequency = 'Every 15 minutes, and on demand from either product',
      sync_support = 'Agave Inc. (fixture) supports the sync, by email and chat',
      sync_setup = 'Agave connects both accounts in a guided setup call, usually under an hour',
      sync_facts_source_url = 'https://example.com/agave/sync',
      sync_facts_recorded_at = '2026-11-20T00:00:00.000Z'
  WHERE id = '00000000-0000-4000-8000-000000000791';

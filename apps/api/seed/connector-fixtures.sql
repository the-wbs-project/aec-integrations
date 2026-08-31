-- =============================================================================
-- Connector-lane fixtures for Cloudflare D1 (AECI-722).
--
-- WHY THIS FILE EXISTS
--   AECI-714 landed the six connector tables and the paged sync that fills them,
--   but the SENDER is AECI-731 and it is unbuilt — so `connector_*` is empty in
--   every environment, and `/admin/connectors` would render nothing anywhere.
--   These fixtures are what make the screen developable and testable before the
--   feed exists. They are the connector-lane equivalent of phase2-fixtures.sql.
--
--   ⚠️  TEST FIXTURES — dev / CI only. Real rows arrive exclusively through
--   `POST /api/promote/connector-catalog` (DATABASE_SCHEMA.md §9a: "Rows arrive
--   only through POST /api/promote/connector-catalog. Nothing else writes them").
--   Nothing here writes `connector_evidenced_pairs`: AECI-714 creates it EMPTY
--   and AECI-721 fills it, so an empty delivered lane is the honest local state
--   and the screen must render it as such rather than as a measured zero.
--
-- REPRESENTATIVE, NOT LARGE
--   Two catalogues and ~40 stubs, not MindCloud's 3,573. The point is to cover
--   every state the screen has to draw, once each:
--     * undecided stubs (NO mapping row — §9a.4's "the absence of a row is pending")
--     * an `auto-name-match` proposal at HIGH confidence  → NOT publishable
--     * a human decision at LOW confidence                → publishable
--     * all three decision statuses (out_of_scope / no_record / ambiguous_parked)
--     * `ruled_out`, so the auto pass does not re-propose the same wrong product
--     * a tombstoned stub (`removed_at`)
--     * `actions IS NULL` (never fetched) beside a fetched one
--     * one stub mapping to TWO products (§9a.4's many-to-many)
--     * `curated`, `generated` and `unknown` pairs
--     * one `review`-managed and one `vendor`-managed catalogue, the latter with
--       the audit row that AECI-720's flip writes — which is the ONLY record of
--       who a catalogue was handed to, and what the handover block reads back
--
-- CONTRACT
--   * Idempotent: every insert is `ON CONFLICT DO NOTHING`, matching catalog.sql.
--   * `connector_product_id` is NOT NULL, so both catalogues need a promoted
--     connector-role product; they are created here rather than assumed.
--   * Ids are the review app's own record ids on all five projected tables
--     (§9a), so they are readable strings, NOT uuids. Only `products`/`vendors`
--     refs are uuids.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Endpoint products the stubs map onto. Applications, so the connector pages
-- have something real to point at.
-- ---------------------------------------------------------------------------

INSERT INTO products (id, slug, name, description, website, product_role, has_api_docs, research_status, promotion_status, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000800','fx-procore','Procore','Connector-lane fixture endpoint product.','https://example.com/procore','application',1,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000801','fx-autodesk-build','Autodesk Build','Connector-lane fixture endpoint product.','https://example.com/autodesk-build','application',1,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000802','fx-bluebeam-revu','Bluebeam Revu','Connector-lane fixture endpoint product.','https://example.com/bluebeam-revu','application',1,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000803','fx-sage-intacct','Sage Intacct','Connector-lane fixture endpoint product.','https://example.com/sage-intacct','application',1,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000804','fx-quickbooks-online','QuickBooks Online','Connector-lane fixture endpoint product.','https://example.com/quickbooks-online','application',1,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000805','fx-viewpoint-vista','Viewpoint Vista','Connector-lane fixture endpoint product.','https://example.com/viewpoint-vista','application',1,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000806','fx-plangrid','PlanGrid','Connector-lane fixture endpoint product.','https://example.com/plangrid','application',1,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000807','fx-bim-360','BIM 360','Connector-lane fixture endpoint product.','https://example.com/bim-360','application',1,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000808','fx-fieldwire','Fieldwire','Connector-lane fixture endpoint product.','https://example.com/fieldwire','application',1,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000809','fx-raken','Raken','Connector-lane fixture endpoint product.','https://example.com/raken','application',1,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The two connector platforms. `product_role = 'connector'` is what makes them
-- eligible to own a catalogue at all.
-- ---------------------------------------------------------------------------
INSERT INTO products (id, slug, name, description, website, product_role, has_api_docs, research_status, promotion_status, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000790','fx-mindcloud','MindCloud (fixture)','Connector-lane fixture: an iPaaS whose catalogue AECi mirrors in full.','https://example.com/mindcloud','connector',1,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000791','fx-agave','Agave (fixture)','Connector-lane fixture: a second catalogue, handed over to its vendor so the frozen-lane state is renderable.','https://example.com/agave','connector',1,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT (slug) DO NOTHING;

-- A vendor for the handover to name. AECI-720's `vendorId` is validated against
-- `vendors` rather than trusted, so a fixture handover needs a real row.
INSERT INTO vendors (id, slug, company_name, website, verified, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-000000000795','fx-agave-inc','Agave Inc. (fixture)','https://example.com/agave',0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Catalogues. One per management state, so both branches of the flip control and
-- both halves of the promote refusal are visible locally.
-- ---------------------------------------------------------------------------
INSERT INTO connector_catalogs (id, connector_product_id, connector_authorship, managed_by, notes, created_at, updated_at) VALUES
  ('fx-cat-mindcloud','00000000-0000-4000-8000-000000000790','platform','review','Fixture catalogue. Review-managed, so the promote lane is open for it.', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-cat-agave','00000000-0000-4000-8000-000000000791','mixed','vendor','Fixture catalogue. Vendor-managed, so POST /api/promote/connector-catalog refuses its pages with CATALOG_VENDOR_MANAGED.', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT (id) DO NOTHING;

-- The handover audit row. AECI-720 persists `vendor_id` and `reason` ONLY here —
-- nothing lands on `connector_catalogs` — so without this row the detail screen's
-- handover block has nothing to derive from.
INSERT INTO audit_log (id, actor_id, actor_type, action, entity_type, entity_id, before_state, after_state, metadata, created_at) VALUES
  ('00000000-0000-4000-8000-000000000796', NULL, 'system', 'connector_catalog.managed_by_vendor', 'connector_catalog', 'fx-cat-agave', '{"managed_by":"review"}', '{"managed_by":"vendor"}', '{"source":"admin-connector-catalog","connector_product_id":"00000000-0000-4000-8000-000000000791","vendor_id":"00000000-0000-4000-8000-000000000795","reason":"Fixture handover, partnership track.","review_lane_frozen":true,"seat_not_granted":true}', '2026-08-30T10:00:00.000Z')
ON CONFLICT (id) DO NOTHING;

-- A sync run row, so the audit trail shows the freshness half of the §8.9(4)
-- duty beside the handover half rather than only the handover.
INSERT INTO audit_log (id, actor_id, actor_type, action, entity_type, entity_id, before_state, after_state, metadata, created_at) VALUES
  ('00000000-0000-4000-8000-000000000797', NULL, 'system', 'connector_catalog.synced', 'connector_catalog', 'fx-cat-mindcloud', NULL, NULL, '{"source":"promote-connector-catalog"}', '2026-08-29T02:00:00.000Z')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Surfaces. `last_ingested_at` is the per-surface "as of" stamp §13.1 requires
-- and the freshness signal §8.9(4) makes this screen answerable for. One surface
-- is deliberately never-ingested, so MAX() has a NULL to skip over.
-- ---------------------------------------------------------------------------
INSERT INTO connector_catalog_surfaces (id, catalog_id, surface_role, index_kind, index_url, last_ingested_at, notes, created_at, updated_at) VALUES
  ('fx-surf-mc-apps','fx-cat-mindcloud','apps','sitemap','https://example.com/mindcloud/apps.xml','2026-08-29T02:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-surf-mc-pairs','fx-cat-mindcloud','pairs','sitemap','https://example.com/mindcloud/pairs.xml','2026-08-27T02:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-surf-ag-all','fx-cat-agave','all','json_api','https://example.com/agave/catalog.json',NULL,'Never ingested — MAX(last_ingested_at) must skip this rather than report it.', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Stubs. Every listing in a catalogue, INCLUDING the ones that match nothing —
-- that set IS the triage queue (§9a.3).
-- ---------------------------------------------------------------------------

INSERT INTO connector_stubs (id, catalog_id, slug, label, url, direction_role, action_count, actions, actions_hash, actions_fetched_at, previous_labels, meta, first_seen_at, last_seen_at, removed_at, created_at, updated_at) VALUES
  ('fx-stub-mc-procore','fx-cat-mindcloud','procore','Procore','https://example.com/mindcloud/procore','source',NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-autodesk-build','fx-cat-mindcloud','autodesk-build','Autodesk Build','https://example.com/mindcloud/autodesk-build','destination',2,'[{"name":"create_record"},{"name":"update_record"}]',NULL,'2026-08-20T00:00:00.000Z',NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-bluebeam-revu','fx-cat-mindcloud','bluebeam-revu','Bluebeam Revu','https://example.com/mindcloud/bluebeam-revu','both',3,'[{"name":"create_record"},{"name":"update_record"}]',NULL,'2026-08-20T00:00:00.000Z',NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-sage-intacct','fx-cat-mindcloud','sage-intacct','Sage Intacct','https://example.com/mindcloud/sage-intacct','source',NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-quickbooks-online','fx-cat-mindcloud','quickbooks-online','QuickBooks Online','https://example.com/mindcloud/quickbooks-online','destination',5,'[{"name":"create_record"},{"name":"update_record"}]',NULL,'2026-08-20T00:00:00.000Z',NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-viewpoint-vista','fx-cat-mindcloud','viewpoint-vista','Viewpoint Vista','https://example.com/mindcloud/viewpoint-vista','both',1,'[{"name":"create_record"},{"name":"update_record"}]',NULL,'2026-08-20T00:00:00.000Z',NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-plangrid','fx-cat-mindcloud','plangrid','PlanGrid','https://example.com/mindcloud/plangrid','source',NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-bim-360','fx-cat-mindcloud','bim-360','BIM 360','https://example.com/mindcloud/bim-360','destination',3,'[{"name":"create_record"},{"name":"update_record"}]',NULL,'2026-08-20T00:00:00.000Z',NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-fieldwire','fx-cat-mindcloud','fieldwire','Fieldwire','https://example.com/mindcloud/fieldwire','both',4,'[{"name":"create_record"},{"name":"update_record"}]',NULL,'2026-08-20T00:00:00.000Z',NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-raken','fx-cat-mindcloud','raken','Raken','https://example.com/mindcloud/raken','source',NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-shopify','fx-cat-mindcloud','shopify','Shopify','https://example.com/mindcloud/shopify',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-stripe','fx-cat-mindcloud','stripe','Stripe','https://example.com/mindcloud/stripe',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-hubspot','fx-cat-mindcloud','hubspot','Hubspot','https://example.com/mindcloud/hubspot',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-salesforce','fx-cat-mindcloud','salesforce','Salesforce','https://example.com/mindcloud/salesforce',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-netsuite','fx-cat-mindcloud','netsuite','Netsuite','https://example.com/mindcloud/netsuite',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-zendesk','fx-cat-mindcloud','zendesk','Zendesk','https://example.com/mindcloud/zendesk',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-mailchimp','fx-cat-mindcloud','mailchimp','Mailchimp','https://example.com/mindcloud/mailchimp',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-twilio','fx-cat-mindcloud','twilio','Twilio','https://example.com/mindcloud/twilio',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-asana','fx-cat-mindcloud','asana','Asana','https://example.com/mindcloud/asana',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-monday-com','fx-cat-mindcloud','monday-com','Monday Com','https://example.com/mindcloud/monday-com',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-airtable','fx-cat-mindcloud','airtable','Airtable','https://example.com/mindcloud/airtable',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-notion','fx-cat-mindcloud','notion','Notion','https://example.com/mindcloud/notion',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-dropbox','fx-cat-mindcloud','dropbox','Dropbox','https://example.com/mindcloud/dropbox',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-box','fx-cat-mindcloud','box','Box','https://example.com/mindcloud/box',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-slack','fx-cat-mindcloud','slack','Slack','https://example.com/mindcloud/slack',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-jira','fx-cat-mindcloud','jira','Jira','https://example.com/mindcloud/jira',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-trello','fx-cat-mindcloud','trello','Trello','https://example.com/mindcloud/trello',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-github','fx-cat-mindcloud','github','Github','https://example.com/mindcloud/github',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-mc-retired','fx-cat-mindcloud','retired-app','Retired App','https://example.com/mindcloud/retired-app',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z','2026-08-15T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-ag-procore','fx-cat-agave','procore','Procore','https://example.com/agave/procore','both',3,'[{"name":"sync"}]',NULL,'2026-08-10T00:00:00.000Z',NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-ag-autodesk-build','fx-cat-agave','autodesk-build','Autodesk Build','https://example.com/agave/autodesk-build','both',3,'[{"name":"sync"}]',NULL,'2026-08-10T00:00:00.000Z',NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-ag-bluebeam-revu','fx-cat-agave','bluebeam-revu','Bluebeam Revu','https://example.com/agave/bluebeam-revu','both',3,'[{"name":"sync"}]',NULL,'2026-08-10T00:00:00.000Z',NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-ag-sage-intacct','fx-cat-agave','sage-intacct','Sage Intacct','https://example.com/agave/sage-intacct','both',3,'[{"name":"sync"}]',NULL,'2026-08-10T00:00:00.000Z',NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-ag-quickbooks-online','fx-cat-agave','quickbooks-online','QuickBooks Online','https://example.com/agave/quickbooks-online','both',3,'[{"name":"sync"}]',NULL,'2026-08-10T00:00:00.000Z',NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-stub-ag-viewpoint-vista','fx-cat-agave','viewpoint-vista','Viewpoint Vista','https://example.com/agave/viewpoint-vista','both',3,'[{"name":"sync"}]',NULL,'2026-08-10T00:00:00.000Z',NULL,NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Mappings. The publication gate is PROVENANCE, not confidence (§9a.4):
--   status = 'mapped' AND product_id IS NOT NULL
--            AND decided_by IS NOT NULL AND decided_by <> 'auto-name-match'
-- so the high-confidence auto rows below are deliberately NOT publishable and the
-- low-confidence human ones are. Getting that backwards is the single failure this
-- fixture exists to make visible.
--
-- NOTE the deliberate absences: 18 of the MindCloud stubs carry no mapping row at
-- all. That is what "undecided" means here — not a status.
-- ---------------------------------------------------------------------------

INSERT INTO connector_stub_mappings (id, stub_id, catalog_id, product_id, status, confidence, evidence_url, decided_by, decided_at, checked_at, notes, created_at, updated_at) VALUES
  ('fx-map-mc-1','fx-stub-mc-procore','fx-cat-mindcloud','00000000-0000-4000-8000-000000000800','mapped','low','https://example.com/evidence/procore','chris','2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z','Human decision at LOW confidence: publishable, because the gate is provenance.', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-map-mc-2','fx-stub-mc-sage-intacct','fx-cat-mindcloud','00000000-0000-4000-8000-000000000803','mapped','medium','https://example.com/evidence/sage','chris','2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-map-mc-3','fx-stub-mc-autodesk-build','fx-cat-mindcloud','00000000-0000-4000-8000-000000000801','mapped','high',NULL,'auto-name-match','2026-08-26T00:00:00.000Z','2026-08-25T00:00:00.000Z','Machine proposal at HIGH confidence: NOT publishable. Needs a human.', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-map-mc-4','fx-stub-mc-bluebeam-revu','fx-cat-mindcloud','00000000-0000-4000-8000-000000000802','mapped','high',NULL,'auto-name-match','2026-08-26T00:00:00.000Z','2026-08-25T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-map-mc-5','fx-stub-mc-plangrid','fx-cat-mindcloud','00000000-0000-4000-8000-000000000806','mapped','medium',NULL,'auto-name-match','2026-08-26T00:00:00.000Z','2026-08-25T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-map-mc-6','fx-stub-mc-quickbooks-online','fx-cat-mindcloud','00000000-0000-4000-8000-000000000804','ruled_out','high',NULL,'chris','2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z','Ruled out so the auto pass does not re-propose the same wrong product.', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-map-mc-7','fx-stub-mc-shopify','fx-cat-mindcloud',NULL,'out_of_scope',NULL,NULL,'chris','2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z','Not an AEC product.', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-map-mc-8','fx-stub-mc-stripe','fx-cat-mindcloud',NULL,'no_record',NULL,NULL,'chris','2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z','AEC-adjacent but we hold no product record.', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-map-mc-9','fx-stub-mc-hubspot','fx-cat-mindcloud',NULL,'ambiguous_parked',NULL,NULL,'chris','2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z','Several candidates; parked rather than guessed.', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-map-mc-10','fx-stub-mc-viewpoint-vista','fx-cat-mindcloud','00000000-0000-4000-8000-000000000805','mapped','high',NULL,'chris','2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z','One listing, two of our products (see the sibling row).', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-map-mc-11','fx-stub-mc-viewpoint-vista','fx-cat-mindcloud','00000000-0000-4000-8000-000000000808','mapped','medium',NULL,'chris','2026-08-25T00:00:00.000Z','2026-08-25T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-map-ag-1','fx-stub-ag-procore','fx-cat-agave','00000000-0000-4000-8000-000000000800','mapped','high','https://example.com/evidence/agave-procore','agave-vendor','2026-08-10T00:00:00.000Z','2026-08-25T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-map-ag-2','fx-stub-ag-sage-intacct','fx-cat-agave','00000000-0000-4000-8000-000000000803','mapped','high',NULL,'agave-vendor','2026-08-10T00:00:00.000Z','2026-08-25T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-map-ag-3','fx-stub-ag-autodesk-build','fx-cat-agave','00000000-0000-4000-8000-000000000801','mapped','medium',NULL,'auto-name-match','2026-08-10T00:00:00.000Z','2026-08-25T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Pairs. NOT the reachable tier and NOT an assertion of delivery (§9a.5) — they
-- exist for the one thing the mapping graph cannot supply, `surface`. The
-- canonical ordering (stub_a_id < stub_b_id) is a CHECK, so these are pre-sorted.
-- All three surface values appear, because `unknown` is the default and a screen
-- that never shows it hides the majority state.
-- ---------------------------------------------------------------------------
INSERT INTO connector_pairs (id, catalog_id, stub_a_id, stub_b_id, url_a_to_b, url_b_to_a, surface, classified_at, first_seen_at, last_seen_at, removed_at, created_at, updated_at) VALUES
  ('fx-pair-1','fx-cat-mindcloud','fx-stub-mc-procore','fx-stub-mc-sage-intacct','https://example.com/mindcloud/procore-to-sage','https://example.com/mindcloud/sage-to-procore','curated','2026-08-28T00:00:00.000Z','2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-pair-2','fx-cat-mindcloud','fx-stub-mc-autodesk-build','fx-stub-mc-procore','https://example.com/mindcloud/autodesk-to-procore',NULL,'generated','2026-08-28T00:00:00.000Z','2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-pair-3','fx-cat-mindcloud','fx-stub-mc-bluebeam-revu','fx-stub-mc-plangrid',NULL,NULL,'unknown',NULL,'2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fx-pair-4','fx-cat-agave','fx-stub-ag-autodesk-build','fx-stub-ag-procore','https://example.com/agave/autodesk-procore',NULL,'curated','2026-08-10T00:00:00.000Z','2026-07-01T00:00:00.000Z','2026-08-30T00:00:00.000Z',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- `connector_evidenced_pairs` is deliberately NOT seeded. AECI-714 creates it
-- empty and nothing writes it until AECI-721 migrates the powered edges in, so an
-- empty delivered lane IS the correct local state — and the screen has to render
-- that as "not migrated yet", never as a measured zero.
-- ---------------------------------------------------------------------------

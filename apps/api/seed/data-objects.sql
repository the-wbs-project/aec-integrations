-- `data_object` controlled vocabulary for Cloudflare D1 (Stage 1.5 — AECI-293).
-- Canonical seed + source of truth for the main-app `taxonomy_data_objects` table,
-- mirroring apps/api/seed/taxonomy.sql. Materialises the frozen 20-term vocabulary from
-- docs/DATA_OBJECT_VOCABULARY.md (§4) / its generated mirror docs/data-object-vocabulary.json.
--
-- Idempotent UPSERTs keyed on slug; ids are deterministic UUIDv5(slug) so they are stable
-- across re-runs and environments. Applied with `pnpm db:seed:data-objects:local` →
-- `wrangler d1 execute aeci-app-<env> --file=seed/data-objects.sql` (and the per-env
-- --remote seed step in deploy.yml / promote-to-*.yml). NEVER deletes.
--
-- `aliases` is a JSON array (resolver metadata): the promote ingest (AECI-297) resolves a
-- claim's `dataObject` find-only by slug then alias (§6.2). Edit the doc table + the JSON
-- mirror, then regenerate this file — never hand-edit rows (a d1.spec test guards the sync).
--
-- UUIDv5 namespace = UUIDv5(URL_NS, 'https://aecintegrations.com/vocabulary/data_object')
--                  = 4a9d061b-fec7-596f-be52-8db72334eb59
-- (URL_NS = 6ba7b811-9dad-11d1-80b4-00c04fd430c8). Ids are not stored in the doc/JSON — derived from the slug.

INSERT INTO "taxonomy_data_objects" ("id","slug","name","description","display_order","aliases","created_at","updated_at") VALUES
  ('12f6d14b-b996-565a-beda-c35f72136e13', 'models', 'Models', 'BIM / 3D models exchanged between authoring and coordination tools.', 10, '["Model","BIM","BIM Models","3D Models","IFC","Revit Models","Federated Model","Coordination Model"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('990704b3-6374-5639-82ad-62ed19e29811', 'drawings', 'Drawings', '2D sheets and plans (DWG/PDF) shared across design and field tools.', 20, '["Drawing","Sheets","2D Drawings","Plans","Construction Drawings","DWG","CAD"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('e25eeda0-3650-5a74-b3a0-b266a3eaf1c1', 'specifications', 'Specifications', 'Specification sections defining materials, products, and execution standards.', 30, '["Specification","Specs","Spec","Spec Sections","CSI Specs","Project Manual"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('c90c9e1a-acdb-5bd9-94a9-1f5e64114da2', 'bids-tenders', 'Bids & Tenders', 'Bid / tender packages and procurement solicitations exchanged during buyout.', 40, '["Bids","Bid","Tenders","Tender","Bid Packages","Tendering","ITB","Invitation to Bid","Procurement"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('d095ecd1-21e2-5610-b653-b643d2be68ff', 'commitments', 'Commitments & Contracts', 'Executed commitments — subcontracts and purchase orders — that draw down the budget.', 50, '["Commitment","Contracts","Contract","Subcontracts","Subcontract","Purchase Orders","PO","POs"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('32a8cbf5-7bde-5fea-ada9-4ae7a3dea1eb', 'budgets', 'Budgets', 'The project budget and its budget line items.', 60, '["Budget","Project Budget","Budget Line Items","Original Budget"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('8ad70643-8635-5859-ae78-856517b78ece', 'cost-codes', 'Cost Codes', 'The cost-code / cost-breakdown structure that line items are coded to.', 70, '["Cost Code","Cost Breakdown Structure","CBS","WBS Codes","Budget Codes"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('94eec696-7e24-5141-a654-27d79aeec1ef', 'change-orders', 'Change Orders', 'Change orders and potential change events that adjust scope or cost.', 80, '["Change Order","CO","PCO","Potential Change Order","Change Events","Change Event"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('d302efc3-4443-56a2-b803-3de64db60393', 'invoices-payments', 'Invoices & Payments', 'Invoices, pay applications, and payment records.', 90, '["Invoices","Invoice","Payments","Pay Applications","Pay App","Applications for Payment","Billings","AP"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('705ba5ba-4719-518d-8382-9e514bc17c1b', 'schedules', 'Schedules', 'Project schedules (CPM / Gantt) and their activities.', 100, '["Schedule","Project Schedule","Gantt","CPM Schedule","Activities","P6","Programme"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('2d14be8b-4d2a-55f9-8d45-c1092a5302af', 'rfis', 'RFIs', 'Requests for Information and their responses.', 110, '["RFI","Requests for Information","Request for Information","Information Requests"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ac58f9ee-97be-513c-b6a9-cc421f491a6c', 'submittals', 'Submittals', 'Submittal packages (shop drawings, product data, samples) and their review.', 120, '["Submittal","Submittal Package","Shop Drawings","Product Data","Samples"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('0e787b10-4086-5096-ab01-72bd44b33a3e', 'meetings', 'Meetings & Minutes', 'Project meetings and their minutes, agendas, and action items.', 130, '["Meeting","Meeting Minutes","Minutes","Meeting Notes","Meeting Agenda","Agendas"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('f761f27f-b688-5a7d-a52c-108612f9aab9', 'daily-logs', 'Daily Logs', 'Daily field logs / site diaries (manpower, weather, progress).', 140, '["Daily Log","Field Logs","Daily Reports","Site Diary","Field Reports"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fc631005-5da7-562b-83f9-30ff697c8643', 'photos', 'Photos', 'Site and progress photos.', 150, '["Photo","Site Photos","Progress Photos","Images","Field Photos"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('155a9150-22df-5de0-ac83-1bb997701903', 'inspections', 'Inspections', 'Quality and field inspections and their results.', 160, '["Inspection","Quality Inspections","Field Inspections","QA/QC Inspections"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('e9f15d64-0b81-5c69-a51e-422a2cee3714', 'punch-lists', 'Punch Lists', 'Punch / snag lists tracking deficiencies to close out.', 170, '["Punch List","Punchlist","Snag List","Snags","Deficiency List","Punch Items"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('d4a01852-8cda-50ee-b924-9c02e823ecce', 'time-labor', 'Time & Labor', 'Timesheets and labor hours.', 180, '["Timesheets","Timesheet","Labor","Time Tracking","Timecards","Crew Hours","Manpower"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('54aac7f5-4c9a-54da-88e8-73fd5eb09b25', 'documents', 'Documents', 'General project documents and files under document management.', 190, '["Document","Files","Project Documents","Document Management","Attachments"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('da30093b-e634-5687-84ed-bdb2addeb8aa', 'directory-contacts', 'Directory & Contacts', 'The project / company directory of people and companies.', 200, '["Directory","Contacts","Contact","Company Directory","Project Directory","People","Companies"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT ("slug") DO UPDATE SET
  "name" = excluded."name",
  "description" = excluded."description",
  "display_order" = excluded."display_order",
  "aliases" = excluded."aliases",
  "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now');

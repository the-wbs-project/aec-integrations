-- Taxonomy reference data for Cloudflare D1 (ADR 0016 / AECI-252).
-- GENERATED from supabase/reference-data/taxonomy.sql (ADR 0008). Idempotent
-- UPSERTs keyed on slug; ids are deterministic UUIDv5(slug) so they are stable
-- across re-runs and environments. Applied with `pnpm db:seed:taxonomy` →
-- `wrangler d1 execute aeci-app-<env> --file=seed/taxonomy.sql`. NEVER deletes
-- (removals cascade to product_* joins); touches taxonomy_* tables only.

INSERT INTO "taxonomy_categories" ("id","slug","name","display_order","created_at","updated_at") VALUES
  ('42ac2106-9994-5fad-8298-f82bbb85bc14', 'accounting-erp', 'Accounting & ERP', 10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('50e25aaa-7314-5335-9cf5-422f75466174', 'ai', 'AI', 20, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('856004c5-1884-5eae-8738-0e050f9c042b', 'analytics-reporting', 'Analytics & Reporting', 30, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fb7fd551-a10a-5298-b213-e6c5094bdc54', 'asset-management', 'Asset Management', 40, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('73d34ad0-af8d-50ad-b7e7-364f6c2f0392', 'bid-management', 'Bid Management', 50, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('90957bf7-493c-52c5-90c8-ed00df6aa792', 'bim-authoring', 'BIM Authoring', 60, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('dab2edc8-4143-5950-a4c5-2f659f45835c', 'bim-coordination', 'BIM Coordination', 70, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('170262bd-88d6-53a5-9b77-7ab91b77ce11', 'civil-engineering', 'Civil Engineering', 80, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('e52efc56-283b-5b15-86b2-140d640a9c60', 'collaboration-communication', 'Collaboration & Communication', 90, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('4602fb41-d8a6-5be0-ae3c-b2f269866da7', 'construction-management', 'Construction Management', 100, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('d0e6d1ae-6d3e-514f-b27a-2462d0daa9a6', 'crm-sales', 'CRM & Sales', 110, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('a5051b9c-db88-54ae-a22d-2b552ec1de3a', 'design-visualization', 'Design & Visualization', 120, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b010b0d0-7af0-5ca4-b5b9-347a3c13f02d', 'document-management', 'Document Management', 130, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b62005ef-67c6-526b-9ed5-8062dcb5ca4a', 'drone-site-monitoring', 'Drone & Site Monitoring', 140, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('9ccd8306-f1c1-563b-8544-fbf8498ed7a4', 'energy-sustainability', 'Energy & Sustainability', 150, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ea16a6d4-1d2f-5ac3-94ec-8e06319fda4f', 'equipment-management', 'Equipment Management', 160, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('c3d9344e-1c3a-5ad4-a6ad-9de36d9bd3af', 'estimating-takeoff', 'Estimating & Takeoff', 170, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cb9ac9ae-7e89-5b6c-9a90-294cc50982b1', 'facilities-management', 'Facilities Management', 180, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('5091dfef-23b1-51b5-b46f-9009aa84b8e7', 'field-management', 'Field Management', 190, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ff8475ec-cbb8-52d5-8c81-8c37898e97b7', 'mep-design', 'MEP Design', 200, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('15e9b2aa-7fec-5004-af40-2300b5d5159a', 'payment-management', 'Payment Management', 210, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('66df2fe0-ecf3-555c-a138-1077c3e0722a', 'prefabrication-modular', 'Prefabrication & Modular', 220, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('66360a76-bb37-59bc-9efe-af99d0b968eb', 'project-management', 'Project Management', 230, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('930f27c4-5c8c-5b55-a5f3-bbbbbd4128dc', 'punch-list-qa-qc', 'Punch List & QA/QC', 240, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('39e40d09-b52b-52ae-ae00-28b3495e5980', 'reality-capture', 'Reality Capture (Scan-to-BIM)', 250, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b63f4145-33e5-5ade-a50f-a3597ac47698', 'rfi-submittal-management', 'RFI & Submittal Management', 260, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('440ea8b3-48e3-5a7c-b919-dc4243c6549f', 'robotics', 'Robotics', 270, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('1d2e88cc-3a36-5720-b445-dc1fa2303f9c', 'safety-compliance', 'Safety & Compliance', 280, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b8287ee4-cdad-5c87-839e-0fd22614c528', 'scheduling', 'Scheduling', 290, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('73643d9b-74af-573b-9c47-59cebf2e6925', 'structural-analysis', 'Structural Analysis', 300, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('48f12354-d908-52a5-b6ed-fe4f4614b56b', 'surveying-gis', 'Surveying & GIS', 310, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('9fdb53d8-d819-5ae8-9aca-1616d93c3750', 'workforce-management', 'Workforce Management', 320, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT ("slug") DO UPDATE SET
  "name" = excluded."name",
  "display_order" = excluded."display_order",
  "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now');

INSERT INTO "taxonomy_audiences" ("id","slug","name","display_order","created_at","updated_at") VALUES
  ('c53711b6-59e9-5290-bea0-7ebfcf9df8f3', 'accounting-finance', 'Accounting & Finance', 10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b920a2ab-8cb2-583a-b508-1dcca2b08c69', 'architecture', 'Architecture', 20, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('4ab0e0f3-7cbc-5f2b-b432-4cba07b13873', 'business-development', 'Business Development', 30, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('d7e21504-edad-5ce3-a000-69565fcba28f', 'civil-engineering', 'Civil Engineering', 40, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('4393af17-bef4-569e-80cf-d61f08916ba7', 'construction-management', 'Construction Management', 50, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('bf4fa859-9e51-5d75-9747-42678174ba3e', 'executive-leadership', 'Executive Leadership', 60, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('f38f5fe5-8f6c-5912-9f95-e30c6a6178d7', 'facilities-management', 'Facilities Management', 70, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('1a838026-087b-5536-bf74-6932fc659808', 'general-contracting', 'General Contracting', 80, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('f16d5641-44dd-56bd-b80f-bed96b58efd7', 'human-resources', 'Human Resources', 90, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('6ce4cf44-9970-5960-9835-b59765cda28a', 'interior-design', 'Interior Design', 100, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('eec61e41-100e-5105-ace0-822336972a11', 'it-systems-administration', 'IT & Systems Administration', 110, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('96ec6eef-1146-5598-a485-e8bb87b04157', 'landscape-architecture', 'Landscape Architecture', 120, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('bf47cadc-703c-5bbe-a51f-e8e04eee1b42', 'legal-risk-management', 'Legal & Risk Management', 130, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cd805567-9477-5098-85eb-9a4f42562cac', 'marketing-communications', 'Marketing & Communications', 140, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('a8623578-4c06-55f0-ab1c-45b1cc74ce0f', 'mep-engineering', 'MEP Engineering', 150, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('8e8af0f1-3483-5469-928d-84a48a8f72ca', 'owner-developer', 'Owner/Developer', 160, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('df493938-c2b7-52fa-b813-afda6d008b8b', 'procurement-purchasing', 'Procurement & Purchasing', 170, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('5258bd19-e52d-553c-840e-6e7575bf09b3', 'safety-management', 'Safety Management', 180, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('32183b5e-1cee-5870-97b8-b26a2e322f5c', 'specialty-contracting', 'Specialty Contracting', 190, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('4f4cfa6f-1750-5f04-99c7-d9593b0bd3c8', 'structural-engineering', 'Structural Engineering', 200, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('c2c5d10e-2864-5e22-83f3-8efe87a703b4', 'surveying-geomatics', 'Surveying/Geomatics', 210, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cceb1b70-495a-56a3-92e9-50a7dc7c48b9', 'project-manager', 'Project Manager', 220, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('3666cdcb-23eb-5059-8016-3dcfaf90ffd7', 'project-engineer', 'Project Engineer', 230, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('1788a6db-6f92-5025-ab4f-17e9458ac3ab', 'superintendent', 'Superintendent', 240, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('3c630a45-c62f-565a-a35d-9ff600b4527a', 'estimator', 'Estimator', 250, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('721b2599-d4b1-51df-a424-b9933e704476', 'scheduler', 'Scheduler', 260, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('6cd4cfd1-2db5-5039-9e75-3d3c6d718e89', 'foreman-field-supervisor', 'Foreman / Field Supervisor', 270, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('2470a024-d1e6-5028-880f-55c849593ff9', 'designer-drafter', 'Designer / Drafter', 280, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('9cc8aa44-8163-54d4-a2a7-9a306d22aa51', 'bim-manager', 'BIM Manager', 290, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('11358802-6923-51dc-9444-641b78c50084', 'bim-coordinator', 'BIM Coordinator', 300, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT ("slug") DO UPDATE SET
  "name" = excluded."name",
  "display_order" = excluded."display_order",
  "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now');

INSERT INTO "taxonomy_phases" ("id","slug","name","display_order","created_at","updated_at") VALUES
  ('6424df89-c19f-558f-bbfe-e882d49f8d09', 'concept-planning', 'Concept & Planning', 10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('f826e001-bdd7-5ee0-bfa4-e911f5b9a36a', 'design', 'Design', 20, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00d4e2fa-a696-5b0d-a935-a859d87b85e9', 'pre-construction', 'Pre-Construction', 30, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b8ac04ba-6fe4-575b-9716-cd2bbd99ea92', 'construction', 'Construction', 40, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ff1baab5-d6ab-5e30-b51e-2bd0efdea4a3', 'closeout-operations', 'Closeout & Operations', 50, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT ("slug") DO UPDATE SET
  "name" = excluded."name",
  "display_order" = excluded."display_order",
  "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now');

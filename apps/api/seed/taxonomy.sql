-- Taxonomy reference data for Cloudflare D1 (ADR 0016 / AECI-252).
-- Canonical taxonomy seed and source of truth (ADR 0008; the former Postgres
-- `supabase/reference-data/taxonomy.sql` was removed in AECI-278). Idempotent
-- UPSERTs keyed on slug; ids are deterministic UUIDv5(slug) so they are stable
-- across re-runs and environments. Applied with `pnpm db:seed:taxonomy` →
-- `wrangler d1 execute aeci-app-<env> --file=seed/taxonomy.sql`. NEVER deletes
-- (removals cascade to product_* joins); touches taxonomy_* tables only.
--
-- KNOWN GAP (AECI-540). The exact UUIDv5 namespace + name form behind the ORIGINAL ids
-- here is unrecovered: they match neither UUIDv5 over the bare slug under any of the five
-- standard namespaces, nor the `UUIDv5(URL_NS, 'https://aecintegrations.com/vocabulary/<v>')`
-- scheme that seed/data-objects.sql and seed/trades.sql document and use. The ids are
-- shipped and immutable (slug is the identity key; ids never regenerate), so this is a
-- documentation gap, not a defect. ANY NEW TERM added below must therefore have its id
-- minted by hand and recorded here — do not assume a derivation covering the whole file.
--
-- NEW TERMS USE THE DOCUMENTED SCHEME. Terms added after AECI-540 are minted under the
-- same construction seed/trades.sql and seed/data-objects.sql use, one vocabulary path
-- along, so they ARE reproducible even though their older siblings are not:
--
--   NAMESPACE = UUIDv5(URL_NS, 'https://aecintegrations.com/vocabulary/audience')
--             = 9488d68f-a6b7-5edd-ab56-f3f86f7f39ec
--   id        = uuidv5(slug, NAMESPACE)
--
-- (URL_NS = 6ba7b811-9dad-11d1-80b4-00c04fd430c8, RFC 9562 §6.6.) The six audience terms
-- at display_order 53/56/145/155/165/185 are the first minted this way. Categories and
-- phases have no post-540 additions yet; when they get one, use the same construction with
-- `/vocabulary/category` and `/vocabulary/phase`.
--
-- DISPLAY_ORDER. The audience block is two runs: disciplines (10..210, alphabetical) then
-- job titles (220..300, curated). Values are spaced in tens precisely so a term can be
-- inserted between two without renumbering, which is why the additions above carry
-- off-round values (53, 145, ...) rather than the block being resequenced.
--
-- DESCRIPTION. Every term ships one, as of 2026-09-14 (ADR 0008's "Follow-ups" deferral,
-- now closed). A NEW TERM MUST CARRY ONE -- the column is nullable only because tightening
-- it would mean recreating three tables on D1, which is destructive (see ADR 0008); it is
-- not an invitation to leave it blank. The string does two jobs and is written for both:
--
--   1. READER COPY. It is the paragraph under the heading on /{categories,audiences,phases}
--      /:slug, and -- via MetaService.setEntityMeta -- the page's meta description and
--      og:description. A term with no description silently inherits the site-wide default,
--      which is how 73 indexable pages came to share one meta description before this.
--   2. TAGGING GUIDANCE. It tells whoever is tagging a product which of two ADJACENT terms
--      to pick. Where a near-neighbour exists, the description names it explicitly
--      ("Clash detection and federation belong under BIM Coordination"). This matters more
--      here than on trades or data objects, which resolve find-only: categories, audiences
--      and phases resolve FIND-OR-CREATE in promote (routes/promote.ts), so a near-miss
--      label does not fail -- it mints a real term with a permanent public URL.
--
-- Style follows seed/trades.sql: one sentence naming what belongs, then an optional second
-- sentence pointing at the neighbour. Keep it at or under 155 characters so it survives as
-- a meta description: that is META_DESCRIPTION_MAX in apps/web/src/app/core/meta.helpers.ts,
-- past which truncateAtWordBoundary() silently cuts at a word boundary and appends an
-- ellipsis. The longest term here is 152. No apostrophes unless you escape them ('' in SQL).
--
-- ENFORCED, NOT REMEMBERED (AECI-962). src/test/taxonomy-seed-slugs.spec.ts parses this file
-- and fails the build on any row whose description is NULL, blank, or over 155 characters.
-- The live side is covered too: the 'taxonomy_missing_description' data-quality check
-- (lib/data-quality.ts, severity error) reports any term in D1 with no description, which is
-- what a promote-minted term looks like.

INSERT INTO "taxonomy_categories" ("id","slug","name","description","display_order","created_at","updated_at") VALUES
  ('42ac2106-9994-5fad-8298-f82bbb85bc14', 'accounting-erp', 'Accounting & ERP', 'General ledger, AP/AR, payroll, and job-cost accounting for construction businesses. Pay applications and lien waivers belong under Payment Management.', 10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('50e25aaa-7314-5335-9cf5-422f75466174', 'ai', 'AI', 'Products whose core function is machine learning or generative AI, rather than tools that merely include an AI feature.', 20, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('856004c5-1884-5eae-8738-0e050f9c042b', 'analytics-reporting', 'Analytics & Reporting', 'Dashboards, business intelligence, and cross-project reporting over data produced elsewhere. Tag AI only when models, not queries, do the work.', 30, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('fb7fd551-a10a-5298-b213-e6c5094bdc54', 'asset-management', 'Asset Management', 'Lifecycle tracking of owned physical assets and infrastructure. Construction fleet is Equipment Management, buildings in use is Facilities Management.', 40, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('73d34ad0-af8d-50ad-b7e7-364f6c2f0392', 'bid-management', 'Bid Management', 'Invitations to bid, bid packages, subcontractor solicitation, and bid-day leveling. Pricing the work itself is Estimating & Takeoff.', 50, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('90957bf7-493c-52c5-90c8-ed00df6aa792', 'bim-authoring', 'BIM Authoring', 'Tools that create and edit the model itself, discipline by discipline. Clash detection and federation belong under BIM Coordination.', 60, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('dab2edc8-4143-5950-a4c5-2f659f45835c', 'bim-coordination', 'BIM Coordination', 'Federating models from multiple disciplines, clash detection, and coordination review. The tools that produce those models are BIM Authoring.', 70, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('170262bd-88d6-53a5-9b77-7ab91b77ce11', 'civil-engineering', 'Civil Engineering', 'Site, roadway, grading, drainage, and infrastructure design. Survey data capture and mapping belong under Surveying & GIS.', 80, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('e52efc56-283b-5b15-86b2-140d640a9c60', 'collaboration-communication', 'Collaboration & Communication', 'Messaging, meetings, markup, and shared workspaces across project teams. The system of record for files belongs under Document Management.', 90, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('4602fb41-d8a6-5be0-ae3c-b2f269866da7', 'construction-management', 'Construction Management', 'Broad platforms running the build, combining field, cost, and document workflows in one system. Narrower planning tools belong under Project Management.', 100, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('d0e6d1ae-6d3e-514f-b27a-2462d0daa9a6', 'crm-sales', 'CRM & Sales', 'Pursuing and winning work: pipeline, client relationships, proposals, and go/no-go tracking. Responding to a specific bid is Bid Management.', 110, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('a5051b9c-db88-54ae-a22d-2b552ec1de3a', 'design-visualization', 'Design & Visualization', 'Rendering, walkthroughs, VR, and presentation graphics. The modeling tools that feed them belong under BIM Authoring.', 120, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b010b0d0-7af0-5ca4-b5b9-347a3c13f02d', 'document-management', 'Document Management', 'System of record for drawings, specs, and project files, with versioning and access control. Discussion and markup are Collaboration & Communication.', 130, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b62005ef-67c6-526b-9ed5-8062dcb5ca4a', 'drone-site-monitoring', 'Drone & Site Monitoring', 'Aerial imagery, site cameras, and progress capture over time. Point-cloud scanning for as-builts belongs under Reality Capture.', 140, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('9ccd8306-f1c1-563b-8544-fbf8498ed7a4', 'energy-sustainability', 'Energy & Sustainability', 'Energy modeling, carbon and embodied-carbon accounting, certification tracking, and building performance analysis.', 150, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ea16a6d4-1d2f-5ac3-94ec-8e06319fda4f', 'equipment-management', 'Equipment Management', 'Construction fleet, heavy equipment, and small-tool tracking: utilization, maintenance, and dispatch. Owner-side assets belong under Asset Management.', 160, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('c3d9344e-1c3a-5ad4-a6ad-9de36d9bd3af', 'estimating-takeoff', 'Estimating & Takeoff', 'Quantity takeoff, unit pricing, assemblies, and cost databases. Soliciting and leveling subcontractor bids is Bid Management.', 170, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cb9ac9ae-7e89-5b6c-9a90-294cc50982b1', 'facilities-management', 'Facilities Management', 'Operating a building after handover: work orders, maintenance, space management, and CMMS. Construction-phase gear belongs under Equipment Management.', 180, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('5091dfef-23b1-51b5-b46f-9009aa84b8e7', 'field-management', 'Field Management', 'What the crew does on site: daily logs, photos, timecards, and mobile field capture. Office-side program tools belong under Project Management.', 190, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ff8475ec-cbb8-52d5-8c81-8c37898e97b7', 'mep-design', 'MEP Design', 'Mechanical, electrical, and plumbing system design, sizing, and layout. General model authoring belongs under BIM Authoring.', 200, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('15e9b2aa-7fec-5004-af40-2300b5d5159a', 'payment-management', 'Payment Management', 'Moving money on a project: pay applications, lien waivers, compliance, and subcontractor payments. The books themselves are Accounting & ERP.', 210, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('66df2fe0-ecf3-555c-a138-1077c3e0722a', 'prefabrication-modular', 'Prefabrication & Modular', 'Offsite fabrication, shop drawings, panelization, and modular assembly workflows. Automated machinery on the line belongs under Robotics.', 220, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('66360a76-bb37-59bc-9efe-af99d0b968eb', 'project-management', 'Project Management', 'Planning, tracking, and coordinating project work across tasks, budgets, and team workflow. All-in-one build platforms are Construction Management.', 230, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('930f27c4-5c8c-5b55-a5f3-bbbbbd4128dc', 'punch-list-qa-qc', 'Punch List & QA/QC', 'Quality inspections, observations, punch lists, and closeout verification. Worker safety programs belong under Safety & Compliance.', 240, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('39e40d09-b52b-52ae-ae00-28b3495e5980', 'reality-capture', 'Reality Capture', 'Laser scanning, photogrammetry, and point clouds converted into models. Ongoing progress photography belongs under Drone & Site Monitoring.', 250, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b63f4145-33e5-5ade-a50f-a3597ac47698', 'rfi-submittal-management', 'RFI & Submittal Management', 'Formal construction-administration workflows: RFIs, submittals, transmittals, and their review cycles and logs.', 260, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('440ea8b3-48e3-5a7c-b919-dc4243c6549f', 'robotics', 'Robotics', 'Physical robots and automated machinery for layout, fabrication, inspection, or installation on site or in the shop.', 270, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('1d2e88cc-3a36-5720-b445-dc1fa2303f9c', 'safety-compliance', 'Safety & Compliance', 'Toolbox talks, incident reporting, job hazard analyses, training records, and regulatory compliance. Quality defects belong under Punch List & QA/QC.', 280, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b8287ee4-cdad-5c87-839e-0fd22614c528', 'scheduling', 'Scheduling', 'CPM, pull planning, look-aheads, and resource-loaded project schedules. Broader task and budget tracking belongs under Project Management.', 290, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('73643d9b-74af-573b-9c47-59cebf2e6925', 'structural-analysis', 'Structural Analysis', 'Structural modeling, analysis, code checking, and member design. Detailing and model authoring belong under BIM Authoring.', 300, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('48f12354-d908-52a5-b6ed-fe4f4614b56b', 'surveying-gis', 'Surveying & GIS', 'Field survey, geospatial data, mapping, and site layout. Scan-to-BIM conversion belongs under Reality Capture.', 310, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('9fdb53d8-d819-5ae8-9aca-1616d93c3750', 'workforce-management', 'Workforce Management', 'Labor planning, crew scheduling, certifications, and workforce forecasting. On-site time capture belongs under Field Management.', 320, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT ("slug") DO UPDATE SET
  "name" = excluded."name",
  "description" = excluded."description",
  "display_order" = excluded."display_order",
  "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now');

INSERT INTO "taxonomy_audiences" ("id","slug","name","description","display_order","created_at","updated_at") VALUES
  ('c53711b6-59e9-5290-bea0-7ebfcf9df8f3', 'accounting-finance', 'Accounting & Finance', 'Controllers, accountants, and finance staff running the books, billing, and financial reporting.', 10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b920a2ab-8cb2-583a-b508-1dcca2b08c69', 'architecture', 'Architecture', 'Architects and architectural practices doing building design and construction administration. Interiors specialists are Interior Design.', 20, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('4ab0e0f3-7cbc-5f2b-b432-4cba07b13873', 'business-development', 'Business Development', 'Staff pursuing new work through client development, pursuits, and proposals. Brand and campaign work is Marketing & Communications.', 30, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('d7e21504-edad-5ce3-a000-69565fcba28f', 'civil-engineering', 'Civil Engineering', 'Civil engineers working on site, roadway, drainage, and infrastructure design. Permitting and remediation is Environmental Engineering.', 40, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('4393af17-bef4-569e-80cf-d61f08916ba7', 'construction-management', 'Construction Management', 'Construction managers and CM firms managing delivery on behalf of an owner. Firms holding the prime contract are General Contracting.', 50, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('e617bf7c-a2dd-5cd1-adae-74ea7c7e73ad', 'electrical-engineering', 'Electrical Engineering', 'Electrical engineers as a standalone discipline. Use MEP Engineering when the product serves the combined practice.', 53, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('9d63734f-9206-55a9-be02-149fe0376b5c', 'environmental-engineering', 'Environmental Engineering', 'Environmental engineers handling permitting, remediation, stormwater, and environmental compliance.', 56, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('bf4fa859-9e51-5d75-9747-42678174ba3e', 'executive-leadership', 'Executive Leadership', 'Owners, principals, and C-suite making firm-level decisions. Property owners commissioning work are Owner/Developer.', 60, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('f38f5fe5-8f6c-5912-9f95-e30c6a6178d7', 'facilities-management', 'Facilities Management', 'Facility managers and building operators running a property after handover.', 70, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('1a838026-087b-5536-bf74-6932fc659808', 'general-contracting', 'General Contracting', 'General contractors holding the prime contract and managing or self-performing the trades. Owner-side CM firms are Construction Management.', 80, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('f16d5641-44dd-56bd-b80f-bed96b58efd7', 'human-resources', 'Human Resources', 'HR staff handling hiring, onboarding, benefits, and employee records.', 90, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('6ce4cf44-9970-5960-9835-b59765cda28a', 'interior-design', 'Interior Design', 'Interior designers and architects working on interiors, finishes, and furniture specification.', 100, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('eec61e41-100e-5105-ace0-822336972a11', 'it-systems-administration', 'IT & Systems Administration', 'IT staff administering software, identity, data, and infrastructure for an AEC firm.', 110, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('96ec6eef-1146-5598-a485-e8bb87b04157', 'landscape-architecture', 'Landscape Architecture', 'Landscape architects designing site, planting, and outdoor environments. Land-use and zoning work is Planning.', 120, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('bf47cadc-703c-5bbe-a51f-e8e04eee1b42', 'legal-risk-management', 'Legal & Risk Management', 'In-house counsel and contracts, insurance, and claims staff. Site safety programs are Safety Management.', 130, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cd805567-9477-5098-85eb-9a4f42562cac', 'marketing-communications', 'Marketing & Communications', 'Marketing staff handling brand, content, and proposal production. Pursuit strategy is Business Development.', 140, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('e5cae339-1529-53ee-ae12-0d8502ae6162', 'mechanical-engineering', 'Mechanical Engineering', 'Mechanical engineers as a standalone discipline. Use MEP Engineering when the product serves the combined practice.', 145, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('a8623578-4c06-55f0-ab1c-45b1cc74ce0f', 'mep-engineering', 'MEP Engineering', 'Engineers working across the combined mechanical, electrical, and plumbing practice. Single-discipline products should use the specific term.', 150, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('de118e68-9917-5628-9282-dff3c17404d0', 'other-engineering', 'Other Engineering', 'Engineering disciplines outside the named terms, such as fire protection, geotechnical, or industrial engineering.', 155, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('8e8af0f1-3483-5469-928d-84a48a8f72ca', 'owner-developer', 'Owner/Developer', 'Owners, developers, and their in-house teams commissioning and funding projects.', 160, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('be603b50-b11d-52a0-9a7e-94e8abf0fba0', 'planning', 'Planning', 'Urban, land-use, and site planners working on entitlement, zoning, and master planning.', 165, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('df493938-c2b7-52fa-b813-afda6d008b8b', 'procurement-purchasing', 'Procurement & Purchasing', 'Buyers and procurement staff sourcing materials, subcontracts, and vendors. Pricing the work is Estimator.', 170, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('5258bd19-e52d-553c-840e-6e7575bf09b3', 'safety-management', 'Safety Management', 'Safety directors and EHS staff running site safety and regulatory programs.', 180, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('1340a331-f4a6-5e08-9ade-42c86f6f6d5d', 'sciences', 'Sciences', 'Environmental, geotechnical, and materials scientists supporting design and construction.', 185, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('32183b5e-1cee-5870-97b8-b26a2e322f5c', 'specialty-contracting', 'Specialty Contracting', 'Trade and specialty subcontractors self-performing a scope. The specific trade is tagged on the Trade facet instead.', 190, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('4f4cfa6f-1750-5f04-99c7-d9593b0bd3c8', 'structural-engineering', 'Structural Engineering', 'Structural engineers doing analysis, member design, and structural detailing.', 200, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('c2c5d10e-2864-5e22-83f3-8efe87a703b4', 'surveying-geomatics', 'Surveying/Geomatics', 'Surveyors and geomatics professionals doing field survey, layout, and geospatial work.', 210, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cceb1b70-495a-56a3-92e9-50a7dc7c48b9', 'project-manager', 'Project Manager', 'The project manager owning budget, schedule, and delivery from the office. Field operations belong to Superintendent.', 220, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('3666cdcb-23eb-5059-8016-3dcfaf90ffd7', 'project-engineer', 'Project Engineer', 'The project engineer supporting the PM on submittals, RFIs, and technical coordination.', 230, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('1788a6db-6f92-5025-ab4f-17e9458ac3ab', 'superintendent', 'Superintendent', 'The superintendent running day-to-day field operations and the site crew. Crew-level supervision is Foreman / Field Supervisor.', 240, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('3c630a45-c62f-565a-a35d-9ff600b4527a', 'estimator', 'Estimator', 'The estimator pricing work, running takeoff, and assembling bids.', 250, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('721b2599-d4b1-51df-a424-b9933e704476', 'scheduler', 'Scheduler', 'The scheduler building and maintaining CPM and look-ahead schedules.', 260, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('6cd4cfd1-2db5-5039-9e75-3d3c6d718e89', 'foreman-field-supervisor', 'Foreman / Field Supervisor', 'The foreman directing a crew at the work face, reporting to the superintendent.', 270, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('2470a024-d1e6-5028-880f-55c849593ff9', 'designer-drafter', 'Designer / Drafter', 'Production staff drafting and modeling under a licensed architect or engineer.', 280, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('9cc8aa44-8163-54d4-a2a7-9a306d22aa51', 'bim-manager', 'BIM Manager', 'The BIM manager owning firm-wide standards, templates, and the BIM program. Project-level clash work is BIM Coordinator.', 290, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('11358802-6923-51dc-9444-641b78c50084', 'bim-coordinator', 'BIM Coordinator', 'The BIM coordinator running clash detection and model coordination on a project. Firm-wide standards are BIM Manager.', 300, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT ("slug") DO UPDATE SET
  "name" = excluded."name",
  "description" = excluded."description",
  "display_order" = excluded."display_order",
  "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now');

INSERT INTO "taxonomy_phases" ("id","slug","name","description","display_order","created_at","updated_at") VALUES
  ('6424df89-c19f-558f-bbfe-e882d49f8d09', 'concept-planning', 'Concept & Planning', 'Before design begins: feasibility, programming, site selection, entitlement, and conceptual budgets.', 10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('f826e001-bdd7-5ee0-bfa4-e911f5b9a36a', 'design', 'Design', 'Schematic design through construction documents, across all design disciplines.', 20, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00d4e2fa-a696-5b0d-a935-a859d87b85e9', 'pre-construction', 'Pre-Construction', 'After design and before mobilization: estimating, bidding, buyout, and planning the build.', 30, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b8ac04ba-6fe4-575b-9716-cd2bbd99ea92', 'construction', 'Construction', 'Active building on site, from mobilization through substantial completion.', 40, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ff1baab5-d6ab-5e30-b51e-2bd0efdea4a3', 'closeout-operations', 'Closeout & Operations', 'Punch, commissioning, handover, warranty, and building operations after turnover.', 50, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT ("slug") DO UPDATE SET
  "name" = excluded."name",
  "description" = excluded."description",
  "display_order" = excluded."display_order",
  "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now');

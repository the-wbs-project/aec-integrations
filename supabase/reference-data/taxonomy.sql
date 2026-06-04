-- =============================================================================
-- Taxonomy reference data — the canonical, version-controlled vocabulary for
-- the AECi taxonomy facets (categories, disciplines, phases).
--
-- WHY THIS FILE EXISTS
--   Taxonomy here is *structural*, not curator content: slugs become permanent
--   URLs (`/categories/bim-authoring`), SEO landing pages, and faceted-nav
--   facets with a deliberate display_order. It is small (~58 rows), changes
--   rarely, and must be byte-identical across every environment. So it is owned
--   by code (this file), not by Airtable. See docs/adr/0008-taxonomy-reference-data.md.
--   (High-volume *content* — vendors/products/integrations — still lives in
--   Airtable and reaches Supabase via the promote/curator flow.)
--
-- CONTRACT
--   * Idempotent UPSERTs keyed on `slug`. Safe + self-healing to re-run; each
--     run reconciles name/description/display_order back to this file.
--   * `slug` is the stable identity. Rename `name` freely; never change a slug
--     in place (it's a public URL) — add a new row + redirect instead.
--   * INSERT/UPDATE only. This file NEVER deletes: removing a taxonomy_* row
--     cascades to product_* join rows (FK ON DELETE CASCADE) and would silently
--     unlink products. Removals go through an explicit migration, reviewed.
--   * Touches the `taxonomy_*` vocabulary tables ONLY — never the `product_*`
--     join tables (those links come from the promote flow).
--
-- HOW IT IS APPLIED
--   * Local:   listed in supabase/config.toml [db.seed].sql_paths, so it runs on
--              `pnpm db:reset`.
--   * Remote:  `psql -f supabase/reference-data/taxonomy.sql` after `supabase db
--              push` in deploy.yml / refresh-staging.yml / promote-to-prod.yml,
--              or on demand via `pnpm db:seed-reference`.
--
-- EDITING
--   Add/relabel a term by editing the relevant VALUES block and merging. It
--   auto-propagates to every environment on the next deploy. display_order uses
--   10-step increments so new terms can be slotted between existing ones.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Categories — what the software does. (Source: curated from the Airtable
-- category vocabulary, dropping 3 corrupt self-referential rows.)
-- -----------------------------------------------------------------------------
INSERT INTO "taxonomy_categories" ("slug", "name", "display_order") VALUES
  ('accounting-erp',               'Accounting & ERP',                10),
  ('ai',                           'AI',                              20),
  ('analytics-reporting',          'Analytics & Reporting',           30),
  ('asset-management',             'Asset Management',                40),
  ('bid-management',               'Bid Management',                  50),
  ('bim-authoring',                'BIM Authoring',                   60),
  ('bim-coordination',             'BIM Coordination',                70),
  ('civil-engineering',            'Civil Engineering',               80),
  ('collaboration-communication',  'Collaboration & Communication',   90),
  ('construction-management',      'Construction Management',        100),
  ('crm-sales',                    'CRM & Sales',                    110),
  ('design-visualization',         'Design & Visualization',         120),
  ('document-management',          'Document Management',            130),
  ('drone-site-monitoring',        'Drone & Site Monitoring',        140),
  ('energy-sustainability',        'Energy & Sustainability',        150),
  ('equipment-management',         'Equipment Management',           160),
  ('estimating-takeoff',           'Estimating & Takeoff',           170),
  ('facilities-management',        'Facilities Management',          180),
  ('field-management',             'Field Management',               190),
  ('mep-design',                   'MEP Design',                     200),
  ('payment-management',           'Payment Management',             210),
  ('prefabrication-modular',       'Prefabrication & Modular',       220),
  ('project-management',           'Project Management',             230),
  ('punch-list-qa-qc',             'Punch List & QA/QC',             240),
  ('reality-capture',              'Reality Capture (Scan-to-BIM)',  250),
  ('rfi-submittal-management',     'RFI & Submittal Management',      260),
  ('robotics',                     'Robotics',                       270),
  ('safety-compliance',            'Safety & Compliance',            280),
  ('scheduling',                   'Scheduling',                     290),
  ('structural-analysis',          'Structural Analysis',            300),
  ('surveying-gis',                'Surveying & GIS',                310),
  ('workforce-management',         'Workforce Management',           320)
ON CONFLICT ("slug") DO UPDATE
  SET "name"          = EXCLUDED."name",
      "description"   = EXCLUDED."description",
      "display_order" = EXCLUDED."display_order",
      "updated_at"    = now();

-- -----------------------------------------------------------------------------
-- Disciplines — the professional domain / department a product serves.
-- NOTE: AECI-121 will rename this facet to "Audience" and add cross-cutting
-- personas. Until that lands, it is seeded as `taxonomy_disciplines`.
-- -----------------------------------------------------------------------------
INSERT INTO "taxonomy_disciplines" ("slug", "name", "display_order") VALUES
  ('accounting-finance',           'Accounting & Finance',            10),
  ('architecture',                 'Architecture',                    20),
  ('business-development',         'Business Development',             30),
  ('civil-engineering',            'Civil Engineering',               40),
  ('construction-management',      'Construction Management',         50),
  ('executive-leadership',         'Executive Leadership',            60),
  ('facilities-management',        'Facilities Management',           70),
  ('general-contracting',          'General Contracting',             80),
  ('human-resources',              'Human Resources',                 90),
  ('interior-design',              'Interior Design',                100),
  ('it-systems-administration',    'IT & Systems Administration',    110),
  ('landscape-architecture',       'Landscape Architecture',         120),
  ('legal-risk-management',        'Legal & Risk Management',         130),
  ('marketing-communications',     'Marketing & Communications',     140),
  ('mep-engineering',              'MEP Engineering',                150),
  ('owner-developer',              'Owner/Developer',                160),
  ('procurement-purchasing',       'Procurement & Purchasing',       170),
  ('safety-management',            'Safety Management',              180),
  ('specialty-contracting',        'Specialty Contracting',          190),
  ('structural-engineering',       'Structural Engineering',         200),
  ('surveying-geomatics',          'Surveying/Geomatics',            210)
ON CONFLICT ("slug") DO UPDATE
  SET "name"          = EXCLUDED."name",
      "description"   = EXCLUDED."description",
      "display_order" = EXCLUDED."display_order",
      "updated_at"    = now();

-- -----------------------------------------------------------------------------
-- Phases — lifecycle stage. display_order follows the project lifecycle
-- (Concept → Design → Pre-Construction → Construction → Closeout), NOT alpha.
-- -----------------------------------------------------------------------------
INSERT INTO "taxonomy_phases" ("slug", "name", "display_order") VALUES
  ('concept-planning',             'Concept & Planning',              10),
  ('design',                       'Design',                          20),
  ('pre-construction',             'Pre-Construction',                30),
  ('construction',                 'Construction',                    40),
  ('closeout-operations',          'Closeout & Operations',           50)
ON CONFLICT ("slug") DO UPDATE
  SET "name"          = EXCLUDED."name",
      "description"   = EXCLUDED."description",
      "display_order" = EXCLUDED."display_order",
      "updated_at"    = now();

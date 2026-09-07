-- AECI-685 / AECI-792 — retract the dead `bluebeam` vendor from aeci-app-production.
--
-- Bluebeam is a Nemetschek brand. Both Bluebeam products were re-parented to
-- Nemetschek Group upstream on 2026-09-05, leaving this vendor with zero products
-- but still live, indexed, and named as `built_by` on two integrations.
--
-- Run as ONE `wrangler d1 execute --remote --file` so the four statements land in a
-- single D1 request. Order is load-bearing: both RESTRICT references must be cleared
-- before the DELETE, and the audit row is written BEFORE the DELETE so it can capture
-- `before_state`.
--
-- Pre-flight counts captured 2026-09-07 in `preflight.json`. Rollback: `rollback.sql`.

-- 1. Re-point the two live `built_by` edges to Nemetschek Group. These are correct,
--    editorial edges — re-point, never cascade away. Expect changes = 2.
UPDATE integrations
   SET built_by_vendor_id = '8c83a9d5-b6c4-4117-be00-a02eebf9fee6'
 WHERE built_by_vendor_id = 'b52e0001-8b9e-40c5-87fc-953c2e0dd843';

-- 2. Null the second RESTRICT blocker. `page_views` is log-class (ADR 0022), so the
--    attribution is not worth preserving and the rollback deliberately cannot restore
--    it. Expect changes ~= 31 (still accruing — the statement is count-independent).
UPDATE page_views
   SET vendor_id = NULL
 WHERE vendor_id = 'b52e0001-8b9e-40c5-87fc-953c2e0dd843';

-- 3. The audit row. A vendor delete is DOMAIN state, so STAGE_1_SPEC.md §26.1 applies
--    and the ADR 0022 log-class exemption does NOT ("scheduled deletion is never
--    exempt"). Raw `wrangler d1 execute` bypasses the `apps/api/src/lib/audit.ts`
--    builders, so the row is written by hand here — the thing `retract-product.ts` and
--    the datatool prune both omit. Precedent: `catalog.integrations_reset`.
--    `actor_id` stays NULL: this is an operator action taken outside a session.
INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, before_state, metadata, created_at)
VALUES (
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) ||
  '-' || lower(hex(randomblob(6))),
  'admin',
  'vendor.retracted',
  'vendor',
  'b52e0001-8b9e-40c5-87fc-953c2e0dd843',
  json_object(
    'slug', 'bluebeam',
    'company_name', 'Bluebeam',
    'promotion_status', 'promoted',
    'parent_company', 'Nemetschek Group',
    'product_count', 0,
    'built_by_integration_count', 2
  ),
  json_object(
    'issue', 'AECI-685',
    'execution_issue', 'AECI-792',
    'reason', 'zero-product vendor; both products re-parented to Nemetschek Group upstream 2026-09-05',
    'repointed_built_by_to', '8c83a9d5-b6c4-4117-be00-a02eebf9fee6',
    'repointed_integration_ids', json_array(
      '322ba420-f306-4948-9195-b979eebafba2',
      '6c0cbee8-5d54-4244-bf59-11b88e09ccd0'
    ),
    'page_views_nulled_approx', 31,
    'redirect', '/vendors/bluebeam -> /vendors/nemetschek-group (5a7af578, live in production)'
  ),
  -- REQUIRED. `created_at` is NOT NULL with NO SQL-level DEFAULT: `createdAt()`
  -- (`schema.ts:47`) uses Drizzle's `$defaultFn`, which only runs in application code.
  -- Omitting it fails with SQLITE_CONSTRAINT_NOTNULL — and inside a multi-statement
  -- `--file` batch that surfaces as an opaque `{"D1_RESET_DO":true}`, which reads like a
  -- transient Durable Object reset rather than the constraint error it is. The strftime
  -- format matches `new Date().toISOString()` exactly (3-digit ms, `Z`), so the row
  -- sorts correctly against every application-written audit row.
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

-- 4. The delete. Every CASCADE parent was verified 0 in pre-flight, so this removes
--    exactly one row and nothing silently rides along. Expect changes = 1.
DELETE FROM vendors WHERE id = 'b52e0001-8b9e-40c5-87fc-953c2e0dd843';

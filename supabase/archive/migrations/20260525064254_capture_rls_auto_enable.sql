-- =============================================================================
-- RLS auto-enable infrastructure
--
-- Defensive-in-depth: any future CREATE TABLE in `public` auto-enables row
-- level security, so a missed migration cannot silently expose a table
-- through PostgREST.
--
-- Captures three pieces previously configured directly on the dev project
-- (and not in any migration):
--   1. public.rls_auto_enable()  — function invoked by the event trigger.
--   2. ensure_rls event trigger  — fires on every CREATE TABLE statement.
--   3. RLS enabled on the 20 tables created by earlier migrations
--      (20260515024116_baseline_schema + 20260524000000_phase_2_vendor_requests).
--      The event trigger only fires on NEW CREATE TABLE; existing tables need
--      an explicit ALTER.
--
-- All statements are idempotent: re-running this migration is a no-op against
-- a database that already has the function, trigger, and enabled RLS.
-- =============================================================================

-- 1. Function used by the event trigger.
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
  RETURNS event_trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table', 'partitioned table')
  LOOP
    IF cmd.schema_name IS NOT NULL
       AND cmd.schema_name IN ('public')
       AND cmd.schema_name NOT IN ('pg_catalog', 'information_schema')
       AND cmd.schema_name NOT LIKE 'pg_toast%'
       AND cmd.schema_name NOT LIKE 'pg_temp%'
    THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
    ELSE
      RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
    END IF;
  END LOOP;
END;
$function$;

-- 2. Event trigger. Drop-then-create keeps this idempotent if the trigger
--    already exists (its definition may have changed across reruns).
DROP EVENT TRIGGER IF EXISTS ensure_rls;
CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.rls_auto_enable();

-- 3. Enable RLS on tables that already exist. ALTER TABLE ... ENABLE ROW
--    LEVEL SECURITY is idempotent.
ALTER TABLE "public"."audit_log"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."health_check"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."integrations"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."page_views"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."product_categories"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."product_disciplines"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."product_extensions"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."product_phases"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."product_vendors"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."products"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."profiles"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."reviews"                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."stats_cache"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."taxonomy_categories"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."taxonomy_disciplines"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."taxonomy_phases"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."translations"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."vendors"                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."workflow_instances"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."workflow_transitions"    ENABLE ROW LEVEL SECURITY;

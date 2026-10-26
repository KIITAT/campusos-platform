-- P0-03: who is related to which student, for what (SEC-07, decision 193).
--
-- A schema of views, one per relation a module declares (a class teacher, a
-- subject teacher, a HoD, a mentor), each with the columns
--   viewer_id text, student_id text, relation text, purposes text[]
-- and created WITH (security_invoker = true), so the tables underneath keep
-- their tenant RLS for the app role. campusos_student_relation asks every view
-- in the schema and returns the first relation that holds, or null. A view
-- without those columns makes the call fail, never succeed: the check fails
-- closed.
--
-- SECURITY INVOKER with a fixed search path (NEW-12): it runs with the
-- caller's rights and RLS, and a temporary table cannot stand in for a view.
-- Needs PostgreSQL 15+ for security_invoker views (the modules' views).
--
-- Adds only. Rollback, after rolling back the module migrations whose views
-- live in the schema:
--   DROP FUNCTION public.campusos_student_relation(text, text, text);
--   DROP SCHEMA student_relations CASCADE;

-- Pre-flight: the app role must exist (docker/init.sql, or the web host's migrate).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campusos_app') THEN
    RAISE EXCEPTION 'role campusos_app does not exist. Run docker/init.sql, or the web host''s migrate, first.';
  END IF;
END $$;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS student_relations;
--> statement-breakpoint
REVOKE ALL ON SCHEMA student_relations FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA student_relations TO campusos_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.campusos_student_relation(viewer text, student text, purpose text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v record;
  found text;
BEGIN
  FOR v IN
    SELECT c.relname FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'student_relations'::pg_catalog.regnamespace AND c.relkind = 'v'
     ORDER BY c.relname
  LOOP
    EXECUTE pg_catalog.format(
      'SELECT relation FROM student_relations.%I WHERE viewer_id = $1 AND student_id = $2 AND $3 = ANY (purposes) LIMIT 1',
      v.relname)
      INTO found USING viewer, student, purpose;
    IF found IS NOT NULL THEN
      RETURN found;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.campusos_student_relation(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.campusos_student_relation(text, text, text) TO campusos_app;

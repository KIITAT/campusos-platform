-- P1-08d: retention purges run by the owner, and the institution's record of
-- personal data breaches (AUD-08). New objects only, so no existing row can
-- violate anything.
--
-- Rollback (owner; after rolling back every module's <n>_retention.sql; also
-- remove the 0016 row from the drizzle journal):
--   DROP TABLE breach_incidents;
--   DROP FUNCTION breach_incident_guard();
--   DROP FUNCTION public.campusos_purge_platform();
--   DROP FUNCTION public.campusos_purge_expired(uuid);
--   DROP SCHEMA dpdp_retention CASCADE;
DO $$
BEGIN
  IF to_regclass('public.privacy_officers') IS NULL THEN
    RAISE EXCEPTION 'core migration 0015 (sensitive reads) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS dpdp_retention;
--> statement-breakpoint
REVOKE ALL ON SCHEMA dpdp_retention FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.campusos_purge_expired(inst uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  f record;
  part jsonb;
  n integer;
  result jsonb;
BEGIN
  DELETE FROM public.background_jobs
   WHERE institution_id = inst AND status IN ('succeeded', 'dead')
     AND completed_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  result := jsonb_build_object('background_jobs', n);
  FOR f IN
    SELECT p.proname, p.prosecdef FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'dpdp_retention'::pg_catalog.regnamespace AND p.proname LIKE 'purge\_%'
     ORDER BY p.proname
  LOOP
    IF f.prosecdef THEN
      RAISE EXCEPTION 'dpdp_retention.% must be SECURITY INVOKER', f.proname;
    END IF;
    EXECUTE pg_catalog.format('SELECT dpdp_retention.%I($1)', f.proname) INTO part USING inst;
    result := result || COALESCE(part, '{}'::jsonb);
  END LOOP;
  RETURN result;
END
$$;
--> statement-breakpoint
CREATE FUNCTION public.campusos_purge_platform()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  n_sessions integer;
  n_tokens integer;
BEGIN
  -- A day's margin: these columns are timestamp without time zone.
  DELETE FROM public.sessions WHERE expires < now() - interval '1 day';
  GET DIAGNOSTICS n_sessions = ROW_COUNT;
  DELETE FROM public."verificationToken" WHERE expires < now() - interval '1 day';
  GET DIAGNOSTICS n_tokens = ROW_COUNT;
  RETURN jsonb_build_object('sessions', n_sessions, 'verificationToken', n_tokens);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.campusos_purge_expired(uuid), public.campusos_purge_platform() FROM PUBLIC;
--> statement-breakpoint
CREATE TABLE breach_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  recorded_by text REFERENCES users(id) ON DELETE SET NULL,
  aware_at timestamptz NOT NULL,
  description text NOT NULL CONSTRAINT breach_description CHECK (length(trim(description)) BETWEEN 10 AND 4000),
  likely_impact text NOT NULL CONSTRAINT breach_impact CHECK (length(trim(likely_impact)) BETWEEN 3 AND 4000),
  measures text CONSTRAINT breach_measures CHECK (measures IS NULL OR length(measures) <= 4000),
  board_told_at timestamptz,
  board_report_at timestamptz,
  people_told_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT breach_aware_before_recorded CHECK (aware_at <= created_at)
);
--> statement-breakpoint
CREATE INDEX breach_incidents_open ON breach_incidents (institution_id, closed_at, aware_at DESC);
--> statement-breakpoint
ALTER TABLE breach_incidents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY breach_incidents_tenant_isolation ON breach_incidents AS PERMISSIVE FOR ALL TO campusos_app
  USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid)
  WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE FUNCTION breach_incident_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.institution_id IS DISTINCT FROM OLD.institution_id
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.aware_at IS DISTINCT FROM OLD.aware_at
     OR NEW.description IS DISTINCT FROM OLD.description OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.board_told_at IS NOT NULL AND NEW.board_told_at IS DISTINCT FROM OLD.board_told_at)
     OR (OLD.board_report_at IS NOT NULL AND NEW.board_report_at IS DISTINCT FROM OLD.board_report_at)
     OR (OLD.people_told_at IS NOT NULL AND NEW.people_told_at IS DISTINCT FROM OLD.people_told_at) THEN
    RAISE EXCEPTION 'a breach record keeps what was recorded; steps are stamped once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'breach_incident_fixed';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER breach_incidents_guard BEFORE UPDATE ON breach_incidents
  FOR EACH ROW EXECUTE FUNCTION breach_incident_guard();
--> statement-breakpoint
REVOKE ALL ON breach_incidents FROM campusos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON breach_incidents TO campusos_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION breach_incident_guard() FROM PUBLIC;

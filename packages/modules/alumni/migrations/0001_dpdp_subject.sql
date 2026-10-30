-- P1-08a: alumni's part in erasing and exporting a person (AUD-03, decisions 220, 221).
-- Overwrites:
--   alumni_profiles: qualification becomes [erased]; employer, contact_email become NULL.
-- Rows about a person keyed by someone else: alumni_registrations of the person's profile.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_subject.erase_alumni(text);
--   DROP VIEW IF EXISTS dpdp_subject.alumni_about;

-- Pre-flight: core 0012.
DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core migration 0012 (dpdp_subject) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_alumni(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_alumni_profiles integer := 0;
  n_step integer;
BEGIN
  UPDATE alumni_profiles SET qualification = '[erased]', employer = NULL, contact_email = NULL
   WHERE user_id = who AND (qualification <> '[erased]' OR employer IS NOT NULL OR contact_email IS NOT NULL);
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_alumni_profiles := n_alumni_profiles + n_step;
  RETURN jsonb_build_object('alumni_profiles', n_alumni_profiles);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_alumni(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_alumni(text) TO campusos_app;
--> statement-breakpoint
CREATE OR REPLACE VIEW dpdp_subject.alumni_about WITH (security_invoker = true) AS
  SELECT p.user_id AS subject_id, 'alumni_registrations'::text AS source, to_jsonb(r) AS row_data
    FROM public.alumni_registrations r JOIN public.alumni_profiles p ON p.id = r.profile_id;
--> statement-breakpoint
GRANT SELECT ON dpdp_subject.alumni_about TO campusos_app;

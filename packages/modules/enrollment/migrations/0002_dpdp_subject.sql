-- P1-08a: enrollment's part in erasing and exporting a person (AUD-03, decisions 220, 221).
-- Overwrites:
--   nothing (this module holds no free text about a person to overwrite).
-- Rows about a person keyed by someone else: enrollment_registration_events of the person's registrations.
--
-- Rollback:
--   DROP VIEW IF EXISTS dpdp_subject.enrollment_about;

-- Pre-flight: core 0012.
DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core migration 0012 (dpdp_subject) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE VIEW dpdp_subject.enrollment_about WITH (security_invoker = true) AS
  SELECT r.student_id AS subject_id, 'enrollment_registration_events'::text AS source, to_jsonb(e) AS row_data
    FROM public.enrollment_registration_events e JOIN public.enrollment_registrations r ON r.id = e.registration_id;
--> statement-breakpoint
GRANT SELECT ON dpdp_subject.enrollment_about TO campusos_app;

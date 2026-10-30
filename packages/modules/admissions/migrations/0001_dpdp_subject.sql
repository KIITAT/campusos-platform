-- P1-08a: admissions's part in erasing and exporting a person (AUD-03, decisions 220, 221).
-- Overwrites:
--   admissions_enquiries: name becomes [erased]; email becomes erased+<id>@invalid; phone, note become NULL (for the enquiry behind the person's application).
-- Rows about a person keyed by someone else: admissions_enquiries behind the person's application.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_subject.erase_admissions(text);
--   DROP VIEW IF EXISTS dpdp_subject.admissions_about;

-- Pre-flight: core 0012.
DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core migration 0012 (dpdp_subject) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_admissions(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_admissions_enquiries integer := 0;
  n_step integer;
BEGIN
  UPDATE admissions_enquiries e SET name = '[erased]', email = 'erased+' || e.id || '@invalid', phone = NULL, note = NULL
    FROM admissions_applications a
   WHERE a.enquiry_id = e.id AND a.student_id = who AND e.name <> '[erased]';
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_admissions_enquiries := n_admissions_enquiries + n_step;
  RETURN jsonb_build_object('admissions_enquiries', n_admissions_enquiries);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_admissions(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_admissions(text) TO campusos_app;
--> statement-breakpoint
CREATE OR REPLACE VIEW dpdp_subject.admissions_about WITH (security_invoker = true) AS
  SELECT a.student_id AS subject_id, 'admissions_enquiries'::text AS source, to_jsonb(e) AS row_data
    FROM public.admissions_enquiries e JOIN public.admissions_applications a ON a.enquiry_id = e.id
   WHERE a.student_id IS NOT NULL;
--> statement-breakpoint
GRANT SELECT ON dpdp_subject.admissions_about TO campusos_app;

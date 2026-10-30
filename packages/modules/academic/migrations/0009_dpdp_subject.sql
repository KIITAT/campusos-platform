-- P1-08a: academic's part in erasing and exporting a person (AUD-03, decisions 220, 221).
-- Overwrites:
--   academic_student_profiles: phone, address_line, city, state, postal_code, emergency_contact become NULL.
-- Rows about a person keyed by someone else: none
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_subject.erase_academic(text);

-- Pre-flight: core 0012.
DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core migration 0012 (dpdp_subject) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_academic(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_academic_student_profiles integer := 0;
  n_step integer;
BEGIN
  UPDATE academic_student_profiles SET phone = NULL, address_line = NULL, city = NULL, state = NULL, postal_code = NULL, emergency_contact = NULL
   WHERE student_id = who AND (phone IS NOT NULL OR address_line IS NOT NULL OR city IS NOT NULL OR state IS NOT NULL OR postal_code IS NOT NULL OR emergency_contact IS NOT NULL);
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_academic_student_profiles := n_academic_student_profiles + n_step;
  RETURN jsonb_build_object('academic_student_profiles', n_academic_student_profiles);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_academic(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_academic(text) TO campusos_app;

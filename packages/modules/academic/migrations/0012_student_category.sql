-- P1-12a: the student's reservation category on the profile (FUNC-09, D7 of plans/P1-12a.md).
-- Kept by the office; returned only to the student, a guardian and the office; cleared by erasure.
-- Numbered 0012: 0011 belongs to P1-13a, built in parallel; nothing here depends on it.
-- Adds only. Rollback:
--   ALTER TABLE academic_student_profiles DROP CONSTRAINT IF EXISTS academic_student_profiles_category;
--   ALTER TABLE academic_student_profiles DROP COLUMN IF EXISTS category;
--   then re-run academic/0009_dpdp_subject.sql to restore the previous erase function.

-- Pre-flight: academic 0009. No existing row can violate the new check: the column is new and nullable.
DO $$
BEGIN
  IF to_regprocedure('dpdp_subject.erase_academic(text)') IS NULL THEN
    RAISE EXCEPTION 'academic migration 0009 (dpdp_subject) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "academic_student_profiles" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "academic_student_profiles" ADD CONSTRAINT "academic_student_profiles_category" CHECK (category is null or category in ('general','ews','obc','sc','st'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_academic(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_academic_student_profiles integer := 0;
BEGIN
  UPDATE academic_student_profiles SET phone = NULL, address_line = NULL, city = NULL, state = NULL, postal_code = NULL, emergency_contact = NULL, category = NULL
   WHERE student_id = who AND (phone IS NOT NULL OR address_line IS NOT NULL OR city IS NOT NULL OR state IS NOT NULL OR postal_code IS NOT NULL OR emergency_contact IS NOT NULL OR category IS NOT NULL);
  GET DIAGNOSTICS n_academic_student_profiles = ROW_COUNT;
  RETURN jsonb_build_object('academic_student_profiles', n_academic_student_profiles);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_academic(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_academic(text) TO campusos_app;

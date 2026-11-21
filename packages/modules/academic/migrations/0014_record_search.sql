-- P1-09c, UX-04: indexes for the roll and registration lookups behind record search (decision 1005).
-- Numbered 0014: 0013 is held for P1-13c, built in parallel; nothing here depends on it.
-- Pre-flight: academic_student_profiles exists and neither index name is taken. Adds only.
-- Rollback:
--   DROP INDEX IF EXISTS public.academic_student_profiles_registration_lookup;
--   DROP INDEX IF EXISTS public.academic_student_profiles_roll_lookup;
DO $$
BEGIN
  IF to_regclass('public.academic_student_profiles') IS NULL THEN
    RAISE EXCEPTION 'record search needs academic_student_profiles (academic 0003 and later)';
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX academic_student_profiles_roll_lookup
  ON public.academic_student_profiles (institution_id,lower(roll_no));
--> statement-breakpoint
CREATE INDEX academic_student_profiles_registration_lookup
  ON public.academic_student_profiles (institution_id,lower(registration_no));

-- P1-09c, UX-04: stored lower-cased roll and registration numbers with tenant-leading indexes, so an
-- exact lookup is an index condition under row-level security (lower() is not leakproof: NEW-175).
-- Numbered 0014: 0013 is held for P1-13c, built in parallel; nothing here depends on it.
-- The column is stored, so adding it rewrites academic_student_profiles and rebuilds its indexes under an exclusive lock: run it in a
-- quiet window on a large hub. The statement timeout is lifted for this transaction, since the installer runs
-- migrations on the auth pool, whose limit is 30 s (measured: cancelled at 30 s past about 4.5M rows; NEW-80 class,
-- edited in place before any hub ran it). The lock wait is capped at 5 s so a migration stuck behind a long report
-- fails fast and is retried, instead of queueing every write behind it.
-- Pre-flight: academic_student_profiles exists and has neither column. Adds only.
-- Rollback:
--   DROP INDEX IF EXISTS public.academic_student_profiles_registration_key;
--   DROP INDEX IF EXISTS public.academic_student_profiles_roll_key;
--   ALTER TABLE public.academic_student_profiles DROP COLUMN IF EXISTS registration_key, DROP COLUMN IF EXISTS roll_key;
DO $$
BEGIN
  IF to_regclass('public.academic_student_profiles') IS NULL THEN
    RAISE EXCEPTION 'record search needs academic_student_profiles (academic 0003 and later)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='academic_student_profiles' AND column_name IN ('roll_key','registration_key')) THEN
    RAISE EXCEPTION 'academic_student_profiles already has roll_key or registration_key';
  END IF;
END $$;
--> statement-breakpoint
SET LOCAL statement_timeout = 0;--> statement-breakpoint
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.academic_student_profiles
  ADD COLUMN roll_key text GENERATED ALWAYS AS (lower(roll_no)) STORED,
  ADD COLUMN registration_key text GENERATED ALWAYS AS (lower(registration_no)) STORED;
--> statement-breakpoint
CREATE INDEX academic_student_profiles_roll_key ON public.academic_student_profiles (institution_id, roll_key);
--> statement-breakpoint
CREATE INDEX academic_student_profiles_registration_key ON public.academic_student_profiles (institution_id, registration_key);

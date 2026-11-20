-- P1-13a: a school's class is a programme of level 'school' (decision D3/D4 of
-- plans/P1-13a.md), and a student's house is kept on their profile (D5).
--
-- Rollback:
--   ALTER TABLE academic_student_profiles DROP CONSTRAINT IF EXISTS academic_student_profiles_house;
--   ALTER TABLE academic_student_profiles DROP COLUMN IF EXISTS house;
--   The enum value 'school' stays: Postgres cannot drop an enum value. Unused
--   it is harmless; to remove it, recreate the type only once
--   `select count(*) from academic_programs where level = 'school'` is 0.

-- Pre-flight: the profile table (academic 0004).
DO $$
BEGIN
  IF to_regclass('public.academic_student_profiles') IS NULL THEN
    RAISE EXCEPTION 'academic migration 0004 (student profiles) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
ALTER TYPE "public"."academic_program_level" ADD VALUE IF NOT EXISTS 'school';--> statement-breakpoint
ALTER TABLE "academic_student_profiles" ADD COLUMN IF NOT EXISTS "house" text;--> statement-breakpoint
ALTER TABLE "academic_student_profiles" ADD CONSTRAINT "academic_student_profiles_house" CHECK (house is null or length(trim(house)) between 1 and 40);

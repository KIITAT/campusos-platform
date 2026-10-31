-- P1-08b: a guardian's access lapses when the student turns 18 unless the student keeps it (AUD-04, decision D8 of plans/P1-08b.md).
-- Adds only. Rollback:
--   ALTER TABLE parent_links DROP COLUMN IF EXISTS adult_confirmed_at;

-- Pre-flight: core 0014.
DO $$
BEGIN
  IF to_regprocedure('public.campusos_age_status(text)') IS NULL THEN
    RAISE EXCEPTION 'core migration 0014 (campusos_age_status) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "parent_links" ADD COLUMN "adult_confirmed_at" timestamp with time zone;

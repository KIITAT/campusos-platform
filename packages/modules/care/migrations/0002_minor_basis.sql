-- P1-08b: a student under 18 takes a self-check only with a guardian's consent or under a documented educational exemption (AUD-04, decision D10 of plans/P1-08b.md).
-- Adds only: the new trigger refuses INSERTS on care_results; results already taken stay.
-- Rollback:
--   DROP TRIGGER IF EXISTS care_results_minor_guard ON care_results;
--   DROP FUNCTION IF EXISTS care_results_minor_guard();
--   ALTER TABLE care_settings DROP CONSTRAINT IF EXISTS care_settings_minor_basis;
--   ALTER TABLE care_settings DROP COLUMN IF EXISTS minor_basis_note;
--   ALTER TABLE care_settings DROP COLUMN IF EXISTS minor_basis;

-- Pre-flight: core 0014.
DO $$
BEGIN
  IF to_regprocedure('public.campusos_age_status(text)') IS NULL OR to_regclass('public.guardian_consents') IS NULL THEN
    RAISE EXCEPTION 'core migration 0014 (age status and guardian consents) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "care_settings" ADD COLUMN "minor_basis" text DEFAULT 'guardian_consent' NOT NULL;--> statement-breakpoint
ALTER TABLE "care_settings" ADD COLUMN "minor_basis_note" text;--> statement-breakpoint
ALTER TABLE "care_settings" ADD CONSTRAINT "care_settings_minor_basis" CHECK (
  minor_basis IN ('guardian_consent', 'educational_exemption')
  AND (minor_basis = 'guardian_consent' OR length(trim(minor_basis_note)) BETWEEN 20 AND 500)
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION care_results_minor_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF public.campusos_age_status(NEW.student_id) <> 'adult'
     AND COALESCE((SELECT minor_basis FROM care_settings WHERE institution_id = NEW.institution_id), 'guardian_consent') <> 'educational_exemption'
     AND NOT EXISTS (
       SELECT 1 FROM (
         SELECT decision FROM guardian_consents
          WHERE student_id = NEW.student_id AND purpose = 'care_self_checks'
          ORDER BY recorded_at DESC, id DESC LIMIT 1
       ) latest WHERE latest.decision = 'given'
     ) THEN
    RAISE EXCEPTION 'a parent or guardian must agree before you can take a self-check here'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_result_minor';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "care_results_minor_guard" BEFORE INSERT ON "care_results"
  FOR EACH ROW EXECUTE FUNCTION care_results_minor_guard();

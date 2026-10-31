-- P1-08b: the APAAR ID, kept only while consent to it stands (FUNC-09, decisions D12, D13 of plans/P1-08b.md).
-- The ID is stored as given; nothing here checks it with APAAR.
-- Adds only. Rollback:
--   DROP TRIGGER IF EXISTS academic_student_profiles_apaar_guard ON academic_student_profiles;
--   DROP FUNCTION IF EXISTS academic_apaar_guard();
--   DROP INDEX IF EXISTS academic_student_profiles_apaar_unique;
--   ALTER TABLE academic_student_profiles DROP CONSTRAINT IF EXISTS academic_student_profiles_apaar;
--   ALTER TABLE academic_student_profiles DROP COLUMN IF EXISTS apaar_id;

-- Pre-flight: core 0014.
DO $$
BEGIN
  IF to_regclass('public.guardian_consents') IS NULL THEN
    RAISE EXCEPTION 'core migration 0014 (guardian_consents) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "academic_student_profiles" ADD COLUMN "apaar_id" text;--> statement-breakpoint
ALTER TABLE "academic_student_profiles" ADD CONSTRAINT "academic_student_profiles_apaar" CHECK (apaar_id is null or apaar_id ~ '^[0-9]{12}$');--> statement-breakpoint
CREATE UNIQUE INDEX "academic_student_profiles_apaar_unique" ON "academic_student_profiles" USING btree ("institution_id","apaar_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION academic_apaar_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.apaar_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.apaar_id IS DISTINCT FROM OLD.apaar_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM (
        SELECT decision FROM guardian_consents
         WHERE student_id = NEW.student_id AND purpose = 'apaar'
         ORDER BY recorded_at DESC, id DESC LIMIT 1
      ) latest WHERE latest.decision = 'given'
    ) THEN
      RAISE EXCEPTION 'record the parent’s or student’s consent to APAAR before saving the ID'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'academic_apaar_needs_consent';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "academic_student_profiles_apaar_guard" BEFORE INSERT OR UPDATE OF apaar_id ON "academic_student_profiles"
  FOR EACH ROW EXECUTE FUNCTION academic_apaar_guard();

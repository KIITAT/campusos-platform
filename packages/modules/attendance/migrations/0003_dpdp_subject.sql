-- P1-08a: attendance's part in erasing and exporting a person (AUD-03, decisions 220, 221).
-- Overwrites:
--   attendance_excuses: reason becomes [erased]; a revoke_reason becomes [erased] (a revoked excuse needs one).
--   attendance_records: latitude, longitude, accuracy_m become NULL.
-- Rows about a person keyed by someone else: none
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_subject.erase_attendance(text);
--   attendance_excuse_guard: re-run its CREATE OR REPLACE FUNCTION from 0001_excuses_and_rules.sql (or the last migration that redefined it).

-- Pre-flight: core 0012.
DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core migration 0012 (dpdp_subject) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.attendance_excuse_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- An erased person's free text may be overwritten (P1-08a); nothing else changes.
  IF TG_OP = 'UPDATE' AND public.campusos_erasure_allows(OLD.student_id, to_jsonb(OLD), to_jsonb(NEW), ARRAY['reason', 'revoke_reason']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id)
       AND (OLD.offering_id IS NULL OR EXISTS (SELECT 1 FROM academic_offerings WHERE id = OLD.offering_id)) THEN
      RAISE EXCEPTION 'an excuse is revoked, not deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'attendance_excuse_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
       OR (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by', 'revoke_reason'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by', 'revoke_reason']) THEN
      RAISE EXCEPTION 'an excuse is only revoked, once'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'attendance_excuse_fixed';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.student_id AND role = 'student') THEN
    RAISE EXCEPTION 'an excuse is for a student'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'attendance_excuse_student';
  END IF;
  IF NEW.offering_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM academic_offerings o
      JOIN academic_section_members m ON m.section_id = o.section_id AND m.user_id = NEW.student_id
     WHERE o.id = NEW.offering_id) THEN
    RAISE EXCEPTION 'that is not one of the student''s classes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'attendance_excuse_class';
  END IF;
  NEW.granted_at := now();
  NEW.revoked_at := NULL;
  NEW.revoked_by := NULL;
  NEW.revoke_reason := NULL;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_attendance(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_attendance_excuses integer := 0;
  n_attendance_records integer := 0;
  n_step integer;
BEGIN
  UPDATE attendance_excuses SET reason = '[erased]',
         revoke_reason = CASE WHEN revoked_at IS NULL THEN NULL ELSE '[erased]' END
   WHERE student_id = who AND (reason <> '[erased]' OR (revoke_reason IS NOT NULL AND revoke_reason <> '[erased]'));
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_attendance_excuses := n_attendance_excuses + n_step;
  UPDATE attendance_records SET latitude = NULL, longitude = NULL, accuracy_m = NULL
   WHERE student_id = who AND (latitude IS NOT NULL OR longitude IS NOT NULL OR accuracy_m IS NOT NULL);
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_attendance_records := n_attendance_records + n_step;
  RETURN jsonb_build_object('attendance_excuses', n_attendance_excuses, 'attendance_records', n_attendance_records);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_attendance(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_attendance(text) TO campusos_app;

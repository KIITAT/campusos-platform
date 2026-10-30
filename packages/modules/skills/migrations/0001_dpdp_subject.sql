-- P1-08a: skills's part in erasing and exporting a person (AUD-03, decisions 220, 221).
-- Overwrites:
--   skill_assessments: evidence becomes NULL; a faculty assessment needs evidence, so it becomes [evidence erased].
-- Rows about a person keyed by someone else: none
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_subject.erase_skills(text);
--   skill_assessment_guard: re-run its CREATE OR REPLACE FUNCTION from 0000_skills.sql (or the last migration that redefined it).

-- Pre-flight: core 0012.
DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core migration 0012 (dpdp_subject) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.skill_assessment_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  s record;
  student_role text;
  assessor_role text;
BEGIN
  -- An erased person's free text may be overwritten (P1-08a); nothing else changes.
  IF TG_OP = 'UPDATE' AND public.campusos_erasure_allows(OLD.student_id, to_jsonb(OLD), to_jsonb(NEW), ARRAY['evidence']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
      RAISE EXCEPTION 'a judgement is kept; record a new one instead'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- An assessor's account going sets it to null; nothing else moves.
    IF (to_jsonb(NEW) - 'assessor_id') IS DISTINCT FROM (to_jsonb(OLD) - 'assessor_id')
       OR NEW.assessor_id IS NOT NULL AND NEW.assessor_id IS DISTINCT FROM OLD.assessor_id THEN
      RAISE EXCEPTION 'a judgement is kept as written; record a new one instead'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_final';
    END IF;
    RETURN NEW;
  END IF;

  SELECT framework_id, retired_at INTO s FROM skill_skills WHERE id = NEW.skill_id;
  IF s.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'that skill is retired'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_retired';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM skill_levels WHERE framework_id = s.framework_id AND rank = NEW.rank) THEN
    RAISE EXCEPTION 'that level is not on this skill''s scale'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_level';
  END IF;
  SELECT role::text INTO student_role FROM users WHERE id = NEW.student_id;
  IF student_role IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'skills are recorded for students'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_student';
  END IF;
  IF NEW.source = 'self' THEN
    IF NEW.assessor_id IS DISTINCT FROM NEW.student_id THEN
      RAISE EXCEPTION 'a self-assessment is by the student'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_self';
    END IF;
  ELSE
    SELECT role::text INTO assessor_role FROM users WHERE id = NEW.assessor_id;
    IF NEW.assessor_id = NEW.student_id
       OR assessor_role IS NULL
       OR assessor_role NOT IN ('faculty', 'hod', 'institution_admin', 'super_admin') THEN
      RAISE EXCEPTION 'a teacher''s judgement is by a member of staff'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_assessor';
    END IF;
  END IF;
  IF NEW.assessed_on > current_date THEN
    RAISE EXCEPTION 'a judgement is not dated in the future'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'skill_assessment_date';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_skills(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_skill_assessments integer := 0;
  n_step integer;
BEGIN
  UPDATE skill_assessments SET evidence = CASE WHEN source = 'faculty' THEN '[evidence erased]' ELSE NULL END
   WHERE student_id = who AND evidence IS NOT NULL AND evidence <> '[evidence erased]';
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_skill_assessments := n_skill_assessments + n_step;
  RETURN jsonb_build_object('skill_assessments', n_skill_assessments);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_skills(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_skills(text) TO campusos_app;

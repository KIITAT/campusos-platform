-- P1-08a: mentoring's part in erasing and exporting a person (AUD-03, decisions 220, 221).
-- Overwrites:
--   mentor_notes, mentor_messages: body becomes [erased].
--   mentor_leave_applications: purpose, place_of_visit become [erased]; contact_phone becomes 0000000; decision_note and the uploaded document (name, digest, size, bytes) become NULL.
--   mentor_assignments: reason becomes NULL.
-- Rows about a person keyed by someone else: none
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_subject.erase_mentoring(text);
--   mentor_assignment_guard: re-run its CREATE OR REPLACE FUNCTION from 0000_mentoring.sql (or the last migration that redefined it).
--   mentor_note_guard: re-run its CREATE OR REPLACE FUNCTION from 0000_mentoring.sql (or the last migration that redefined it).
--   mentor_message_guard: re-run its CREATE OR REPLACE FUNCTION from 0000_mentoring.sql (or the last migration that redefined it).
--   mentor_leave_guard: re-run its CREATE OR REPLACE FUNCTION from 0000_mentoring.sql (or the last migration that redefined it).

-- Pre-flight: core 0012.
DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core migration 0012 (dpdp_subject) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mentor_assignment_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- An erased person's free text may be overwritten (P1-08a); nothing else changes.
  IF TG_OP = 'UPDATE' AND public.campusos_erasure_allows(OLD.student_id, to_jsonb(OLD), to_jsonb(NEW), ARRAY['reason']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
      RAISE EXCEPTION 'an assignment is ended, not deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_assignment_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.to_on IS NOT NULL OR NEW.to_on IS NULL
       OR (to_jsonb(NEW) - 'to_on') IS DISTINCT FROM (to_jsonb(OLD) - 'to_on') THEN
      RAISE EXCEPTION 'an assignment only ends, once'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_assignment_fixed';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.student_id AND role = 'student') THEN
    RAISE EXCEPTION 'a mentee is a student'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_student';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.mentor_id AND role IN ('faculty', 'hod', 'institution_admin'))
     OR (NEW.co_mentor_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.co_mentor_id AND role IN ('faculty', 'hod', 'institution_admin'))) THEN
    RAISE EXCEPTION 'a mentor is a member of staff'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_staff';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mentor_note_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- An erased person's free text may be overwritten (P1-08a); nothing else changes.
  IF TG_OP = 'UPDATE' AND public.campusos_erasure_allows(OLD.student_id, to_jsonb(OLD), to_jsonb(NEW), ARRAY['body']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.author_id AND role IN ('faculty', 'hod', 'institution_admin')) THEN
      RAISE EXCEPTION 'notes are written by staff'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_note_author';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND (NOT EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
                           OR NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'a note is kept as written; add another to correct it'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_note_kept';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mentor_message_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- An erased person's free text may be overwritten (P1-08a); nothing else changes.
  IF TG_OP = 'UPDATE' AND public.campusos_erasure_allows(OLD.student_id, to_jsonb(OLD), to_jsonb(NEW), ARRAY['body']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.sender_id IS DISTINCT FROM NEW.student_id
       AND NOT EXISTS (SELECT 1 FROM mentor_assignments a
                        WHERE a.student_id = NEW.student_id AND a.to_on IS NULL
                          AND NEW.sender_id IN (a.mentor_id, a.co_mentor_id))
       AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.sender_id AND role = 'institution_admin') THEN
      RAISE EXCEPTION 'only the student and their mentors write here'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_message_sender';
    END IF;
    NEW.sent_at := now();
    NEW.read_at := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.read_at IS NOT NULL OR NEW.read_at IS NULL
       OR (to_jsonb(NEW) - 'read_at') IS DISTINCT FROM (to_jsonb(OLD) - 'read_at') THEN
      RAISE EXCEPTION 'a message is left as it was sent'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_message_fixed';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
     OR NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'a message is kept'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_message_kept';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.mentor_leave_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  t record;
  decision text[] := ARRAY['status', 'decided_by', 'decided_at', 'decision_note', 'hostel_leave_id'];
BEGIN
  -- An erased person's free text may be overwritten (P1-08a); nothing else changes.
  IF TG_OP = 'UPDATE' AND public.campusos_erasure_allows(OLD.student_id, to_jsonb(OLD), to_jsonb(NEW), ARRAY['purpose', 'place_of_visit', 'contact_phone', 'decision_note', 'document_name', 'document_sha256', 'document_size', 'document']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
      RAISE EXCEPTION 'a leave application is kept'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_kept';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.student_id AND role = 'student') THEN
      RAISE EXCEPTION 'leave is asked for by a student'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_student';
    END IF;
    SELECT needs_document, max_days, retired_at INTO t FROM mentor_leave_types WHERE id = NEW.leave_type_id;
    IF t.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'that kind of leave is no longer offered'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_type_retired';
    END IF;
    IF t.needs_document AND NEW.document IS NULL THEN
      RAISE EXCEPTION 'that kind of leave needs a supporting document'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_document_required';
    END IF;
    IF t.max_days IS NOT NULL AND (NEW.ends_on - NEW.starts_on + 1) > t.max_days THEN
      RAISE EXCEPTION 'that is longer than this kind of leave allows'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_too_long';
    END IF;
    IF EXISTS (SELECT 1 FROM mentor_leave_applications
                WHERE student_id = NEW.student_id AND status IN ('pending', 'approved')
                  AND daterange(starts_on, ends_on, '[]') && daterange(NEW.starts_on, NEW.ends_on, '[]')) THEN
      RAISE EXCEPTION 'you already have leave asked for or granted over those days'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_overlap';
    END IF;
    SELECT mentor_id INTO NEW.mentor_id FROM mentor_assignments
     WHERE student_id = NEW.student_id AND to_on IS NULL;
    NEW.status := 'pending';
    NEW.decided_by := NULL;
    NEW.decided_at := NULL;
    NEW.decision_note := NULL;
    NEW.hostel_leave_id := NULL;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - decision) IS DISTINCT FROM (to_jsonb(OLD) - decision) THEN
    RAISE EXCEPTION 'what was asked for does not change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_fixed';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
            OR (OLD.status = 'approved' AND NEW.status = 'cancelled')) THEN
      RAISE EXCEPTION 'that leave has been decided'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_decided';
    END IF;
    IF NEW.status = 'rejected' AND length(trim(coalesce(NEW.decision_note, ''))) < 5 THEN
      RAISE EXCEPTION 'say why the leave is refused'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_reason';
    END IF;
    NEW.decided_at := now();
  ELSIF (NEW.decided_by, NEW.decision_note) IS DISTINCT FROM (OLD.decided_by, OLD.decision_note) THEN
    RAISE EXCEPTION 'that leave has been decided'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_decided';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_mentoring(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_mentor_notes integer := 0;
  n_mentor_messages integer := 0;
  n_mentor_leave_applications integer := 0;
  n_mentor_assignments integer := 0;
  n_step integer;
BEGIN
  UPDATE mentor_notes SET body = '[erased]' WHERE student_id = who AND body <> '[erased]';
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_mentor_notes := n_mentor_notes + n_step;
  UPDATE mentor_messages SET body = '[erased]' WHERE student_id = who AND body <> '[erased]';
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_mentor_messages := n_mentor_messages + n_step;
  UPDATE mentor_leave_applications SET purpose = '[erased]', place_of_visit = '[erased]', contact_phone = '0000000',
         decision_note = NULL, document_name = NULL, document_sha256 = NULL, document_size = NULL, document = NULL
   WHERE student_id = who AND (purpose <> '[erased]' OR document IS NOT NULL OR decision_note IS NOT NULL);
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_mentor_leave_applications := n_mentor_leave_applications + n_step;
  UPDATE mentor_assignments SET reason = NULL WHERE student_id = who AND reason IS NOT NULL;
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_mentor_assignments := n_mentor_assignments + n_step;
  RETURN jsonb_build_object('mentor_notes', n_mentor_notes, 'mentor_messages', n_mentor_messages, 'mentor_leave_applications', n_mentor_leave_applications, 'mentor_assignments', n_mentor_assignments);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_mentoring(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_mentoring(text) TO campusos_app;

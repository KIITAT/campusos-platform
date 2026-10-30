-- P1-08a: care's part in erasing and exporting a person (AUD-03, decisions 220, 221).
-- Overwrites:
--   care_requests: message, preferred_times become NULL.
--   care_appointments: place becomes [erased]; note_to_student becomes NULL; a cancel_reason becomes [erased] (a cancelled appointment needs one).
--   care_notes: body becomes [erased].
--   care_results: the person's rows are deleted (their care_shared_results go with them).
-- Rows about a person keyed by someone else: care_notes, care_appointments and care_shared_results of the person's requests.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_subject.erase_care(text);
--   DROP VIEW IF EXISTS dpdp_subject.care_about;
--   care_request_guard: re-run its CREATE OR REPLACE FUNCTION from 0000_care.sql (or the last migration that redefined it).
--   care_appointment_guard: re-run its CREATE OR REPLACE FUNCTION from 0000_care.sql (or the last migration that redefined it).
--   care_note_guard: re-run its CREATE OR REPLACE FUNCTION from 0000_care.sql (or the last migration that redefined it).

-- Pre-flight: core 0012.
DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core migration 0012 (dpdp_subject) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.care_request_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  moving text[] := ARRAY['status', 'counsellor_id', 'accepted_at', 'closed_at', 'outcome', 'urgency'];
BEGIN
  -- An erased person's free text may be overwritten (P1-08a); nothing else changes.
  IF TG_OP = 'UPDATE' AND public.campusos_erasure_allows(OLD.student_id, to_jsonb(OLD), to_jsonb(NEW), ARRAY['message', 'preferred_times']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
      RAISE EXCEPTION 'a request for counselling is kept'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_kept';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.student_id AND role = 'student') THEN
      RAISE EXCEPTION 'counselling is asked for by a student'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_student';
    END IF;
    IF EXISTS (SELECT 1 FROM care_requests WHERE student_id = NEW.student_id AND status IN ('waiting', 'accepted')) THEN
      RAISE EXCEPTION 'you already have a request open'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_open';
    END IF;
    NEW.status := 'waiting';
    NEW.counsellor_id := NULL;
    NEW.accepted_at := NULL;
    NEW.closed_at := NULL;
    NEW.outcome := NULL;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  -- The counsellor's account removed: the case stays, without them.
  IF NEW.counsellor_id IS NULL AND OLD.counsellor_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.counsellor_id)
     AND (to_jsonb(NEW) - 'counsellor_id') = (to_jsonb(OLD) - 'counsellor_id') THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - moving) IS DISTINCT FROM (to_jsonb(OLD) - moving)
     OR NEW.urgency < OLD.urgency THEN
    RAISE EXCEPTION 'what the student asked does not change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_fixed';
  END IF;
  IF OLD.status IN ('closed', 'withdrawn') THEN
    RAISE EXCEPTION 'that request is finished'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_final';
  END IF;
  IF NOT ((OLD.status = NEW.status)
          OR (OLD.status = 'waiting' AND NEW.status IN ('accepted', 'withdrawn'))
          OR (OLD.status = 'accepted' AND NEW.status IN ('closed', 'withdrawn'))) THEN
    RAISE EXCEPTION 'a request is taken, then closed or withdrawn'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_final';
  END IF;
  IF NEW.status = 'waiting' AND NEW.counsellor_id IS NOT NULL THEN
    RAISE EXCEPTION 'a counsellor takes a request by accepting it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_counsellor';
  END IF;
  IF NEW.status = 'accepted' AND NEW.counsellor_id IS DISTINCT FROM OLD.counsellor_id
     AND NOT EXISTS (SELECT 1 FROM care_counsellors
                      WHERE user_id = NEW.counsellor_id AND institution_id = NEW.institution_id AND active) THEN
    RAISE EXCEPTION 'that is not one of the counsellors'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_counsellor';
  END IF;
  IF NEW.status IN ('closed', 'withdrawn') AND NEW.counsellor_id IS DISTINCT FROM OLD.counsellor_id THEN
    RAISE EXCEPTION 'a request is handed over while it is open'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_counsellor';
  END IF;
  IF OLD.status = 'waiting' AND NEW.status = 'accepted' THEN
    NEW.accepted_at := now();
  ELSE
    NEW.accepted_at := OLD.accepted_at;
  END IF;
  IF NEW.status IN ('closed', 'withdrawn') THEN
    NEW.closed_at := now();
  ELSE
    NEW.closed_at := OLD.closed_at;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.care_appointment_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  outcome text[] := ARRAY['status', 'cancelled_by', 'cancel_reason'];
BEGIN
  -- An erased person's free text may be overwritten (P1-08a); nothing else changes.
  IF TG_OP = 'UPDATE' AND public.campusos_erasure_allows((SELECT r.student_id FROM care_requests r WHERE r.id = OLD.request_id), to_jsonb(OLD), to_jsonb(NEW), ARRAY['place', 'note_to_student', 'cancel_reason']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM care_requests WHERE id = OLD.request_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.counsellor_id) THEN
      RAISE EXCEPTION 'an appointment is cancelled, not deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_appointment_kept';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM care_requests
                    WHERE id = NEW.request_id AND status = 'accepted' AND counsellor_id = NEW.counsellor_id) THEN
      RAISE EXCEPTION 'appointments are made by the counsellor holding an open case'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_appointment_case';
    END IF;
    IF EXISTS (SELECT 1 FROM care_appointments
                WHERE counsellor_id = NEW.counsellor_id AND status IN ('booked', 'held')
                  AND tstzrange(starts_at, ends_at) && tstzrange(NEW.starts_at, NEW.ends_at)) THEN
      RAISE EXCEPTION 'you have another appointment then'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_appointment_clash';
    END IF;
    NEW.status := 'booked';
    NEW.cancelled_by := NULL;
    NEW.cancel_reason := NULL;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  -- The person who cancelled it removed: the record stays, without them.
  IF NEW.cancelled_by IS NULL AND OLD.cancelled_by IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.cancelled_by)
     AND (to_jsonb(NEW) - 'cancelled_by') = (to_jsonb(OLD) - 'cancelled_by') THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - outcome) IS DISTINCT FROM (to_jsonb(OLD) - outcome) THEN
    RAISE EXCEPTION 'an appointment is cancelled and made again, not moved'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_appointment_fixed';
  END IF;
  IF OLD.status <> 'booked' OR NEW.status = 'booked' THEN
    RAISE EXCEPTION 'that appointment is already recorded'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_appointment_final';
  END IF;
  IF NEW.status IN ('held', 'missed') AND OLD.starts_at > now() THEN
    RAISE EXCEPTION 'an appointment is recorded once it has begun'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_appointment_early';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.care_note_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- An erased person's free text may be overwritten (P1-08a); nothing else changes.
  IF TG_OP = 'UPDATE' AND public.campusos_erasure_allows((SELECT r.student_id FROM care_requests r WHERE r.id = OLD.request_id), to_jsonb(OLD), to_jsonb(NEW), ARRAY['body']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM care_requests
                    WHERE id = NEW.request_id AND counsellor_id = NEW.author_id AND status IN ('accepted', 'closed')) THEN
      RAISE EXCEPTION 'notes are written by the counsellor holding the case'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_note_author';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.author_id IS NULL AND OLD.author_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.author_id)
     AND (to_jsonb(NEW) - 'author_id') = (to_jsonb(OLD) - 'author_id') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND (NOT EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
                           OR NOT EXISTS (SELECT 1 FROM care_requests WHERE id = OLD.request_id)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'a note is kept as written; add another to correct it'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'care_note_kept';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_care(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_care_requests integer := 0;
  n_care_appointments integer := 0;
  n_care_notes integer := 0;
  n_care_results integer := 0;
  n_step integer;
BEGIN
  UPDATE care_requests SET message = NULL, preferred_times = NULL WHERE student_id = who AND (message IS NOT NULL OR preferred_times IS NOT NULL);
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_care_requests := n_care_requests + n_step;
  UPDATE care_appointments a SET place = '[erased]', note_to_student = NULL,
         cancel_reason = CASE WHEN a.cancel_reason IS NULL THEN NULL ELSE '[erased]' END
    FROM care_requests r
   WHERE r.id = a.request_id AND r.student_id = who
     AND (a.place <> '[erased]' OR a.note_to_student IS NOT NULL OR (a.cancel_reason IS NOT NULL AND a.cancel_reason <> '[erased]'));
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_care_appointments := n_care_appointments + n_step;
  UPDATE care_notes n SET body = '[erased]' FROM care_requests r WHERE r.id = n.request_id AND r.student_id = who AND n.body <> '[erased]';
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_care_notes := n_care_notes + n_step;
  DELETE FROM care_results WHERE student_id = who;
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_care_results := n_care_results + n_step;
  RETURN jsonb_build_object('care_requests', n_care_requests, 'care_appointments', n_care_appointments, 'care_notes', n_care_notes, 'care_results', n_care_results);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_care(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_care(text) TO campusos_app;
--> statement-breakpoint
CREATE OR REPLACE VIEW dpdp_subject.care_about WITH (security_invoker = true) AS
  SELECT r.student_id AS subject_id, 'care_notes'::text AS source, to_jsonb(n) AS row_data
    FROM public.care_notes n JOIN public.care_requests r ON r.id = n.request_id
  UNION ALL
  SELECT r.student_id, 'care_appointments'::text, to_jsonb(a)
    FROM public.care_appointments a JOIN public.care_requests r ON r.id = a.request_id
  UNION ALL
  SELECT r.student_id, 'care_shared_results'::text, to_jsonb(s)
    FROM public.care_shared_results s JOIN public.care_requests r ON r.id = s.request_id;
--> statement-breakpoint
GRANT SELECT ON dpdp_subject.care_about TO campusos_app;

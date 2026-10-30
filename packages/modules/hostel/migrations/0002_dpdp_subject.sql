-- P1-08a: hostel's part in erasing and exporting a person (AUD-03, decisions 220, 221).
-- Overwrites:
--   hostel_leaves: reason becomes [erased].
--   hostel_check_ins: note becomes NULL.
--   hostel_visitors: name becomes [erased]; phone, relation, purpose become NULL.
-- Rows about a person keyed by someone else: none
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_subject.erase_hostel(text);

-- Pre-flight: core 0012.
DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core migration 0012 (dpdp_subject) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_hostel(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_hostel_leaves integer := 0;
  n_hostel_check_ins integer := 0;
  n_hostel_visitors integer := 0;
  n_step integer;
BEGIN
  UPDATE hostel_leaves SET reason = '[erased]' WHERE student_id = who AND reason <> '[erased]';
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_hostel_leaves := n_hostel_leaves + n_step;
  UPDATE hostel_check_ins SET note = NULL WHERE student_id = who AND note IS NOT NULL;
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_hostel_check_ins := n_hostel_check_ins + n_step;
  UPDATE hostel_visitors SET name = '[erased]', phone = NULL, relation = NULL, purpose = NULL
   WHERE student_id = who AND (name <> '[erased]' OR phone IS NOT NULL OR relation IS NOT NULL OR purpose IS NOT NULL);
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_hostel_visitors := n_hostel_visitors + n_step;
  RETURN jsonb_build_object('hostel_leaves', n_hostel_leaves, 'hostel_check_ins', n_hostel_check_ins, 'hostel_visitors', n_hostel_visitors);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_hostel(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_hostel(text) TO campusos_app;

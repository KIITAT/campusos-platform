-- P1-08a: notices's part in erasing and exporting a person (AUD-03, decisions 220, 221).
-- Overwrites:
--   notifications: the person's inbox rows are deleted.
-- Rows about a person keyed by someone else: none
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_subject.erase_notices(text);

-- Pre-flight: core 0012.
DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core migration 0012 (dpdp_subject) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_notices(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_notifications integer := 0;
  n_step integer;
BEGIN
  DELETE FROM notifications WHERE user_id = who;
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_notifications := n_notifications + n_step;
  RETURN jsonb_build_object('notifications', n_notifications);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_notices(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_notices(text) TO campusos_app;

-- P1-08a: parents's part in erasing and exporting a person (AUD-03, decisions 220, 221).
-- Overwrites:
--   parent_links: refused_reason becomes NULL.
-- Rows about a person keyed by someone else: none
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_subject.erase_parents(text);

-- Pre-flight: core 0012.
DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core migration 0012 (dpdp_subject) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_parents(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_parent_links integer := 0;
  n_step integer;
BEGIN
  UPDATE parent_links SET refused_reason = NULL WHERE (student_id = who OR parent_id = who) AND refused_reason IS NOT NULL;
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_parent_links := n_parent_links + n_step;
  RETURN jsonb_build_object('parent_links', n_parent_links);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_parents(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_parents(text) TO campusos_app;

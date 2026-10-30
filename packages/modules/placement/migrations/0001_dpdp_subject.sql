-- P1-08a: placement's part in erasing and exporting a person (AUD-03, decisions 220, 221).
-- Overwrites:
--   placement_results: note becomes [erased].
-- Rows about a person keyed by someone else: placement_results of the person's applications.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_subject.erase_placement(text);
--   DROP VIEW IF EXISTS dpdp_subject.placement_about;

-- Pre-flight: core 0012.
DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core migration 0012 (dpdp_subject) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_placement(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_placement_results integer := 0;
  n_step integer;
BEGIN
  UPDATE placement_results x SET note = '[erased]' FROM placement_applications a
   WHERE a.id = x.application_id AND a.student_id = who AND x.note <> '[erased]';
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_placement_results := n_placement_results + n_step;
  RETURN jsonb_build_object('placement_results', n_placement_results);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_placement(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_placement(text) TO campusos_app;
--> statement-breakpoint
CREATE OR REPLACE VIEW dpdp_subject.placement_about WITH (security_invoker = true) AS
  SELECT a.student_id AS subject_id, 'placement_results'::text AS source, to_jsonb(x) AS row_data
    FROM public.placement_results x JOIN public.placement_applications a ON a.id = x.application_id;
--> statement-breakpoint
GRANT SELECT ON dpdp_subject.placement_about TO campusos_app;

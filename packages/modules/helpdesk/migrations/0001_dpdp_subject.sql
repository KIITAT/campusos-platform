-- P1-08a: helpdesk's part in erasing and exporting a person (AUD-03, decisions 220, 221).
-- Overwrites:
--   helpdesk_messages: body becomes [erased], in the person's cases and where they are the author.
--   helpdesk_cases: subject, description become [erased]; resolution becomes NULL.
-- Rows about a person keyed by someone else: helpdesk_messages in the person's cases.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_subject.erase_helpdesk(text);
--   DROP VIEW IF EXISTS dpdp_subject.helpdesk_about;

-- Pre-flight: core 0012.
DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core migration 0012 (dpdp_subject) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_helpdesk(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_helpdesk_messages integer := 0;
  n_helpdesk_cases integer := 0;
  n_step integer;
BEGIN
  UPDATE helpdesk_messages m SET body = '[erased]' FROM helpdesk_cases c
   WHERE c.institution_id = m.institution_id AND c.id = m.case_id AND c.reporter_id = who AND m.body <> '[erased]';
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_helpdesk_messages := n_helpdesk_messages + n_step;
  UPDATE helpdesk_messages SET body = '[erased]' WHERE author_id = who AND body <> '[erased]';
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_helpdesk_messages := n_helpdesk_messages + n_step;
  UPDATE helpdesk_cases SET subject = '[erased]', description = '[erased]', resolution = NULL
   WHERE reporter_id = who AND (description <> '[erased]' OR resolution IS NOT NULL);
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_helpdesk_cases := n_helpdesk_cases + n_step;
  RETURN jsonb_build_object('helpdesk_messages', n_helpdesk_messages, 'helpdesk_cases', n_helpdesk_cases);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_helpdesk(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_helpdesk(text) TO campusos_app;
--> statement-breakpoint
CREATE OR REPLACE VIEW dpdp_subject.helpdesk_about WITH (security_invoker = true) AS
  SELECT c.reporter_id AS subject_id, 'helpdesk_messages'::text AS source, to_jsonb(m) AS row_data
    FROM public.helpdesk_messages m
    JOIN public.helpdesk_cases c ON c.institution_id = m.institution_id AND c.id = m.case_id;
--> statement-breakpoint
GRANT SELECT ON dpdp_subject.helpdesk_about TO campusos_app;

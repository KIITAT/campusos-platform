-- P1-08d: hr's retention rule (AUD-08).
-- hr_job_applicants: anonymised when not hired, with no offer that became staff, a year after the opening closed; their interview feedback notes are overwritten.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_retention.purge_hr(uuid);

DO $$
BEGIN
  IF to_regnamespace('dpdp_retention') IS NULL THEN
    RAISE EXCEPTION 'core migration 0016 (retention) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_retention.purge_hr(inst uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE ids uuid[]; n_app integer; n_fb integer;
BEGIN
  SELECT coalesce(array_agg(a.id), '{}') INTO ids FROM hr_job_applicants a
    JOIN hr_job_openings o ON o.id = a.opening_id
   WHERE a.institution_id = inst AND a.name <> '[erased]' AND a.status <> 'hired'
     AND o.closed_at < now() - interval '365 days'
     AND NOT EXISTS (SELECT 1 FROM hr_job_offers f WHERE f.applicant_id = a.id AND f.staff_id IS NOT NULL);
  PERFORM set_config('app.audit_reason', 'retention purge', true);
  UPDATE hr_interview_feedback fb SET notes = '[erased]'
    FROM hr_interviews i
   WHERE fb.interview_id = i.id AND i.applicant_id = ANY (ids) AND fb.notes <> '[erased]';
  GET DIAGNOSTICS n_fb = ROW_COUNT;
  PERFORM set_config('app.audit_reason', '', true);
  UPDATE hr_job_applicants SET name = '[erased]', email = 'erased+' || id || '@invalid',
         phone = NULL, source = NULL, notes = NULL
   WHERE id = ANY (ids);
  GET DIAGNOSTICS n_app = ROW_COUNT;
  RETURN jsonb_build_object('hr_job_applicants', n_app, 'hr_interview_feedback', n_fb);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_retention.purge_hr(uuid) FROM PUBLIC;

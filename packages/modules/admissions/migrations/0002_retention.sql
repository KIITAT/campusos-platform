-- P1-08d: admissions's retention rule (AUD-08).
-- admissions_enquiries: anonymised when no application was accepted and nothing has happened for 365 days; their applications lose the free-text reason.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_retention.purge_admissions(uuid);

DO $$
BEGIN
  IF to_regnamespace('dpdp_retention') IS NULL THEN
    RAISE EXCEPTION 'core migration 0016 (retention) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_retention.purge_admissions(inst uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE ids uuid[]; n_enq integer; n_app integer;
BEGIN
  SELECT coalesce(array_agg(e.id), '{}') INTO ids FROM admissions_enquiries e
   WHERE e.institution_id = inst AND e.name <> '[erased]'
     AND NOT EXISTS (SELECT 1 FROM admissions_applications a WHERE a.enquiry_id = e.id AND a.status = 'accepted')
     AND greatest(e.created_at, coalesce((SELECT max(a.updated_at) FROM admissions_applications a WHERE a.enquiry_id = e.id), e.created_at))
         < now() - interval '365 days';
  UPDATE admissions_applications SET reason = NULL WHERE enquiry_id = ANY (ids) AND reason IS NOT NULL;
  GET DIAGNOSTICS n_app = ROW_COUNT;
  UPDATE admissions_enquiries SET name = '[erased]', email = 'erased+' || id || '@invalid', phone = NULL, note = NULL
   WHERE id = ANY (ids);
  GET DIAGNOSTICS n_enq = ROW_COUNT;
  RETURN jsonb_build_object('admissions_enquiries', n_enq, 'admissions_applications', n_app);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_retention.purge_admissions(uuid) FROM PUBLIC;

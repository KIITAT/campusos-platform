-- P1-08d: notices's retention rule (AUD-08).
-- notifications: deleted when older than 365 days.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_retention.purge_notices(uuid);

DO $$
BEGIN
  IF to_regnamespace('dpdp_retention') IS NULL THEN
    RAISE EXCEPTION 'core migration 0016 (retention) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_retention.purge_notices(inst uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE n integer;
BEGIN
  DELETE FROM notifications WHERE institution_id = inst AND created_at < now() - interval '365 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('notifications', n);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_retention.purge_notices(uuid) FROM PUBLIC;

-- P1-08d: attendance's retention rule (AUD-08).
-- attendance_devices: deleted when the device's person has been erased (NEW-33).
--
-- Rollback:
--   DROP FUNCTION IF EXISTS dpdp_retention.purge_attendance(uuid);

DO $$
BEGIN
  IF to_regnamespace('dpdp_retention') IS NULL THEN
    RAISE EXCEPTION 'core migration 0016 (retention) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_retention.purge_attendance(inst uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE n integer;
BEGIN
  DELETE FROM attendance_devices d USING users u
   WHERE d.institution_id = inst AND u.id = d.user_id AND u.erased_at IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('attendance_devices', n);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_retention.purge_attendance(uuid) FROM PUBLIC;

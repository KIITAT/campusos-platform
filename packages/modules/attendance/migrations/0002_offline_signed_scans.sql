ALTER TABLE attendance_settings
  ADD COLUMN require_signed_scans boolean NOT NULL DEFAULT true,
  ADD COLUMN accept_late_sync boolean NOT NULL DEFAULT true,
  ADD COLUMN max_late_sync_hours smallint NOT NULL DEFAULT 24 CHECK (max_late_sync_hours BETWEEN 1 AND 168),
  ADD COLUMN clock_skew_seconds smallint NOT NULL DEFAULT 60 CHECK (clock_skew_seconds BETWEEN 0 AND 300);
--> statement-breakpoint
ALTER TABLE attendance_devices ADD COLUMN public_key text;
--> statement-breakpoint
ALTER TABLE attendance_sessions ADD COLUMN token_window_seconds smallint NOT NULL DEFAULT 7 CHECK (token_window_seconds BETWEEN 1 AND 300);
--> statement-breakpoint
UPDATE attendance_sessions SET token_window_seconds = attendance_settings.token_window_seconds FROM attendance_settings WHERE attendance_sessions.institution_id = attendance_settings.institution_id;
--> statement-breakpoint
ALTER TABLE attendance_records
  ADD COLUMN captured_at timestamptz,
  ADD COLUMN scan_nonce uuid,
  ADD COLUMN payload_hash text,
  ADD CONSTRAINT attendance_records_signed_shape CHECK ((captured_at IS NULL AND scan_nonce IS NULL AND payload_hash IS NULL) OR (captured_at IS NOT NULL AND scan_nonce IS NOT NULL AND payload_hash IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX attendance_records_nonce ON attendance_records (institution_id, student_id, scan_nonce);
--> statement-breakpoint
CREATE TABLE attendance_offline_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  slot_id uuid NOT NULL REFERENCES academic_slots(id) ON DELETE CASCADE,
  offering_id uuid NOT NULL REFERENCES academic_offerings(id) ON DELETE CASCADE,
  teacher_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  on_date date NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  token_secret text NOT NULL,
  window_seconds smallint NOT NULL CHECK (window_seconds BETWEEN 1 AND 300),
  room_id uuid NOT NULL REFERENCES academic_rooms(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_offline_dates CHECK (ends_at > starts_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX attendance_offline_occurrence ON attendance_offline_credentials (slot_id, on_date);
--> statement-breakpoint
ALTER TABLE attendance_offline_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attendance_offline_credentials_tenant_isolation ON attendance_offline_credentials FOR ALL TO campusos_app
  USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid)
  WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE FUNCTION attendance_device_key_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.public_key IS DISTINCT FROM OLD.public_key OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.institution_id IS DISTINCT FROM OLD.institution_id OR NEW.device_hash IS DISTINCT FROM OLD.device_hash THEN
    RAISE EXCEPTION 'register a new device to replace its signing key' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attendance_device_key_fixed BEFORE UPDATE ON attendance_devices FOR EACH ROW EXECUTE FUNCTION attendance_device_key_fixed();

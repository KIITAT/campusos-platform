-- P2-22a: who is inside the library, and the outbox the hostel reads.
-- Pre-flight: none (new tables and not-null-with-default columns).
-- Rollback:
--   DROP TABLE library_events; DROP TABLE library_sessions;
--   ALTER TABLE library_settings DROP COLUMN opens_at, DROP COLUMN closes_at, DROP COLUMN closing_reminder_min,
--     DROP COLUMN auto_close_after_min, DROP COLUMN presence_retention_days;
ALTER TABLE library_settings
  ADD COLUMN opens_at time NOT NULL DEFAULT '09:00',
  ADD COLUMN closes_at time NOT NULL DEFAULT '20:00',
  ADD COLUMN closing_reminder_min smallint NOT NULL DEFAULT 15,
  ADD COLUMN auto_close_after_min smallint NOT NULL DEFAULT 30,
  ADD COLUMN presence_retention_days smallint NOT NULL DEFAULT 90;
--> statement-breakpoint
ALTER TABLE library_settings
  ADD CONSTRAINT library_settings_hours CHECK (closes_at > opens_at),
  ADD CONSTRAINT library_settings_reminder CHECK (closing_reminder_min BETWEEN 5 AND 120),
  ADD CONSTRAINT library_settings_auto_close CHECK (auto_close_after_min BETWEEN 0 AND 240),
  ADD CONSTRAINT library_settings_presence_retention CHECK (presence_retention_days BETWEEN 30 AND 730);
--> statement-breakpoint
CREATE TABLE library_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  student_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entered_at timestamptz NOT NULL DEFAULT now(),
  exited_at timestamptz,
  entry_method text NOT NULL,
  exit_method text,
  recorded_by text REFERENCES users(id) ON DELETE SET NULL,
  exit_recorded_by text REFERENCES users(id) ON DELETE SET NULL,
  reminder_sent_at timestamptz,
  unconfirmed_reported_at timestamptz,
  CONSTRAINT library_sessions_entry_method CHECK (entry_method IN ('door_qr', 'desk')),
  CONSTRAINT library_sessions_exit_method CHECK (exit_method IN ('door_qr', 'desk', 'auto_close')),
  CONSTRAINT library_sessions_closed_together CHECK ((exited_at IS NULL) = (exit_method IS NULL)),
  CONSTRAINT library_sessions_order CHECK (exited_at IS NULL OR exited_at >= entered_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX library_sessions_one_open ON library_sessions (student_id) WHERE exited_at IS NULL;
--> statement-breakpoint
CREATE INDEX library_sessions_open ON library_sessions (institution_id) WHERE exited_at IS NULL;
--> statement-breakpoint
CREATE INDEX library_sessions_student ON library_sessions (student_id, entered_at DESC);
--> statement-breakpoint
CREATE TABLE library_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  kind text NOT NULL,
  student_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES library_sessions(id) ON DELETE CASCADE,
  at timestamptz NOT NULL,
  method text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_events_kind CHECK (kind IN ('session_started', 'session_ended', 'session_unconfirmed'))
);
--> statement-breakpoint
CREATE INDEX library_events_feed ON library_events (institution_id, id);
--> statement-breakpoint
ALTER TABLE library_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE library_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "library_sessions_tenant_isolation" ON "library_sessions" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "library_events_tenant_isolation" ON "library_events" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
-- Privacy: erase a person's visits, and purge old ones (P2-22a, D1347, D1348).
-- Rollback: DROP FUNCTION IF EXISTS dpdp_subject.erase_library(text); DROP FUNCTION IF EXISTS dpdp_retention.purge_library(uuid);
-- Pre-flight: core 0012 (dpdp_subject) and core 0016 (dpdp_retention).
DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core migration 0012 (dpdp_subject) must be applied first';
  END IF;
  IF to_regnamespace('dpdp_retention') IS NULL THEN
    RAISE EXCEPTION 'core migration 0016 (retention) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_library(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_events integer;
  n_sessions integer;
BEGIN
  DELETE FROM library_events WHERE student_id = who;
  GET DIAGNOSTICS n_events = ROW_COUNT;
  DELETE FROM library_sessions WHERE student_id = who;
  GET DIAGNOSTICS n_sessions = ROW_COUNT;
  RETURN jsonb_build_object('library_sessions', n_sessions, 'library_events', n_events);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_library(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_library(text) TO campusos_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_retention.purge_library(inst uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  keep interval := make_interval(days => coalesce((SELECT presence_retention_days FROM library_settings WHERE institution_id = inst), 90));
  n_events integer;
  n_sessions integer;
BEGIN
  DELETE FROM library_events WHERE institution_id = inst AND at < now() - keep;
  GET DIAGNOSTICS n_events = ROW_COUNT;
  DELETE FROM library_sessions WHERE institution_id = inst AND exited_at IS NOT NULL AND exited_at < now() - keep;
  GET DIAGNOSTICS n_sessions = ROW_COUNT;
  RETURN jsonb_build_object('library_sessions', n_sessions, 'library_events', n_events);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_retention.purge_library(uuid) FROM PUBLIC;

-- P2-22a: hostel presence, the curfew ladder, late-stay windows and passes, warden scopes.
-- Pre-flight: none (new tables; one nullable column).
-- Rollback (reverse order):
--   DROP TABLE hostel_event_cursors; DROP TABLE hostel_presence_log; DROP TABLE hostel_curfew_cases;
--   DROP TABLE hostel_late_passes; DROP TABLE hostel_late_stay_windows; DROP TABLE hostel_warden_scopes;
--   DROP TABLE hostel_policy;
--   ALTER TABLE hostel_blocks DROP CONSTRAINT hostel_blocks_curfew; ALTER TABLE hostel_blocks DROP COLUMN curfew_time;
ALTER TABLE hostel_blocks ADD COLUMN curfew_time time;
--> statement-breakpoint
ALTER TABLE hostel_blocks ADD CONSTRAINT hostel_blocks_curfew CHECK (curfew_time IS NULL OR curfew_time BETWEEN '17:00' AND '23:59');
--> statement-breakpoint
CREATE TABLE hostel_policy (
  institution_id uuid PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
  curfew_time time NOT NULL DEFAULT '21:30',
  nudge_after_min smallint NOT NULL DEFAULT 10,
  warden_after_min smallint NOT NULL DEFAULT 30,
  womens_warden_after_min smallint NOT NULL DEFAULT 15,
  guardian_after_min smallint NOT NULL DEFAULT 60,
  walk_back_min smallint NOT NULL DEFAULT 20,
  case_window_hours smallint NOT NULL DEFAULT 6,
  late_pass_latest_time time NOT NULL DEFAULT '01:00',
  notify_warden_on_library_entry boolean NOT NULL DEFAULT false,
  presence_retention_days smallint NOT NULL DEFAULT 90,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hostel_policy_ladder CHECK (nudge_after_min BETWEEN 0 AND 120 AND womens_warden_after_min > nudge_after_min AND warden_after_min > nudge_after_min AND guardian_after_min > warden_after_min AND guardian_after_min > womens_warden_after_min AND guardian_after_min <= 360),
  CONSTRAINT hostel_policy_curfew CHECK (curfew_time BETWEEN '17:00' AND '23:59'),
  CONSTRAINT hostel_policy_walk_back CHECK (walk_back_min BETWEEN 0 AND 90),
  CONSTRAINT hostel_policy_window CHECK (case_window_hours BETWEEN 1 AND 12),
  CONSTRAINT hostel_policy_retention CHECK (presence_retention_days BETWEEN 30 AND 730),
  CONSTRAINT hostel_policy_late_latest CHECK (late_pass_latest_time <= '04:00')
);
--> statement-breakpoint
CREATE TABLE hostel_warden_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level text NOT NULL,
  block_id uuid REFERENCES hostel_blocks(id) ON DELETE CASCADE,
  floor smallint,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hostel_scopes_level CHECK (level IN ('floor', 'block', 'chief', 'estate')),
  CONSTRAINT hostel_scopes_shape CHECK (
    (level = 'floor' AND block_id IS NOT NULL AND floor IS NOT NULL)
    OR (level = 'block' AND block_id IS NOT NULL AND floor IS NULL)
    OR (level IN ('chief', 'estate') AND block_id IS NULL AND floor IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX hostel_scopes_unique ON hostel_warden_scopes (user_id, level, coalesce(block_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(floor, -99));
--> statement-breakpoint
CREATE INDEX hostel_scopes_level_idx ON hostel_warden_scopes (institution_id, level);
--> statement-breakpoint
CREATE TABLE hostel_late_stay_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  block_id uuid REFERENCES hostel_blocks(id) ON DELETE CASCADE,
  from_on date NOT NULL,
  to_on date NOT NULL,
  until_time time NOT NULL,
  reason text NOT NULL,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  CONSTRAINT hostel_windows_dates CHECK (to_on >= from_on AND to_on - from_on <= 60),
  CONSTRAINT hostel_windows_until CHECK (until_time BETWEEN '21:00' AND '23:59'),
  CONSTRAINT hostel_windows_reason CHECK (length(trim(reason)) BETWEEN 5 AND 200)
);
--> statement-breakpoint
CREATE INDEX hostel_windows_range ON hostel_late_stay_windows (institution_id, from_on, to_on);
--> statement-breakpoint
CREATE TABLE hostel_late_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  student_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  night date NOT NULL,
  until_at timestamptz NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'requested',
  requested_by text REFERENCES users(id) ON DELETE SET NULL,
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hostel_passes_status CHECK (status IN ('requested', 'approved', 'refused', 'cancelled', 'lapsed')),
  CONSTRAINT hostel_passes_reason CHECK (length(trim(reason)) BETWEEN 5 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX hostel_late_passes_open ON hostel_late_passes (student_id, night) WHERE status IN ('requested', 'approved');
--> statement-breakpoint
CREATE INDEX hostel_late_passes_night ON hostel_late_passes (institution_id, night);
--> statement-breakpoint
CREATE TABLE hostel_curfew_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  student_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  block_id uuid NOT NULL REFERENCES hostel_blocks(id) ON DELETE CASCADE,
  night date NOT NULL,
  curfew_at timestamptz NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  nudge_at timestamptz,
  warden_at timestamptz,
  guardian_at timestamptz,
  resolved_at timestamptz,
  resolution text,
  resolved_by text REFERENCES users(id) ON DELETE SET NULL,
  note text,
  CONSTRAINT hostel_cases_resolution CHECK (resolution IS NULL OR resolution IN ('checked_in', 'leave', 'warden_verified', 'warden_closed', 'lapsed')),
  CONSTRAINT hostel_cases_resolved_together CHECK ((resolved_at IS NULL) = (resolution IS NULL)),
  CONSTRAINT hostel_cases_note CHECK (note IS NULL OR length(note) BETWEEN 5 AND 300)
);
--> statement-breakpoint
CREATE UNIQUE INDEX hostel_cases_once ON hostel_curfew_cases (student_id, night);
--> statement-breakpoint
CREATE INDEX hostel_cases_open ON hostel_curfew_cases (institution_id) WHERE resolved_at IS NULL;
--> statement-breakpoint
CREATE INDEX hostel_cases_block_night ON hostel_curfew_cases (block_id, night);
--> statement-breakpoint
CREATE TABLE hostel_presence_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  student_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at timestamptz NOT NULL,
  kind text NOT NULL,
  source text NOT NULL,
  source_ref text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT hostel_log_kind CHECK (kind IN ('library_entered', 'library_exited', 'library_unconfirmed', 'case_opened', 'student_nudged', 'warden_alerted', 'guardian_alerted', 'case_resolved', 'late_pass_decided'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX hostel_log_source_once ON hostel_presence_log (institution_id, source, source_ref, kind) WHERE source_ref IS NOT NULL;
--> statement-breakpoint
CREATE INDEX hostel_log_student ON hostel_presence_log (student_id, at DESC);
--> statement-breakpoint
CREATE TABLE hostel_event_cursors (
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  source text NOT NULL,
  last_id bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (institution_id, source)
);
--> statement-breakpoint
ALTER TABLE hostel_policy ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hostel_warden_scopes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hostel_late_stay_windows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hostel_late_passes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hostel_curfew_cases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hostel_presence_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hostel_event_cursors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hostel_policy_tenant_isolation" ON "hostel_policy" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "hostel_warden_scopes_tenant_isolation" ON "hostel_warden_scopes" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "hostel_late_stay_windows_tenant_isolation" ON "hostel_late_stay_windows" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "hostel_late_passes_tenant_isolation" ON "hostel_late_passes" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "hostel_curfew_cases_tenant_isolation" ON "hostel_curfew_cases" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "hostel_presence_log_tenant_isolation" ON "hostel_presence_log" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "hostel_event_cursors_tenant_isolation" ON "hostel_event_cursors" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
-- Privacy: erase and purge for the new tables (P2-22a, D1347, D1348).
-- Rollback: DROP FUNCTION IF EXISTS dpdp_retention.purge_hostel(uuid);
--   and restore the three-step dpdp_subject.erase_hostel(text) from hostel migration 0002.
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
CREATE OR REPLACE FUNCTION dpdp_subject.erase_hostel(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_hostel_leaves integer := 0;
  n_hostel_check_ins integer := 0;
  n_hostel_visitors integer := 0;
  n_hostel_presence_log integer := 0;
  n_hostel_curfew_cases integer := 0;
  n_hostel_late_passes integer := 0;
  n_step integer;
BEGIN
  UPDATE hostel_leaves SET reason = '[erased]' WHERE student_id = who AND reason <> '[erased]';
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_hostel_leaves := n_hostel_leaves + n_step;
  UPDATE hostel_check_ins SET note = NULL WHERE student_id = who AND note IS NOT NULL;
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_hostel_check_ins := n_hostel_check_ins + n_step;
  UPDATE hostel_visitors SET name = '[erased]', phone = NULL, relation = NULL, purpose = NULL
   WHERE student_id = who AND (name <> '[erased]' OR phone IS NOT NULL OR relation IS NOT NULL OR purpose IS NOT NULL);
  GET DIAGNOSTICS n_step = ROW_COUNT;
  n_hostel_visitors := n_hostel_visitors + n_step;
  DELETE FROM hostel_presence_log WHERE student_id = who;
  GET DIAGNOSTICS n_hostel_presence_log = ROW_COUNT;
  DELETE FROM hostel_curfew_cases WHERE student_id = who;
  GET DIAGNOSTICS n_hostel_curfew_cases = ROW_COUNT;
  UPDATE hostel_late_passes SET reason = '[erased]' WHERE student_id = who AND reason <> '[erased]';
  GET DIAGNOSTICS n_hostel_late_passes = ROW_COUNT;
  RETURN jsonb_build_object(
    'hostel_leaves', n_hostel_leaves, 'hostel_check_ins', n_hostel_check_ins, 'hostel_visitors', n_hostel_visitors,
    'hostel_presence_log', n_hostel_presence_log, 'hostel_curfew_cases', n_hostel_curfew_cases, 'hostel_late_passes', n_hostel_late_passes);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_hostel(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_hostel(text) TO campusos_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_retention.purge_hostel(inst uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  keep interval := make_interval(days => coalesce((SELECT presence_retention_days FROM hostel_policy WHERE institution_id = inst), 90));
  n_log integer;
  n_cases integer;
  n_passes integer;
BEGIN
  DELETE FROM hostel_presence_log WHERE institution_id = inst AND at < now() - keep;
  GET DIAGNOSTICS n_log = ROW_COUNT;
  -- Whatever its state: a case nobody resolved keeps a minor's name and times for no reason once its night is long over.
  DELETE FROM hostel_curfew_cases WHERE institution_id = inst AND ((resolved_at IS NOT NULL AND resolved_at < now() - keep) OR night < (current_date - keep)::date);
  GET DIAGNOSTICS n_cases = ROW_COUNT;
  DELETE FROM hostel_late_passes WHERE institution_id = inst AND ((status <> 'requested' AND created_at < now() - keep) OR night < (current_date - keep)::date);
  GET DIAGNOSTICS n_passes = ROW_COUNT;
  RETURN jsonb_build_object('hostel_presence_log', n_log, 'hostel_curfew_cases', n_cases, 'hostel_late_passes', n_passes);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_retention.purge_hostel(uuid) FROM PUBLIC;

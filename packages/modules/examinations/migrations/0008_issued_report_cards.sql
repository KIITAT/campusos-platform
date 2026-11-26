-- Issued school report cards (P1-13b.3, NEW-141): an immutable version ledger.
-- Publishing a card now stores what was issued (the resolved template, the
-- figures, the attendance and the labels) so a later mark revision, new exam or
-- roster move cannot change a card a family already holds. Forward-only and
-- additive. There is no automatic backfill: a card published before this
-- migration has a timestamp and no figures, so the office reissues it as
-- version 1 (see plans/P1-13b.3.md section 4 for the inventory and cutover).
--
-- Rollback (an empty, abandoned rollout only; the guard aborts if history exists):
--   BEGIN;
--   LOCK TABLE exam_report_card_versions IN ACCESS EXCLUSIVE MODE;
--   (abort if any row exists)
--   DROP FUNCTION dpdp_subject.erase_examinations(text);
--   DROP TABLE exam_report_card_versions;
--   DROP FUNCTION exam_guard_report_card_version();
--   COMMIT;

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.exam_report_card_entries') IS NULL THEN
    RAISE EXCEPTION 'examinations 0006 must be applied before 0008';
  END IF;
  IF to_regclass('public.exam_report_card_versions') IS NOT NULL THEN
    RAISE EXCEPTION 'exam_report_card_versions already exists: schema drift, stop';
  END IF;
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core DPDP subject functions (core 0012) are missing';
  END IF;
  IF to_regprocedure('dpdp_subject.erase_examinations(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'dpdp_subject.erase_examinations already exists: merge into it instead';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE exam_report_card_versions (
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  term_id uuid NOT NULL,
  section_id uuid NOT NULL,
  student_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  issued_at timestamptz NOT NULL,
  payload jsonb,
  PRIMARY KEY (institution_id, term_id, section_id, student_id, version),
  CHECK (payload IS NULL OR
    (jsonb_typeof(payload) = 'object' AND payload->'format' = '1'::jsonb
     AND jsonb_typeof(payload->'template') = 'object'
     AND jsonb_typeof(payload->'templateRevision') = 'number'
     AND jsonb_typeof(payload->'report') = 'object'
     AND jsonb_typeof(payload->'report'->'attendance') = 'object') IS TRUE)
);
--> statement-breakpoint
CREATE INDEX exam_report_card_versions_student
  ON exam_report_card_versions (student_id, institution_id);
--> statement-breakpoint
ALTER TABLE exam_report_card_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY exam_report_card_versions_tenant ON exam_report_card_versions
  FOR ALL TO campusos_app
  USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid)
  WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE FUNCTION exam_guard_report_card_version() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.payload IS NOT NULL AND EXISTS (
      SELECT 1 FROM users WHERE id = NEW.student_id
      AND institution_id = NEW.institution_id AND role = 'student' AND erased_at IS NULL
    ) THEN RETURN NEW; END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.payload IS NOT NULL AND NEW.payload IS NULL AND
       public.campusos_erasure_allows(OLD.student_id, to_jsonb(OLD), to_jsonb(NEW), ARRAY['payload'])
    THEN RETURN NEW; END IF;
  ELSIF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'issued report card versions are immutable' USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER exam_report_card_version_guard BEFORE INSERT OR UPDATE OR DELETE
  ON exam_report_card_versions FOR EACH ROW EXECUTE FUNCTION exam_guard_report_card_version();
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON exam_report_card_versions TO campusos_app;
--> statement-breakpoint
CREATE FUNCTION dpdp_subject.erase_examinations(who text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE exam_report_card_versions SET payload = NULL
    WHERE student_id = who AND payload IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('exam_report_card_versions', n);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_examinations(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_examinations(text) TO campusos_app;

-- A completed course can be corrected, and never quietly.
--
-- Examinations posts into academic_course_completions when a result is
-- finalised, and a result can change afterwards: a remark, a disputed paper, a
-- missing script that turns up in July. The degree audit and the transcript
-- both read this table, so a row that could be edited with no trace would make
-- every transcript a claim rather than a record.
--
-- Same mechanism the published-marks guard already uses: audit() issues
-- set_config('app.audit_reason', ..., true) in the same transaction as the
-- write, and this trigger refuses the write when that is absent. Inserting the
-- first result is ordinary work; changing one is not.

ALTER TABLE "academic_course_completions" ADD COLUMN "revision" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION academic_completions_guard_change() RETURNS trigger AS $$
BEGIN
  IF nullif(current_setting('app.audit_reason', true), '') IS NULL THEN
    RAISE EXCEPTION
      'a completed course can only be changed through an audited correction'
      USING ERRCODE = 'check_violation',
            HINT = 'call audit() in the same transaction, supplying a reason';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER academic_completions_guard_change
  BEFORE UPDATE ON "academic_course_completions"
  FOR EACH ROW EXECUTE FUNCTION academic_completions_guard_change();--> statement-breakpoint

-- Deleting is never a correction. A course wrongly credited is corrected to a
-- fail, with a reason, and the attempt stays on the record where a registrar
-- can explain it.
--
-- Depth is checked so that offboarding an institution still cascades: the
-- guard is against a hand on the table, not against the database tidying up.
CREATE OR REPLACE FUNCTION academic_completions_no_delete() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'a completed course is not deleted; correct it instead'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER academic_completions_no_delete
  BEFORE DELETE ON "academic_course_completions"
  FOR EACH ROW EXECUTE FUNCTION academic_completions_no_delete();

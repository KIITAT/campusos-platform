-- Split from the monorepo history (0005_published_marks_guard.sql) when modules became
-- installable plugins. Applied by the host at install time, in this order.

-- Published marks cannot be edited silently.
--
-- The spec is explicit that post-hoc grade edits must not be possible and that
-- corrections go through the audit log. An application-level check would be a
-- convention: any future code path that forgets it, or any psql session, edits
-- a published grade with no trace. This makes it a database guarantee.
--
-- The mechanism reuses the pattern already carrying tenant context: audit()
-- issues set_config('app.audit_reason', ..., true) in the same transaction as
-- the write, and this trigger refuses the write when that is absent. So the
-- only way to change a published mark is through a path that has recorded why.
--
-- Transaction-local (the `true`), so a reason cannot leak into the next
-- request that reuses the pooled connection.

CREATE OR REPLACE FUNCTION exam_marks_guard_published() RETURNS trigger AS $$
DECLARE
  published timestamptz;
  reason text;
BEGIN
  SELECT e.published_at INTO published FROM exams e WHERE e.id = NEW.exam_id;

  -- Before publication, marks entry is ordinary work.
  IF published IS NULL THEN
    RETURN NEW;
  END IF;

  reason := nullif(current_setting('app.audit_reason', true), '');

  IF reason IS NULL THEN
    RAISE EXCEPTION
      'marks for a published exam can only be changed through an audited revision'
      USING ERRCODE = 'check_violation',
            HINT = 'call audit() in the same transaction, supplying a reason';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- UPDATE and INSERT both: inserting a fresh mark against an already-published
-- exam is the same act as editing one, and needs the same justification.
CREATE TRIGGER exam_marks_guard_published
  BEFORE INSERT OR UPDATE ON "exam_marks"
  FOR EACH ROW EXECUTE FUNCTION exam_marks_guard_published();
--> statement-breakpoint

-- Deleting a published mark is never a correction; a correction is a revision.
CREATE OR REPLACE FUNCTION exam_marks_no_delete_published() RETURNS trigger AS $$
DECLARE
  published timestamptz;
BEGIN
  SELECT e.published_at INTO published FROM exams e WHERE e.id = OLD.exam_id;
  IF published IS NOT NULL THEN
    RAISE EXCEPTION 'a published mark cannot be deleted; revise it instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER exam_marks_no_delete_published
  BEFORE DELETE ON "exam_marks"
  FOR EACH ROW EXECUTE FUNCTION exam_marks_no_delete_published();
--> statement-breakpoint

-- Unpublishing would silently un-lock every mark under it. If results were
-- published in error, that is a decision with a reason, so it needs one too.
CREATE OR REPLACE FUNCTION exams_guard_unpublish() RETURNS trigger AS $$
BEGIN
  IF OLD.published_at IS NOT NULL
     AND NEW.published_at IS DISTINCT FROM OLD.published_at
     AND nullif(current_setting('app.audit_reason', true), '') IS NULL
  THEN
    RAISE EXCEPTION 'changing the publication of a published exam requires an audited reason'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER exams_guard_unpublish
  BEFORE UPDATE ON "exams"
  FOR EACH ROW EXECUTE FUNCTION exams_guard_unpublish();

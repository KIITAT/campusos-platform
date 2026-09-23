-- Draft, submitted, cancelled: one lifecycle for any record that needs an audit
-- trail rather than free edits, enforced here once instead of by each module.
--
-- A module opts a table in by giving it the lifecycle columns (docStatusColumns
-- in @campusos/db) and attaching this function (docStatusDdl writes it):
--
--   CREATE TRIGGER <table>_docstatus BEFORE INSERT OR UPDATE OR DELETE ON <table>
--     FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard();
--
-- The rules:
--   * a record starts as a draft, or is submitted as it is created;
--   * a draft may change freely and may be deleted;
--   * a submitted record may not change at all, except to be cancelled, with a
--     reason, and may never be deleted;
--   * a cancelled record is final. Correcting it means amending: a new draft
--     that names the cancelled one it replaces.
--
-- Changes arriving from a foreign key's cascade (a user deleted, say, setting a
-- "by" column to null) are let through: they are not an edit to the record.

CREATE OR REPLACE FUNCTION campusos_docstatus_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lifecycle text[] := ARRAY['docstatus', 'submitted_at', 'submitted_by', 'cancelled_at', 'cancelled_by', 'cancel_reason'];
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.docstatus <> 'draft' THEN
      RAISE EXCEPTION 'a % record cannot be deleted; cancel it instead', OLD.docstatus
        USING ERRCODE = 'check_violation', CONSTRAINT = 'docstatus_locked';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.docstatus = 'cancelled' THEN
      RAISE EXCEPTION 'a record cannot be created cancelled'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'docstatus_draft_cancel';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.docstatus = 'cancelled' THEN
    RAISE EXCEPTION 'a cancelled record is final; amend it into a new draft'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'docstatus_final';
  END IF;

  IF OLD.docstatus = 'submitted' THEN
    IF NEW.docstatus <> 'cancelled'
       OR (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle) THEN
      RAISE EXCEPTION 'a submitted record cannot be changed, only cancelled'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'docstatus_locked';
    END IF;
    IF NEW.cancel_reason IS NULL OR length(trim(NEW.cancel_reason)) = 0 THEN
      RAISE EXCEPTION 'cancelling needs a reason'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'docstatus_cancel_reason';
    END IF;
    RETURN NEW;
  END IF;

  -- A draft.
  IF NEW.docstatus = 'cancelled' THEN
    RAISE EXCEPTION 'a draft is deleted, not cancelled'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'docstatus_draft_cancel';
  END IF;
  RETURN NEW;
END;
$$;

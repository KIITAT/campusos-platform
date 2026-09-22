-- An institution with published marks could not be deleted.
--
-- `exam_marks_no_delete_published` refuses to let a published mark be deleted,
-- which is right, and it had no exemption for a cascade, which is not. Removing
-- an institution cascades into exam_marks, the guard saw a published exam, and
-- offboarding failed with a check violation.
--
-- It did not fail every time, which is worse. institutions cascades into both
-- exams and exam_marks; when the exams rows went first the guard looked up an
-- exam that was already gone, found no publication date, and allowed the
-- delete. So whether a tenant could be removed depended on the order Postgres
-- happened to run two foreign keys in.
--
-- Same exemption every other append-only guard in the product uses: the rule is
-- against a hand on the table, not against the database tidying up after
-- itself. A cascade runs at trigger depth greater than one; a DELETE somebody
-- typed does not.

CREATE OR REPLACE FUNCTION exam_marks_no_delete_published() RETURNS trigger AS $$
DECLARE
  published timestamptz;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  SELECT e.published_at INTO published FROM exams e WHERE e.id = OLD.exam_id;
  IF published IS NOT NULL THEN
    RAISE EXCEPTION 'a published mark cannot be deleted; revise it instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

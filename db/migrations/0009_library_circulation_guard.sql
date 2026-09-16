-- A copy's status and its loan history cannot disagree.
--
-- library_copies.status is denormalised: the desk asks "is this on the shelf"
-- constantly and should not derive it from an open-ended loan table each time.
-- Denormalised state that the application maintains is denormalised state that
-- drifts, so the database maintains it instead -- issuing and returning move
-- the status, and nothing else is allowed to.
--
-- The partial unique index on (copy_id) where returned_at is null already makes
-- a double issue impossible. These triggers make the *status column* trustworthy
-- on top of that, and refuse to lend what is lost or withdrawn.

CREATE OR REPLACE FUNCTION library_loan_takes_copy() RETURNS trigger AS $$
DECLARE
  current library_copy_status;
BEGIN
  SELECT c.status INTO current FROM library_copies c WHERE c.id = NEW.copy_id
    FOR UPDATE;

  IF current IS NULL THEN
    RAISE EXCEPTION 'loan refers to a copy that does not exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Only an open loan takes the copy off the shelf. Back-filling a historical,
  -- already-returned loan is a data-migration act, not a circulation one.
  IF NEW.returned_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF current <> 'available' THEN
    RAISE EXCEPTION 'that copy is %, so it cannot be issued', current
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE library_copies SET status = 'on_loan' WHERE id = NEW.copy_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER library_loan_takes_copy
  BEFORE INSERT ON "library_loans"
  FOR EACH ROW EXECUTE FUNCTION library_loan_takes_copy();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION library_loan_returns_copy() RETURNS trigger AS $$
BEGIN
  -- A loan is against one physical object for one borrower, decided when it was
  -- issued. Re-pointing it afterwards rewrites who had what, so it takes an
  -- audited reason -- the same mechanism as every other correction here. The
  -- ordinary circulation path never touches these columns at all.
  IF NEW.copy_id IS DISTINCT FROM OLD.copy_id
     OR NEW.borrower_id IS DISTINCT FROM OLD.borrower_id
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
  THEN
    IF nullif(current_setting('app.audit_reason', true), '') IS NULL THEN
      RAISE EXCEPTION 'a loan cannot be reassigned to another copy, borrower or date'
        USING ERRCODE = 'check_violation',
              HINT = 'return this loan and issue a new one, or record why';
    END IF;
  END IF;

  -- Returning: the copy goes back on the shelf, unless it came back declared
  -- lost, in which case the status set alongside is the one that stands.
  IF OLD.returned_at IS NULL AND NEW.returned_at IS NOT NULL THEN
    UPDATE library_copies
       SET status = 'available'
     WHERE id = NEW.copy_id AND status = 'on_loan';
    RETURN NEW;
  END IF;

  -- Un-returning is a correction, and a correction has a reason. Same mechanism
  -- as published marks and reconciled payments.
  IF OLD.returned_at IS NOT NULL AND NEW.returned_at IS NULL THEN
    IF nullif(current_setting('app.audit_reason', true), '') IS NULL THEN
      RAISE EXCEPTION 'reopening a returned loan requires an audited reason'
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE library_copies
       SET status = 'on_loan'
     WHERE id = NEW.copy_id AND status = 'available';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER library_loan_returns_copy
  BEFORE UPDATE ON "library_loans"
  FOR EACH ROW EXECUTE FUNCTION library_loan_returns_copy();
--> statement-breakpoint

-- Forgiving a fine is discretionary, so it states why. The column is nullable
-- for the ordinary case of no waiver at all; the guard is on the act of waiving.
CREATE OR REPLACE FUNCTION library_fine_waiver_reasoned() RETURNS trigger AS $$
BEGIN
  IF NEW.fine_waived_paise > coalesce(OLD.fine_waived_paise, 0) THEN
    IF nullif(current_setting('app.audit_reason', true), '') IS NULL THEN
      RAISE EXCEPTION 'waiving a library fine requires an audited reason'
        USING ERRCODE = 'check_violation',
              HINT = 'call audit() in the same transaction, supplying a reason';
    END IF;
    IF NEW.fine_waiver_reason IS NULL
       OR length(trim(NEW.fine_waiver_reason)) < 5
    THEN
      RAISE EXCEPTION 'a fine waiver must record its reason on the loan'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER library_fine_waiver_reasoned
  BEFORE INSERT OR UPDATE ON "library_loans"
  FOR EACH ROW EXECUTE FUNCTION library_fine_waiver_reasoned();
--> statement-breakpoint

-- Withdrawing or writing off a copy that somebody is holding would silently
-- close their loan. The loan has to be dealt with first.
CREATE OR REPLACE FUNCTION library_copy_status_honest() RETURNS trigger AS $$
DECLARE
  open_loans int;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO open_loans
    FROM library_loans l
   WHERE l.copy_id = NEW.id AND l.returned_at IS NULL;

  -- The triggers above own the available <-> on_loan transitions, and they run
  -- at depth > 1. A person changing it by hand does not.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'on_loan' AND open_loans = 0 THEN
    RAISE EXCEPTION 'a copy is on loan only because a loan says so'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IN ('lost', 'withdrawn') AND open_loans > 0 THEN
    RAISE EXCEPTION 'that copy is out on loan; close the loan before marking it %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'available' AND open_loans > 0 THEN
    RAISE EXCEPTION 'that copy is out on loan and cannot be shelved'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER library_copy_status_honest
  BEFORE UPDATE ON "library_copies"
  FOR EACH ROW EXECUTE FUNCTION library_copy_status_honest();

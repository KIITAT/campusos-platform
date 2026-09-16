-- Split from the monorepo history (0013_hr_payroll_guard.sql) when modules became
-- installable plugins. Applied by the host at install time, in this order.

-- A payslip is a document of record, and two approvals cannot disagree about a
-- day off.
--
-- Same mechanism as every other correction in this codebase: app.audit_reason
-- set transaction-locally by audit(), and the trigger refuses the write without
-- it. What is new here is that the guard covers a *generated* document, whose
-- inputs it deliberately does not follow -- the payslip's line snapshot is the
-- record, not the component rows behind it.

-- Overlapping approved leave for one person would make two answers true about
-- the same day, and payroll reads those days. Only approved rows participate,
-- because a pending request that overlaps is an ordinary thing to receive and
-- reject.
ALTER TABLE "hr_leave_requests"
  ADD CONSTRAINT hr_leave_requests_no_overlap
  EXCLUDE USING gist (
    staff_id WITH =,
    daterange(from_on, to_on, '[]') WITH &&
  ) WHERE (status = 'approved');
--> statement-breakpoint

-- Two pay components with the same code cannot both be in force: "which HRA
-- applied in August" must have one answer.
ALTER TABLE "hr_pay_components"
  ADD CONSTRAINT hr_pay_components_no_overlap
  EXCLUDE USING gist (
    staff_id WITH =,
    code WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );
--> statement-breakpoint

-- A payslip does not change. If the figures were wrong, the correction is an
-- adjustment on the next one or a reissue that says why -- never a quiet edit
-- to a document somebody has already been handed and may have banked against.
CREATE OR REPLACE FUNCTION hr_payslip_immutable() RETURNS trigger AS $$
BEGIN
  IF nullif(current_setting('app.audit_reason', true), '') IS NULL THEN
    RAISE EXCEPTION 'a payslip cannot be altered without an audited reason'
      USING ERRCODE = 'check_violation',
            HINT = 'issue an adjustment on the next payslip, or reissue with a reason';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_payslip_immutable
  BEFORE UPDATE ON "hr_payslips"
  FOR EACH ROW EXECUTE FUNCTION hr_payslip_immutable();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION hr_payslip_no_delete() RETURNS trigger AS $$
BEGIN
  -- A cascade is not a deletion of the record; offboarding a tenant removes
  -- everything, which is the point. Depth > 1 means another trigger issued it.
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  IF nullif(current_setting('app.audit_reason', true), '') IS NULL THEN
    RAISE EXCEPTION 'a payslip cannot be deleted without an audited reason'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_payslip_no_delete
  BEFORE DELETE ON "hr_payslips"
  FOR EACH ROW EXECUTE FUNCTION hr_payslip_no_delete();
--> statement-breakpoint

-- Leave decisions are one-way. Re-approving something already rejected, or
-- quietly flipping an approval back to pending, rewrites what the person was
-- told -- and, once payroll has run on it, what they were paid.
CREATE OR REPLACE FUNCTION hr_leave_decision_final() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'pending' THEN
    RETURN NEW;
  END IF;

  -- Cancelling an approved future leave is ordinary and stays allowed.
  IF OLD.status = 'approved' AND NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND nullif(current_setting('app.audit_reason', true), '') IS NULL
  THEN
    RAISE EXCEPTION 'a decided leave request cannot be reopened without an audited reason'
      USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW.from_on IS DISTINCT FROM OLD.from_on OR NEW.to_on IS DISTINCT FROM OLD.to_on)
     AND nullif(current_setting('app.audit_reason', true), '') IS NULL
  THEN
    RAISE EXCEPTION 'the dates of a decided leave request cannot be moved'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_leave_decision_final
  BEFORE UPDATE ON "hr_leave_requests"
  FOR EACH ROW EXECUTE FUNCTION hr_leave_decision_final();
--> statement-breakpoint

-- Leave belongs to somebody employed on those dates. Approving leave that
-- starts after a leaving date is how a payroll ends up paying a former
-- employee.
CREATE OR REPLACE FUNCTION hr_leave_within_employment() RETURNS trigger AS $$
DECLARE
  joined date;
  left_on date;
BEGIN
  SELECT s.joined_on, s.left_on INTO joined, left_on
    FROM hr_staff s WHERE s.id = NEW.staff_id;

  IF joined IS NULL THEN
    RAISE EXCEPTION 'leave refers to a staff record that does not exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.from_on < joined THEN
    RAISE EXCEPTION 'leave cannot start before the joining date of %', joined
      USING ERRCODE = 'check_violation';
  END IF;

  IF left_on IS NOT NULL AND NEW.to_on > left_on THEN
    RAISE EXCEPTION 'leave cannot run past the leaving date of %', left_on
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_leave_within_employment
  BEFORE INSERT OR UPDATE ON "hr_leave_requests"
  FOR EACH ROW EXECUTE FUNCTION hr_leave_within_employment();

-- P1-03e (ACC-27, decisions 585, 586): how a fine was settled, and a settled
-- fine cannot be waived afterwards.
--
-- Pre-flight: none needed. The backfill gives a method only to settled loans
-- that took money, so both new checks hold for every existing row.
--
-- Rollback:
--   ALTER TABLE library_loans DROP CONSTRAINT library_loans_settled_by,
--     DROP CONSTRAINT library_loans_settled_by_paid;
--   ALTER TABLE library_loans DROP COLUMN fine_settled_by;
--   then re-run the CREATE OR REPLACE FUNCTION library_fine_waiver_reasoned()
--   from 0001_library_circulation_guard.sql.
ALTER TABLE "library_loans" ADD COLUMN "fine_settled_by" text;
--> statement-breakpoint
-- What was posted: every settlement before this migration debited cash.
UPDATE "library_loans" SET "fine_settled_by" = 'cash'
 WHERE "fine_paid_at" IS NOT NULL AND "fine_paise" > "fine_waived_paise";
--> statement-breakpoint
ALTER TABLE "library_loans"
  ADD CONSTRAINT "library_loans_settled_by" CHECK (fine_settled_by is null or fine_settled_by in ('cash', 'upi', 'bank_transfer', 'fee_account')),
  ADD CONSTRAINT "library_loans_settled_by_paid" CHECK (fine_settled_by is null or fine_paid_at is not null);
--> statement-breakpoint
-- As 0001, plus: once a fine is settled its waiver is fixed. Waiving money
-- already banked would leave the loan and the books disagreeing.
CREATE OR REPLACE FUNCTION library_fine_waiver_reasoned() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.fine_waived_paise IS DISTINCT FROM OLD.fine_waived_paise
     AND OLD.fine_paid_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'that fine is settled; it cannot be waived now'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'library_fine_settled';
  END IF;
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
